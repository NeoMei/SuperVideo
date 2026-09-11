import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,dirname,posix} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parse} from '@babel/parser';
import {componentSettings,componentError} from './components-schema.mjs';
import {verifiedAssetPath,sha256} from '../providers/assets.mjs';
import {runProcess} from '../providers/process.mjs';
import {lessonSettings} from '../modes/lesson.mjs';
export async function verifiedComponentPath(root, asset) {
 try { return await verifiedAssetPath(root, asset); }
 catch (e) { if (['ASSET_HASH_MISMATCH', 'INVALID_ASSET_PATH', 'ENOENT'].includes(e.code)) throw componentError(`Component source missing, changed or escapes project: ${asset.path}; host review required`); throw e; }
}
function validateImports(code,file,descriptor){
 const ast=parse(code,{sourceType:'module',plugins:['jsx','typescript']});
 const visit=n=>{if(!n||typeof n!=='object')return;
  if(n.type==='ImportExpression'||n.type==='Import'||(n.type==='CallExpression'&&['require','eval','Function'].includes(n.callee?.name))||(n.type==='NewExpression'&&n.callee?.name==='Function'))throw componentError('Dynamic imports/evaluation are not registered dependencies');
  if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(n.type)&&n.source){
   const spec=n.source.value;
   if(file===descriptor.model)throw componentError('Invariant model must be self-contained without imports');
   if(!['react','remotion'].includes(spec)){
    const target=posix.normalize(posix.join(posix.dirname(file),spec));
    if(!spec.startsWith('./')||!descriptor.files.some(f=>f.path===target))throw componentError('Import must resolve to an explicitly registered relative component file');
   }
  }
  for(const [key,value]of Object.entries(n))if(key!=='loc')if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);
 };visit(ast);
}
/** Review authorizes trusted local source; validation is a dependency boundary, not a JS sandbox. */
export async function freezeComponents(root,project,destination){
 const descriptors=componentSettings(project),checks=[];await mkdir(destination,{recursive:true});
 const imports=[],registry=[];
 const lesson=project.mode==='lesson'&&descriptors.length?lessonSettings(project):null;
 for(const [index,d]of descriptors.entries()){
  const dir=join(destination,d.id);await mkdir(dir,{recursive:true});
  // Validate and freeze EVERY file before any model code runs.
  for(const f of d.files){const asset=project.assets.find(a=>a.id===f.assetId);const bytes=await readFile(await verifiedComponentPath(root,asset));validateImports(bytes.toString('utf8'),f.path,d);const out=join(dir,f.path);await mkdir(dirname(out),{recursive:true});await writeFile(out,bytes);if(sha256(await readFile(out))!==asset.sha256)throw componentError('Source changed during freeze');}
  const selected=project.scenes.filter(s=>s.visual.component===d.id);
  const jobs=selected.flatMap(s=>(lesson?.invariants.filter(i=>i.component===d.id)??d.checks.map(check=>({check}))).map(i=>({sceneId:s.id,check:i.check,props:s.visual.props.model??{}})));
  const script=`import {readFileSync} from 'node:fs';const data=JSON.parse(readFileSync(0,'utf8'));const m=await import(data.url);if(typeof m.modelAt!=='function')throw Error('modelAt export required');const results=[];for(const j of data.jobs){if(typeof m[j.check]!=='function'||await m[j.check](j.props)!==true)throw Error('Invariant failed: '+j.check);results.push(j);}process.stdout.write(JSON.stringify(results));`;
  const result=await runProcess(process.execPath,['--input-type=module','-e',script],{input:JSON.stringify({url:pathToFileURL(join(dir,d.model)).href,jobs}),timeoutMs:10000});
  if(result.code!==0)throw Object.assign(new Error(result.timedOut?'Component checks timed out':result.stderr.slice(-1200)),{code:'LESSON_INVARIANT_FAILED'});
  for(const j of JSON.parse(result.stdout))checks.push({name:`${d.id}.${j.check}`,passed:true,evidence:JSON.stringify({sceneId:j.sceneId,sourceDigest:d.review.digest,props:j.props})});
  imports.push(`import Component${index} from ${JSON.stringify(join(dir,d.entry))};`);registry.push(`${JSON.stringify(d.id)}:Component${index}`);
 }
 const entry=join(destination,'index.tsx'),rootEntry=fileURLToPath(new URL('./Root.tsx',import.meta.url));
 await writeFile(entry,`import React from 'react';import {registerRoot} from 'remotion';import {Root} from ${JSON.stringify(rootEntry)};\n${imports.join('\n')}\nconst components={${registry.join(',')}};registerRoot(()=> <Root components={components}/>);`);
 return {entry,checks,descriptors};
}
