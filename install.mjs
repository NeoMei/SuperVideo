#!/usr/bin/env node
import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,readFile,readdir,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,parse,posix,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const bundleRoot=dirname(fileURLToPath(import.meta.url));
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const failure=(code,detail)=>Object.assign(new Error(detail),{code});

function safeRelativePath(value){
  return typeof value==='string'&&value.length>0&&!value.includes('\\')&&!isAbsolute(value)&&
    posix.normalize(value)===value&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');
}
async function statOrNull(path){try{return await lstat(path);}catch(error){if(error?.code==='ENOENT')return null;throw error;}}
async function rejectSymlinkComponents(target,name){
  const absolute=resolve(target),root=parse(absolute).root;
  let current=root;
  for(const component of relative(root,absolute).split(sep).filter(Boolean)){
    current=join(current,component);
    const stat=await statOrNull(current);
    if(!stat)return;
    if(stat.isSymbolicLink())throw failure('INSTALL_CONFLICT',name+' destination path contains a symbolic link');
  }
}
async function confinedFile(root,path){
  if(!safeRelativePath(path))throw failure('BUNDLE_INVALID','A manifest path is unsafe');
  let actualRoot,requested,actual,stat,requestedStat;
  try{
    actualRoot=await realpath(root);requested=join(actualRoot,...path.split('/'));
    requestedStat=await lstat(requested);actual=await realpath(requested);stat=await lstat(actual);
  }catch{throw failure('BUNDLE_INVALID','A manifest file is missing');}
  const rel=relative(actualRoot,actual);
  if(requestedStat.isSymbolicLink())throw failure('BUNDLE_INVALID','A manifest file cannot be a symbolic link');
  if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)||!stat.isFile())throw failure('BUNDLE_INVALID','A manifest file escapes its root');
  return actual;
}
async function readManifest(root,name){
  const path=await confinedFile(root,name),bytes=await readFile(path);
  let value;
  try{value=JSON.parse(bytes);}catch{throw failure('BUNDLE_INVALID','A distribution manifest is malformed');}
  if(value?.schemaVersion!==1||!Array.isArray(value.files))throw failure('BUNDLE_INVALID','A distribution manifest is unsupported');
  const seen=new Set();
  for(const file of value.files){
    if(!file||!safeRelativePath(file.path)||seen.has(file.path)||!Number.isSafeInteger(file.size)||file.size<0||
      !/^[0-9a-f]{64}$/.test(file.sha256))throw failure('BUNDLE_INVALID','A distribution manifest record is invalid');
    seen.add(file.path);
  }
  return {path,bytes,value};
}
async function verifyFiles(root,manifest,code='BUNDLE_INVALID'){
  for(const file of manifest.files){
    let actual,bytes;
    try{actual=await confinedFile(root,file.path);bytes=await readFile(actual);}catch{throw failure(code,'Installed files do not match the distribution');}
    if(bytes.length!==file.size||sha256(bytes)!==file.sha256)throw failure(code,'Installed files do not match the distribution');
  }
}
async function copyTree(source,target){
  await mkdir(target);
  for(const entry of await readdir(source,{withFileTypes:true})){
    if(entry.isSymbolicLink())throw failure('BUNDLE_INVALID','Distribution source contains a symbolic link');
    const from=join(source,entry.name),to=join(target,entry.name);
    if(entry.isDirectory())await copyTree(from,to);
    else if(entry.isFile())await writeFile(to,await readFile(from),{flag:'wx'});
    else throw failure('BUNDLE_INVALID','Distribution source contains an unsupported file');
  }
}
async function destinationState(target,sourceManifest,name){
  const stat=await statOrNull(target);
  if(!stat)return 'install';
  if(stat.isSymbolicLink()||!stat.isDirectory())throw failure('INSTALL_CONFLICT',name+' destination already exists and is not the same distribution');
  try{
    const installed=await readManifest(target,name+'-manifest.json');
    if(sha256(installed.bytes)!==sha256(sourceManifest.bytes))throw new Error('different manifest');
    await verifyFiles(target,sourceManifest.value,'INSTALL_CONFLICT');
    return 'reused';
  }catch{throw failure('INSTALL_CONFLICT',name+' destination already exists with different bytes');}
}
function parseArguments(argv){
  const values={};
  for(let index=0;index<argv.length;index+=2){
    const flag=argv[index],value=argv[index+1];
    if(!['--skill-dir','--engine-dir'].includes(flag)||!value||values[flag])throw failure('INVALID_ARGUMENT','Use --skill-dir <directory> --engine-dir <directory>');
    values[flag]=value;
  }
  if(argv.length!==4||!values['--skill-dir']||!values['--engine-dir'])throw failure('INVALID_ARGUMENT','Use --skill-dir <directory> --engine-dir <directory>');
  const skillDir=resolve(values['--skill-dir']),engineDir=resolve(values['--engine-dir']);
  const skillRel=relative(skillDir,engineDir),engineRel=relative(engineDir,skillDir);
  if(!skillRel||(!skillRel.startsWith('..'+sep)&&!isAbsolute(skillRel))||(!engineRel.startsWith('..'+sep)&&!isAbsolute(engineRel)))
    throw failure('INVALID_ARGUMENT','Skill and engine destinations must be separate directories');
  return {skillDir,engineDir};
}

export async function installLite(argv){
  let stages=[],created=[];
  try{
    const {skillDir,engineDir}=parseArguments(argv);
    const bundle=await readManifest(bundleRoot,'bundle-manifest.json');
    await verifyFiles(bundleRoot,bundle.value);
    const skillSource=join(bundleRoot,'supervideo'),engineSource=join(bundleRoot,'engine');
    const skillManifest=await readManifest(skillSource,'skill-manifest.json');
    const engineManifest=await readManifest(engineSource,'engine-manifest.json');
    await verifyFiles(skillSource,skillManifest.value);await verifyFiles(engineSource,engineManifest.value);
    await rejectSymlinkComponents(skillDir,'skill');await rejectSymlinkComponents(engineDir,'engine');
    const skillAction=await destinationState(skillDir,skillManifest,'skill');
    const engineAction=await destinationState(engineDir,engineManifest,'engine');
    for(const item of [{name:'engine',source:engineSource,target:engineDir,action:engineAction},{name:'skill',source:skillSource,target:skillDir,action:skillAction}]){
      if(item.action==='reused')continue;
      await mkdir(dirname(item.target),{recursive:true});
      await rejectSymlinkComponents(item.target,item.name);
      const stage=join(dirname(item.target),'.supervideo-'+item.name+'-'+randomUUID());
      stages.push(stage);await copyTree(item.source,stage);
      const stagedManifest=await readManifest(stage,item.name+'-manifest.json');
      await verifyFiles(stage,stagedManifest.value);
      await rejectSymlinkComponents(item.target,item.name);
      if(await statOrNull(item.target))throw failure('INSTALL_CONFLICT',item.name+' destination appeared during installation');
      await rename(stage,item.target);stages=stages.filter(path=>path!==stage);created.push(item.target);
    }
    return {
      status:'succeeded',artifacts:[skillDir,engineDir],
      checks:[{name:'skill',passed:true,action:skillAction},{name:'engine',passed:true,action:engineAction},{name:'offline-source',passed:true,action:'installed'}],
      dependencyPreparation:{required:true,executable:'npm',argv:['ci','--prefix',engineDir,'--ignore-scripts'],detail:'The verified source engine is installed. Locked npm dependencies and external runtime capabilities are prepared separately.'}
    };
  }catch(error){
    await Promise.all(stages.map(path=>rm(path,{recursive:true,force:true})));
    await Promise.all(created.reverse().map(path=>rm(path,{recursive:true,force:true})));
    const known=new Set(['INVALID_ARGUMENT','BUNDLE_INVALID','INSTALL_CONFLICT']);
    const code=known.has(error?.code)?error.code:'INSTALL_FAILED';
    return {status:'failed',artifacts:[],checks:[],error:{code,detail:known.has(code)?error.message:'Unable to install the verified offline SuperVideo source bundle'}};
  }
}

let isMain=false;
if(process.argv[1]){
  try{isMain=await realpath(resolve(process.argv[1]))===await realpath(fileURLToPath(import.meta.url));}catch{}
}
if(isMain){
  const receipt=await installLite(process.argv.slice(2));
  console.log(JSON.stringify(receipt));
  process.exitCode=receipt.status==='succeeded'?0:1;
}
