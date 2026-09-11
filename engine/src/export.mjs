import {resolveSourceOriginal} from './inputs/original.mjs';
import {readFile,writeFile,mkdir,mkdtemp,rename,rm,realpath} from 'node:fs/promises';
import {join,dirname,resolve,isAbsolute,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {readProject,withProjectLock} from './core/store.mjs';
import {canonicalHash,assertProject} from './core/model.mjs';
import {isCurrent} from './core/approvals.mjs';
import {inspectOutput,verifySnapshot,failedReceipt} from './quality.mjs';
import {projectMediaPath,sha256,mediaError} from './providers/assets.mjs';
import {renderVideo} from './render/render.mjs';

const runtimeRoot=fileURLToPath(new URL('../',import.meta.url));
// Auditable runtime sources only. No repository scan, credentials, browser or dependencies.
const runtimeFiles=[
 'LICENSE','THIRD_PARTY_NOTICES.md','package.json','package-lock.json','runtime-manifest.json',
 ...['LICENSE','provenance.json','tools/__init__.py','tools/base_tool.py','tools/audio/__init__.py','tools/audio/audio_mixer.py','tools/audio/elevenlabs_tts.py','tools/subtitle/__init__.py','tools/subtitle/subtitle_gen.py'].map(n=>`vendor/openmontage/${n}`),
 ...['render-entry.mjs','provenance.json','NOTICE.md','LICENSE.MIT','REMOTION-LICENSE.md'].map(n=>`vendor/remotion/${n}`),
 ...['OpenMontage-LICENSE','Remotion-LICENSE.md','Remotion-renderer-LICENSE.md'].map(n=>`licenses/${n}`),
 'python/bridge.py','python/openmontage.py','python/documents.py',
 'src/quality.mjs','src/export.mjs','src/review.mjs','src/runtime-cli.mjs',
 ...['approvals','jobs','model','readiness','revise','store'].map(n=>`src/core/${n}.mjs`),
 ...['audio','interaction','music','recording','timeline'].map(n=>`src/media/${n}.mjs`),
 ...['assets','bailian','doctor','documents','openmontage','process','tts'].map(n=>`src/providers/${n}.mjs`),
 ...['documents','index','markdown','original','website'].map(n=>`src/inputs/${n}.mjs`),
 ...['book','lesson','ppt','website'].map(n=>`src/modes/${n}.mjs`),
 ...['bundle','components-schema','project-components','recording-position','render','render-worker','schema'].map(n=>`src/render/${n}.mjs`),
 ...['components','index','Root','Scene','preview'].map(n=>`src/render/${n}.tsx`),
];

/** Shared CLI/reproduction config loader. Values are operational, never persisted. */
export async function loadRuntimeConfig(path=process.env.SUPERVIDEO_RUNTIME_CONFIG){
 if(path===undefined)return {};
 if(typeof path!=='string'||!path)throw mediaError('INVALID_RUNTIME_CONFIG','Runtime config must name a JSON file');
 let value;try{value=JSON.parse(await readFile(resolve(path),'utf8'));}catch{throw mediaError('INVALID_RUNTIME_CONFIG','Runtime config must be a readable JSON object');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw mediaError('INVALID_RUNTIME_CONFIG','Runtime config must be a JSON object');
 const paths=['python','ffmpeg','ffprobe','openmontageRoot','browserExecutable','documentRenderer','pdftoppm','playwrightModule','say'];
 const allowed=[...paths,'fontPaths','timeoutMs','website'];
 if(Object.keys(value).some(k=>!allowed.includes(k)))throw mediaError('INVALID_RUNTIME_CONFIG','Unknown runtime field; settings/credentials are not runtime config');
 for(const key of paths)if(value[key]!==undefined&&(typeof value[key]!=='string'||!isAbsolute(value[key])))throw mediaError('INVALID_RUNTIME_CONFIG',`${key} must be an absolute path`);
 if(value.fontPaths!==undefined&&(!Array.isArray(value.fontPaths)||value.fontPaths.some(p=>typeof p!=='string'||!isAbsolute(p))))throw mediaError('INVALID_RUNTIME_CONFIG','fontPaths must contain absolute paths');
 if(value.timeoutMs!==undefined&&(!Number.isFinite(value.timeoutMs)||value.timeoutMs<=0))throw mediaError('INVALID_RUNTIME_CONFIG','timeoutMs must be positive');
 if(value.website!==undefined){const {websiteOptions}=await import('./inputs/website.mjs');websiteOptions(value);const path=value.website.storageStatePath;if(path!==undefined&&(typeof path!=='string'||!isAbsolute(path)))throw mediaError('INVALID_RUNTIME_CONFIG','storageStatePath must be an external absolute path');}
 return value;
}

/** A packaged entry delegates the existing public renderer, with already-delivered audio. */
export async function reproduceProject(root,{runtime={},concurrency=2}={}){
 const manifest=JSON.parse(await readFile(await projectMediaPath(root,'export-manifest.json'),'utf8'));
 if(manifest.schemaVersion!==1||!Array.isArray(manifest.workflowPaths))throw mediaError('INVALID_EXPORT','Missing reproduction manifest');
 return renderVideo(root,{kind:'full'},{runtime,concurrency,workflowPaths:manifest.workflowPaths});
}

export async function exportProject(root,{destination,includeSources,renderManifestPath}={}, {runtime={}}={}){
 let staging;
 try{
  if(typeof destination!=='string'||!destination||typeof includeSources!=='boolean')throw mediaError('INVALID_EXPORT','destination and includeSources:boolean required');
  const project=await readProject(root);
  rejectPrivateState(project);
  const approved=project.approvals.filter(a=>a.stage==='final'&&a.target&&isCurrent(project,a)&&(!renderManifestPath||a.target.manifestPath===renderManifestPath));
  if(!approved.length)throw mediaError('FINAL_APPROVAL_REQUIRED','Approve an exact current immutable full render before delivery');
  const targets=[...new Map(approved.map(a=>[canonicalHash(a.target),a.target])).values()];
  if(targets.length!==1)throw mediaError('FINAL_APPROVAL_REQUIRED','Multiple approved outputs: explicitly select renderManifestPath');
  const target=targets[0],snapshot=await inspectOutput(root,target.manifestPath,{runtime,target,fontLicense:true});
  if(canonicalHash(await readProject(root))!==snapshot.projectHash||snapshot.projectHash!==canonicalHash(project))throw mediaError('OUTPUT_STALE','Project changed during export selection');
  rejectPrivateState(snapshot.segments);
  const workflowPaths=snapshot.manifest.workflowPaths;
  if(project.settings.preparation?.workflowPaths!==undefined&&canonicalHash(project.settings.preparation.workflowPaths)!==canonicalHash(workflowPaths))throw mediaError('OUTPUT_STALE','Saved workflow selection differs from final output');
  const cover=approved.filter(a=>canonicalHash(a.target)===canonicalHash(target));
  if(!project.scenes.every(s=>cover.some(a=>a.scope.includes(s.id))))throw mediaError('FINAL_APPROVAL_REQUIRED','Final approval must cover the targeted full output');
  await mkdir(resolve(destination),{recursive:true});const destinationRoot=await realpath(resolve(destination));
  staging=await mkdtemp(join(destinationRoot,'.supervideo-export-'));
  const written=new Map(),omissions=[],originals=[],runtimeSnapshots=[];
  const put=async(path,bytes,expected,structuredJson=false)=>{
    if(expected&&sha256(bytes)!==expected)throw mediaError('ASSET_HASH_MISMATCH',`Copy source changed: ${path}`);
    // Inspect structured delivery bytes without altering their approved hashes.
    if(structuredJson||extname(path).toLowerCase()==='.json'){
      let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw mediaError('INVALID_EXPORT','Structured delivery reference must contain valid JSON');}
      rejectPrivateState(value);
    }
    if(written.has(path)){if(written.get(path).sha256!==sha256(bytes))throw mediaError('INVALID_EXPORT',`Conflicting export path: ${path}`);return;}
    if(isAbsolute(path)||path.split(/[\\/]/).includes('..'))throw mediaError('INVALID_ASSET_PATH','Export path escapes destination');
    const file=join(staging,path);await mkdir(dirname(file),{recursive:true});await writeFile(file,bytes,{flag:'wx'});
    const actual=await readFile(await projectMediaPath(staging,path));if(sha256(actual)!==sha256(bytes))throw mediaError('ASSET_HASH_MISMATCH','Copied bytes changed');
    written.set(path,{path,sha256:sha256(actual),size:actual.length});
  };
  for(const f of snapshot.files){
    if(/^(runtime\/|project\.json$|export-manifest\.json$|quality\.json$|script\.md$|sources\.json$|REPRODUCE\.md$)/.test(f.path))throw mediaError('INVALID_EXPORT','Project reference collides with reserved delivery path');
    await put(f.path,await readFile(await projectMediaPath(root,f.path)),f.sha256,f.structuredJson);
  }
  for(const source of project.sources){
    if(!includeSources||source.kind==='url'){omissions.push({sourceId:source.id,original:source.original,reason:source.kind==='url'?'Remote source is provenance only; no external fetch':'Original omitted; derived source nodes and referenced assets retained'});continue;}
    const {path:sourcePath,bytes}=await resolveSourceOriginal(root,source);
    const path=`sources/originals/${source.hash}.${source.kind}`;await put(path,bytes,source.hash);originals.push({sourceId:source.id,path,originalPath:sourcePath,sha256:source.hash});
  }
  const keep=new Set(snapshot.files.map(f=>f.path));
  const copy=assertProject({...structuredClone(project),sources:project.sources.map(source=>{const original=originals.find(o=>o.sourceId===source.id);return original?{...source,archive:{path:original.path,sha256:original.sha256}}:source;}),assets:project.assets.filter(a=>keep.has(a.path)),jobs:[]});
  await put('project.json',Buffer.from(JSON.stringify(copy,null,2)));
  const script=project.scenes.map(s=>`## ${s.id}\n\n${s.sentences.map(line=>line.text).join('\n\n')}`).join('\n\n')+'\n';
  await put('script.md',Buffer.from(script));
  await put('sources.json',Buffer.from(JSON.stringify({sources:copy.sources,originals:originals.map(({originalPath,...o})=>o),omissions},null,2)));
  const quality={status:'succeeded',artifacts:[target.manifestPath],checks:snapshot.checks,humanChecks:['visual-layout','pronunciation','knowledge-accuracy'].map(name=>({name,status:'pending',evidence:'Human judgment is separate from this technical quality report'})),finalApproval:cover};
  await put('quality.json',Buffer.from(JSON.stringify(quality,null,2)));
  for(const path of runtimeFiles){const bytes=await readFile(join(runtimeRoot,path));runtimeSnapshots.push({path,sha256:sha256(bytes)});await put(`runtime/${path}`,bytes);}
  const entry=`import {dirname,resolve} from 'node:path';\nimport {fileURLToPath} from 'node:url';\nimport {loadRuntimeConfig,reproduceProject} from './src/export.mjs';\nconst args=process.argv.slice(2);\nif(args.length&&!(args.length===2&&args[0]==='--runtime'))throw Error('Usage: node runtime/reproduce.mjs [--runtime /absolute/runtime.json]');\nconst root=resolve(dirname(fileURLToPath(import.meta.url)),'..');\nconst receipt=await reproduceProject(root,{runtime:await loadRuntimeConfig(args[1])});\nconsole.log(JSON.stringify(receipt,null,2));\nif(receipt.status!=='succeeded')process.exitCode=1;\n`;
  await put('runtime/reproduce.mjs',Buffer.from(entry));
  const dependencies=JSON.parse(await readFile(join(runtimeRoot,'runtime-manifest.json'),'utf8'));
  const instructions=`# 重新编辑与渲染\n\n本包保留 project.json、源节点、所需派生素材、配音、字幕与受审组件。修改后通过原有审批 API 更新脚本/样片授权。已有配音可直接复现，无需服务调用。技术质量不能代替画面、发音、知识准确性人工验收。\n\n1. 使用 Node.js >=20，在包目录运行 npm ci --prefix runtime --ignore-scripts。锁文件固定 npm 依赖；node_modules 不在交付包内。\n2. 配置 FFmpeg、ffprobe、Chrome、Python。OpenMontage 混音与字幕模块、Remotion 无编辑器渲染入口已随包提供并校验来源，无需另装插件或 clone 上游仓库。此复现路径的混音与 SRT 使用 Python 标准库及 FFmpeg；不需要重新调用 TTS。\n3. 写包外 runtime.json，配置 python、ffmpeg、ffprobe、browserExecutable 的绝对路径；不含密钥、登录态或创意设置。\n4. node runtime/reproduce.mjs --runtime /absolute/runtime.json\n\n输出在本工程新的 renders/<UUID>/；原交付版本保留。字幕/讲稿以 project.json 和当前已验证 audio/segments.json 为准。来源原路径仅为溯源 metadata，复现不读取原文档或访问网页。export-manifest.json 记录原交付文件 SHA256 与所用 workflowPaths；编辑会自然改变对应 SHA。\n`;
  await put('REPRODUCE.md',Buffer.from(instructions));
  // Verify the staged project against the very same target before publishing it.
  await inspectOutput(staging,target.manifestPath,{runtime,target,fontLicense:true});
  const manifest={schemaVersion:1,version:randomUUID(),projectId:project.id,target,workflowPaths,includeSources,omissions,runtime:{node:JSON.parse(await readFile(join(runtimeRoot,'package.json'))).engines.node,dependencies,install:'npm ci --prefix runtime --ignore-scripts',command:'node runtime/reproduce.mjs --runtime /absolute/runtime.json'},files:[...written.values()]};
  await put('export-manifest.json',Buffer.from(JSON.stringify(manifest,null,2)));
  const published=join(destinationRoot,`supervideo-${manifest.version}`);
  await withProjectLock(root,async()=>{
    await verifySnapshot(root,snapshot);
    for(const source of runtimeSnapshots)if(sha256(await readFile(join(runtimeRoot,source.path)))!==source.sha256)throw mediaError('OUTPUT_STALE','Runtime source changed during copy');
    for(const original of originals)if(sha256(await readFile(original.originalPath))!==original.sha256)throw mediaError('OUTPUT_STALE','Original source changed during copy');
    for(const f of written.values()){const bytes=await readFile(await projectMediaPath(staging,f.path));if(bytes.length!==f.size||sha256(bytes)!==f.sha256)throw mediaError('OUTPUT_STALE','Staged delivery changed before publication');}
    await rename(staging,published);staging=undefined;
  });
  return {status:'succeeded',artifacts:[published],checks:[...snapshot.checks,{name:'reference-closure',passed:true,evidence:`${manifest.files.length} SHA256-bound files; sources=${includeSources}`},{name:'atomic-version',passed:true,evidence:manifest.version}]};
 }catch(error){return failedReceipt(error);}
 finally{if(staging)await rm(staging,{recursive:true,force:true});}
}

const privateKeys=new Set(['apikey','accesstoken','refreshtoken','authorization','password','cookies','storagestate','credentials','env']);
const privateQueryKeys=new Set([...privateKeys,'token','signature','sig','awsaccesskeyid','xamzsignature','xamzcredential','xamzsecuritytoken','xgoogsignature','xgoogcredential']);
const keyName=key=>key.replace(/[_-]/g,'').toLowerCase();
function rejectPrivateState(value){
 if(typeof value==='string'){
  // Only recognize URL syntax in metadata/prose; never execute or reinterpret prose as code.
  for(const candidate of value.match(/(?:[a-z][a-z\d+.-]*:)?\/\/[^\s<>"'`]+/gi)??[]){
   let url;try{url=new URL(candidate.replace(/&amp;/gi,'&'),'https://provenance.invalid');}catch{continue;}
   if(url.username||url.password||[...url.searchParams.keys()].some(key=>privateQueryKeys.has(keyName(key))))throw mediaError('EXPORT_PRIVATE_DATA','Credential-bearing URLs must remain outside editable project data');
  }
  return;
 }
 if(!value||typeof value!=='object')return;
 for(const [key,item] of Object.entries(value)){
  if(privateKeys.has(keyName(key)))throw mediaError('EXPORT_PRIVATE_DATA','Credentials or browser state must remain outside editable project data');
  rejectPrivateState(item);
 }
}
