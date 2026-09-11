import {safeBailianFailure} from '../providers/bailian.mjs';
import {randomUUID} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {join,extname} from 'node:path';
import {assertProject,canonicalHash} from './model.mjs';
import {readProject,withProjectLock,atomicWriteFile} from './store.mjs';
import {projectMediaPath,sha256,mediaError} from '../providers/assets.mjs';
import {runProcess} from '../providers/process.mjs';

const kinds=new Set(['audio','tts','render']);
export const jobKey=(kind,inputs,config={})=>canonicalHash({schema:'supervideo-job-v1',kind,inputs,config});
export const speechKey=(sentence,voice,base=false)=>jobKey('tts',{sentenceId:sentence.id,text:sentence.text,voice:voice??{}},{audioRate:base?1:sentence.audioRate??1});
export const audioKey=p=>jobKey('audio',p.scenes.map(s=>({id:s.id,sentences:s.sentences.map(line=>speechKey(line,p.settings.voices?.[line.voiceId]))})));

export function ownerAlive(owner){
 if(!owner||!Number.isInteger(owner.pid)||owner.pid<1||typeof owner.token!=='string'||!owner.token)return true;
 try{process.kill(owner.pid,0);return true;}catch(error){return error.code!=='ESRCH';}
}
export async function mutateJobs(root,change){return withProjectLock(root,async()=>{const p=await readProject(root);await change(p);p.revision++;await atomicWriteFile(join(root,'project.json'),JSON.stringify(assertProject(p),null,2));return p;});}
export async function claimJob(root,spec){
 if(!kinds.has(spec.kind))throw mediaError('UNKNOWN_JOB','Unsupported job kind');
 const owner={pid:process.pid,token:randomUUID()};
 await mutateJobs(root,async p=>{if(await currentJobKey(root,p,spec)!==spec.key)throw mediaError('JOB_STALE','Inputs changed before claiming work');const old=p.jobs.find(j=>j.id===spec.id);if(old?.owner&&ownerAlive(old.owner)||old?.state==='running'&&!old.owner)throw mediaError('JOB_OWNED','A live or unidentifiable process owns this job');
  const next={...spec,state:'running',outputs:[],owner,...(old?.failures?{failures:old.failures}:{})};p.jobs=p.jobs.filter(j=>j.id!==spec.id);p.jobs.push(next);
 });return {...spec,owner};
}
export async function finishJob(root,job,result,verify){
 await mutateJobs(root,async p=>{const current=p.jobs.find(j=>j.id===job.id);if(current?.owner?.token!==job.owner.token||current.key!==job.key||current.state!=='running')throw mediaError('JOB_STALE','Job was superseded');if(verify)await verify(p);
  Object.assign(current,{state:'succeeded',outputs:result.outputFiles.map(f=>f.path),...result});delete current.owner;delete current.error;
 });
}
export async function failJob(root,job,error){await mutateJobs(root,p=>{const current=p.jobs.find(j=>j.id===job.id);if(current?.owner?.token!==job.owner.token)return;const value={code:error.code??'JOB_FAILED',detail:error.message??error.detail??String(error),...(error.providerFailure?{providerFailure:safeBailianFailure(error.providerFailure)}:{})};current.state=['HOST_AUDIO_REQUIRED','COMPONENT_REVIEW_REQUIRED','SCRIPT_APPROVAL_REQUIRED','SAMPLE_APPROVAL_REQUIRED','JOB_OWNED','INCOMPLETE_MEDIA','UNCERTAIN_ACTION'].includes(value.code)?'needs_input':'failed';current.error=value;current.failures=[...(current.failures??[]),value];delete current.owner;});}
export async function outputFiles(root,paths){return Promise.all([...new Set(paths)].map(async path=>{const absolute=await projectMediaPath(root,path),bytes=await readFile(absolute);return {path,sha256:sha256(bytes),size:bytes.length};}));}
export async function verifyOutputs(root,files,runtime={}){
 if(!Array.isArray(files)||!files.length)return false;
 try{for(const file of files){const absolute=await projectMediaPath(root,file.path);if((await stat(absolute)).size!==file.size||sha256(await readFile(absolute))!==file.sha256)return false;
  if(['.wav','.mp3','.aiff','.mp4','.webm','.flac','.m4a'].includes(extname(file.path))){if(!runtime.ffmpeg)return false;const decoded=await runProcess(runtime.ffmpeg,['-v','error','-i',absolute,'-f','null','-'],{timeoutMs:runtime.timeoutMs??120000});if(decoded.code!==0)return false;}
 }return true;}catch{return false;}
}
export async function currentJobKey(root,p,job,verifiedSegments){
 if(job.kind==='audio')return audioKey(p);
 if(job.kind==='tts'){const s=p.scenes.flatMap(s=>s.sentences).find(s=>s.id===job.sentenceId);return s?speechKey(s,p.settings.voices?.[s.voiceId]):null;}
 if(job.kind==='render'){
  const {renderContentKey}=await import('../render/render.mjs');
  const segments=verifiedSegments??JSON.parse(await readFile(join(root,'audio/segments.json')));
  const ids=job.request.kind==='full'?p.scenes.map(s=>s.id):job.sceneIds;
  return jobKey('render',{content:renderContentKey(p,ids),segments,workflowPaths:job.workflowPaths??[]},job.request);
 }return null;
}
export async function invalidateJobs(root,p){const invalid=[];for(const job of p.jobs){if(!kinds.has(job.kind))continue;let key;try{key=await currentJobKey(root,p,job);}catch{key=null;}if(job.key!==key){invalid.push(job.id);job.state='pending';delete job.error;}}return invalid;}

/** Runs only the fixed media pipeline. Website actions are never generic jobs. */
export async function resumeJobs(root,config={}){
 try{
  let p=await readProject(root);for(const j of p.jobs)if(j.owner&&ownerAlive(j.owner)||j.state==='running'&&!j.owner)throw mediaError('JOB_OWNED','A live or unknown process still owns work');
  const {refreshComponentSources}=await import('./revise.mjs');await refreshComponentSources(root);
  p=await mutateJobs(root,async p=>{for(const j of p.jobs){if(j.owner&&ownerAlive(j.owner)||j.state==='running'&&!j.owner)throw mediaError('JOB_OWNED','Work was claimed by another live or unknown owner');if(j.owner){j.failures=[...(j.failures??[]),{code:'PROCESS_EXITED',detail:`Confirmed dead owner ${j.owner.pid}; recovered without replaying external actions`}];delete j.owner;if(j.state==='running')j.state='pending';}}await invalidateJobs(root,p);});
  const {componentSettings}=await import('../render/components-schema.mjs');componentSettings(p);
  if(config.recordingRecovery){const {recoverRecordingMedia}=await import('../media/recording.mjs');const recovered=await recoverRecordingMedia(root,config.recordingRecovery,config.runtime??{});if(recovered.receipt.status!=='succeeded')return recovered.receipt;}
  if(p.jobs.some(j=>['audio','tts'].includes(j.kind))||p.jobs.some(j=>j.kind==='render')){const {prepareAudio}=await import('../media/audio.mjs');await prepareAudio(root,config);}
  p=await readProject(root);const artifacts=[];
  for(const job of p.jobs.filter(j=>j.kind==='render')){const {renderVideo}=await import('../render/render.mjs');const result=await renderVideo(root,job.request,{...config,workflowPaths:job.workflowPaths??[]});if(result.status!=='succeeded')return result;artifacts.push(...result.artifacts);}
  const unsupported=p.jobs.find(j=>!kinds.has(j.kind)&&j.state!=='succeeded');if(unsupported)throw mediaError('UNKNOWN_JOB','Unrecognized job requires explicit host handling; no action replay');
  return {status:'succeeded',artifacts,checks:[{name:'resume',passed:true,evidence:'Verified media caches and current inputs; no website action replay'}]};
 }catch(error){return {status:['JOB_OWNED','COMPONENT_REVIEW_REQUIRED','HOST_AUDIO_REQUIRED','UNKNOWN_JOB'].includes(error.code)?'needs_input':'failed',artifacts:[],checks:[],error:{code:error.code??'RESUME_FAILED',detail:error.message}};}
}
