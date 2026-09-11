#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,join,posix,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const launcher=fileURLToPath(import.meta.url);
const skillRoot=resolve(dirname(launcher),'..');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(code,detail)=>Object.assign(new Error(detail),{code});

function safeRelativePath(value){
  if(typeof value!=='string'||!value||value.includes('\\')||isAbsolute(value)||posix.normalize(value)!==value)return false;
  return value.split('/').every(part=>part&&part!=='.'&&part!=='..');
}

async function regularConfinedFile(root,path){
  if(!safeRelativePath(path))throw fail('ENGINE_INTEGRITY_FAILED','Engine manifest contains an unsafe path');
  let actual,stat;
  try{actual=await realpath(join(root,...path.split('/')));stat=await lstat(actual);}catch{throw fail('ENGINE_INTEGRITY_FAILED','Engine manifest file is missing');}
  const rel=relative(root,actual);
  if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)||!stat.isFile())throw fail('ENGINE_INTEGRITY_FAILED','Engine manifest path escapes the engine');
  return actual;
}

async function loadLock(){
  try{
    const lock=JSON.parse(await readFile(join(skillRoot,'runtime.lock.json'),'utf8'));
    if(lock?.schemaVersion!==1||lock?.protocolVersion!==1||typeof lock.engineVersion!=='string'||
      !safeRelativePath(lock.engineManifest)||!/^[0-9a-f]{64}$/.test(lock.engineManifestSha256))
      throw fail('LOCK_INVALID','runtime.lock.json is malformed or unsupported');
    return lock;
  }catch(error){
    if(error?.code==='ENOENT')return null;
    if(error?.code)return Promise.reject(error);
    throw fail('LOCK_INVALID','runtime.lock.json is malformed or unsupported');
  }
}

async function verifyEngine(candidate,lock){
  let root;
  try{root=await realpath(resolve(candidate));}catch(error){
    if(error?.code==='ENOENT')return null;
    throw fail('ENGINE_INTEGRITY_FAILED','Engine root cannot be inspected');
  }
  const manifestPath=await regularConfinedFile(root,lock.engineManifest);
  const manifestBytes=await readFile(manifestPath);
  if(sha256(manifestBytes)!==lock.engineManifestSha256)throw fail('ENGINE_INTEGRITY_FAILED','Engine manifest does not match runtime.lock.json');
  let manifest;
  try{manifest=JSON.parse(manifestBytes);}catch{throw fail('ENGINE_INTEGRITY_FAILED','Engine manifest is not valid JSON');}
  if(manifest?.schemaVersion!==1||manifest?.protocolVersion!==lock.protocolVersion||
    manifest?.package!=='supervideo-engine'||manifest?.version!==lock.engineVersion||!Array.isArray(manifest.files))
    throw fail('ENGINE_INTEGRITY_FAILED','Engine manifest metadata does not match runtime.lock.json');
  const seen=new Set();
  for(const file of manifest.files){
    if(!file||!safeRelativePath(file.path)||seen.has(file.path)||!Number.isSafeInteger(file.size)||file.size<0||
      !/^[0-9a-f]{64}$/.test(file.sha256))throw fail('ENGINE_INTEGRITY_FAILED','Engine manifest contains an invalid file record');
    seen.add(file.path);
    const actual=await regularConfinedFile(root,file.path),bytes=await readFile(actual);
    if(bytes.length!==file.size||sha256(bytes)!==file.sha256)throw fail('ENGINE_INTEGRITY_FAILED','Engine file bytes do not match the pinned manifest');
  }
  if(!seen.has('src/runtime-cli.mjs'))throw fail('ENGINE_INTEGRITY_FAILED','Engine manifest does not contain the runtime entrypoint');
  return {root,entry:join(root,'src/runtime-cli.mjs')};
}

async function sourceCheckout(){
  const root=resolve(skillRoot,'../..');
  try{
    const metadata=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
    const files=await Promise.all(['src/runtime-cli.mjs','src/cli.mjs','scripts/pack.mjs'].map(path=>regularConfinedFile(root,path)));
    if(metadata?.name!=='supervideo')return null;
    return {root,entry:files[0]};
  }catch{return null;}
}

async function resolveEngine(lock){
  if(!lock){
    const development=await sourceCheckout();
    if(development)return development;
    throw fail('ENGINE_NOT_FOUND','No runtime lock or complete SuperVideo source checkout was found');
  }
  const explicit=process.env.SUPERVIDEO_ENGINE_ROOT?.trim();
  if(explicit){
    const selected=await verifyEngine(explicit,lock);
    if(!selected)throw fail('ENGINE_NOT_FOUND','SUPERVIDEO_ENGINE_ROOT does not contain the pinned engine');
    return selected;
  }
  const candidates=[resolve(skillRoot,'../engine')];
  const explicitCache=process.env.SUPERVIDEO_ENGINE_CACHE?.trim();
  if(explicitCache){
    const cacheRoot=resolve(explicitCache);
    candidates.push(resolve(cacheRoot,lock.engineManifestSha256));
    // A cache container is not itself an engine. Only inspect it directly when it declares a manifest.
    try{await lstat(join(cacheRoot,lock.engineManifest));candidates.push(cacheRoot);}
    catch(error){if(error?.code!=='ENOENT')throw fail('ENGINE_INTEGRITY_FAILED','Explicit engine cache cannot be inspected');}
  }
  const cacheBase=process.env.XDG_CACHE_HOME?.trim()||(process.env.HOME?.trim()?join(process.env.HOME,'.cache'):null);
  if(cacheBase)candidates.push(resolve(cacheBase,'supervideo','engines',lock.engineManifestSha256));
  for(const candidate of [...new Set(candidates)]){
    const selected=await verifyEngine(candidate,lock);
    if(selected)return selected;
  }
  throw fail('ENGINE_NOT_FOUND','The engine pinned by runtime.lock.json is not installed; set SUPERVIDEO_ENGINE_ROOT or install it in the shared cache');
}

try{
  const engine=await resolveEngine(await loadLock());
  const child=spawn(process.execPath,[engine.entry,...process.argv.slice(2)],{stdio:'inherit',shell:false});
  await new Promise((resolveChild,reject)=>{
    const signalHandlers=new Map(['SIGTERM','SIGINT','SIGHUP'].map(signal=>[signal,()=>{
      if(child.exitCode===null&&child.signalCode===null)child.kill(signal);
    }]));
    const cleanup=()=>{for(const [signal,handler] of signalHandlers)process.off(signal,handler);};
    for(const [signal,handler] of signalHandlers)process.on(signal,handler);
    child.once('error',error=>{cleanup();reject(error);});
    child.once('exit',(code,signal)=>{
      cleanup();
      if(signal){process.kill(process.pid,signal);return;}
      process.exitCode=code??1;resolveChild();
    });
  });
}catch(error){
  const known=new Set(['LOCK_INVALID','ENGINE_NOT_FOUND','ENGINE_INTEGRITY_FAILED']);
  const code=known.has(error?.code)?error.code:'LAUNCH_FAILED';
  console.log(JSON.stringify({status:'failed',artifacts:[],checks:[],error:{code,detail:known.has(code)?error.message:'Unable to start the pinned SuperVideo engine'}}));
  process.exitCode=1;
}
