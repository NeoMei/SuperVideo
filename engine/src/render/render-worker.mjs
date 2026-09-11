import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const filename=fileURLToPath(import.meta.url);
const failed=detail=>({status:'failed',artifacts:[],checks:[],error:{code:'RENDER_WORKER_FAILED',detail}});

/** One worker owns the renderer/browser lifecycle; only bounded operational values cross IPC. */
export function runRenderWorker(root,request,config={}){
 const allowed=['python','ffmpeg','ffprobe','openmontageRoot','browserExecutable','timeoutMs'];
 const runtime=Object.fromEntries(allowed.filter(k=>config.runtime?.[k]!==undefined).map(k=>[k,config.runtime[k]]));
 if(Object.entries(runtime).some(([key,value])=>key==='timeoutMs'?!Number.isFinite(value):typeof value!=='string'))return Promise.resolve(failed('Invalid render runtime value'));
 const message={root,request,runtime,workflowPaths:config.workflowPaths??[],concurrency:config.concurrency??2};
 if(typeof root!=='string'||!Array.isArray(message.workflowPaths)||message.workflowPaths.some(p=>typeof p!=='string')||!Number.isInteger(message.concurrency)||message.concurrency<1)return Promise.resolve(failed('Invalid renderer operational configuration'));
 return new Promise(resolve=>{
  const child=fork(filename,[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});let receipt,finished=false;
  const finish=value=>{if(!finished){finished=true;resolve(value);}};
  child.on('message',value=>{if(value?.type==='receipt')receipt=value.receipt;});
  child.on('error',error=>finish(failed(error.message)));
  child.on('exit',(code,signal)=>finish(receipt??failed(`Renderer worker exited before a receipt (${signal??code})`)));
  child.send(message,error=>{if(error){if(child.connected)child.disconnect();finish(failed('Renderer worker input channel failed'));}});
 });
}

// IPC closure is tied to the actual parent connection, never an assumed/reused PID.
async function worker(){
 let parentGone=!process.connected,cancelled=parentGone,active=false,browser,closePromise,cancel=()=>{};
 const closeBrowser=()=>{if(!browser)return Promise.resolve();return closePromise??=browser.close({silent:true});};
 const shutdown=()=>{cancelled=true;cancel();void closeBrowser().catch(()=>{});if(!active)process.exit(0);};
 const check=()=>{if(cancelled)throw Object.assign(new Error('Render owner disconnected or cancelled; publication cancelled'),{code:'RENDER_CANCELLED'});};
 process.once('disconnect',()=>{parentGone=true;shutdown();});
 process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
 process.once('message',async ({root,request,runtime,workflowPaths,concurrency})=>{
  active=true;let receipt;
  try{
   const {makeCancelSignal}=await import('@remotion/renderer');const signals=makeCancelSignal();cancel=signals.cancel;if(cancelled)cancel();
   const {renderUntracked}=await import('./render.mjs');
   receipt=await renderUntracked(root,request,{runtime,workflowPaths,concurrency},{cancelSignal:signals.cancelSignal,check,closeBrowser,onBrowser:async value=>{browser=value;if(cancelled)await closeBrowser();check();}});
  }catch(error){receipt=failed(error.message);}
  finally{try{await closeBrowser();}catch(error){receipt=failed(`Owned browser cleanup failed: ${error.message}`);}}
  if(process.connected&&!parentGone)process.send({type:'receipt',receipt},()=>{if(process.connected)process.disconnect();process.exit(0);});else process.exit(0);
 });
}
if(process.argv[1]===filename&&process.send)void worker();
