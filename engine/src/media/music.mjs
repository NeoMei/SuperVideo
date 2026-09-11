import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

import {canonicalHash} from '../core/model.mjs';
import {invalidateJobs} from '../core/jobs.mjs';
import {readProject,saveProject} from '../core/store.mjs';
import {importAsset,mediaError,verifiedAssetPath} from '../providers/assets.mjs';
import {runProcess} from '../providers/process.mjs';

const MAX_MS=24*60*60*1000;
const REQUEST_FIELDS=new Set(['path','assetId','sceneId','startMs','durationMs','sourceStartMs','sourceEndMs','loop','volume','fadeInMs','fadeOutMs','ducking','remove']);
const TRACK_FIELDS=new Set(['assetId','sceneId','startMs','durationMs','sourceStartMs','sourceEndMs','loop','volume','fadeInMs','fadeOutMs']);

/** Audio probing used by music configuration and deterministic stem preparation. */
export async function probePreparedMusic(path,runtime={}) {
 return probeMusic(path,runtime,false);
}

async function probeImportedMusic(path,runtime={}) {
 return probeMusic(path,runtime,true);
}

async function probeMusic(path,runtime,requireAudible) {
 if(!runtime.ffprobe||!runtime.ffmpeg)throw mediaError('DEPENDENCY_MISSING','Configured FFmpeg and ffprobe required');
 const probe=await runProcess(runtime.ffprobe,['-v','error','-show_entries','stream=codec_type,channels,sample_rate,duration:format=duration','-of','json',path],{timeoutMs:runtime.timeoutMs??15000});
 let data;try{data=JSON.parse(probe.stdout);}catch{}
 const stream=data?.streams?.find(item=>item.codec_type==='audio'),durationMs=Number(stream?.duration??data?.format?.duration)*1000;
 if(probe.code!==0||!stream||!Number.isFinite(durationMs)||durationMs<=0||![1,2].includes(stream.channels))throw mediaError('OUTPUT_INVALID','Music must have a positive measured duration and mono/stereo channels');
 const decode=await runProcess(runtime.ffmpeg,['-hide_banner','-nostats','-i',path,'-vn','-af','volumedetect','-f','null','-'],{timeoutMs:runtime.timeoutMs??60000});
 const level=value=>value==='-inf'?-Infinity:Number(value),peakDb=level(decode.stderr.match(/max_volume: (-?(?:inf|[\d.]+)) dB/)?.[1]),meanDb=level(decode.stderr.match(/mean_volume: (-?(?:inf|[\d.]+)) dB/)?.[1]);
 if(decode.code!==0||Number.isNaN(peakDb)||Number.isNaN(meanDb)||requireAudible&&(peakDb<=-80||meanDb<=-80))throw mediaError('OUTPUT_INVALID',requireAudible?'Music must fully decode and contain audible samples':'Prepared music must fully decode');
 return {durationMs,channels:stream.channels,sampleRate:Number(stream.sample_rate),peakDb,meanDb};
}

/**
 * Replaces the selected BGM while preserving SFX, voice settings and prepared
 * narration. Local paths are imported with explicit host provenance.
 */
export async function configureMusic(root,request,{runtime={},expectedRevision}={}) {
 try{
  validateRequest(request);
  const initial=await readProject(root),revision=expectedRevision??initial.revision;
  if(!Number.isInteger(revision)||revision<0)throw mediaError('INVALID_REVISION','expectedRevision must be a nonnegative integer');
  if(initial.revision!==revision)throw mediaError('REVISION_CONFLICT','Project revision changed');
  if(request.remove===true){
   if(!(initial.settings.audio?.music?.length))return success([],`No BGM was configured at revision ${initial.revision}`);
   const next=structuredClone(initial),audio={...(next.settings.audio??{}),music:[]};next.settings={...next.settings,audio};
   const {isCurrent}=await import('../core/approvals.mjs');next.approvals=next.approvals.filter(approval=>isCurrent(next,approval));
   await invalidateJobs(root,next);
   const saved=await saveProject(root,next,revision);return success([],`Removed BGM at revision ${saved.revision}`);
  }

  if(request.sceneId!==undefined&&!initial.scenes.some(scene=>scene.id===request.sceneId))throw mediaError('INVALID_MUSIC_REQUEST','Unknown music scene');
  let asset,path,measured;
  if(request.assetId!==undefined){
   asset=initial.assets.find(item=>item.id===request.assetId&&item.mediaType.startsWith('audio/'));
   if(!asset)throw mediaError('INVALID_MUSIC_REQUEST','Music assetId must resolve to registered audio');
   path=await verifiedAssetPath(root,asset);measured=await probeImportedMusic(path,runtime);
  }else{
   measured=await probeImportedMusic(request.path,runtime);
  }
  const track=normalizeTrack(request,measured.durationMs);
  if(!asset){
   const reference=`Host-selected local BGM: ${resolve(request.path)}`;
   asset=await importAsset(root,{path:request.path,origin:{kind:'host',reference,version:'configure-music-v1'}});
   track.assetId=asset.id;
  }
  const current=await readProject(root);
  if(current.revision!==revision+(asset&&initial.assets.some(item=>item.id===asset.id)?0:1))throw mediaError('REVISION_CONFLICT','Project changed while importing music');
  const next=structuredClone(current),previous=next.settings.audio??{},ducking=request.ducking===undefined?previous.ducking:{...(previous.ducking??{}),enabled:request.ducking};
  next.settings={...next.settings,audio:{...previous,music:[track],...(ducking===undefined?{}:{ducking})}};
  const {audioSettings}=await import('./audio.mjs');audioSettings(next);
  const {isCurrent}=await import('../core/approvals.mjs');next.approvals=next.approvals.filter(approval=>isCurrent(next,approval));
  await invalidateJobs(root,next);
  const saved=await saveProject(root,next,current.revision);
  return {status:'succeeded',artifacts:[asset.path],checks:[{name:'music-configured',passed:true,evidence:JSON.stringify({revision:saved.revision,placement:track.sceneId?`scene:${track.sceneId}`:'whole',assetId:asset.id})},{name:'music-source-audio',passed:true,evidence:JSON.stringify(measured)}]};
 }catch(error){
  return {status:error.code==='DEPENDENCY_MISSING'?'needs_input':'failed',artifacts:[],checks:[],error:{code:error.code??'MUSIC_CONFIGURATION_FAILED',detail:error.message}};
 }
}

/**
 * Writes one full-timeline music stem. The active clip is cropped, optionally
 * looped and faded before placement; volume and ducking remain mixer concerns.
 */
export async function prepareMusicTrack(root,track,timeline,outputPath,{runtime={}}={}) {
 validateTimeline(timeline);
 const project=await readProject(root),asset=project.assets.find(item=>item.id===track?.assetId&&item.mediaType.startsWith('audio/'));
 if(!asset)throw mediaError('INVALID_APPROVAL_SETTINGS','Music asset must resolve to registered audio');
 // User selection is checked by configureMusic; verified projected stems can be silent.
 const source=await verifiedAssetPath(root,asset),measured=await probePreparedMusic(source,runtime),normalized=normalizeStoredTrack(track,measured.durationMs);
 const fullDurationMs=timeline.durationInFrames*1000/timeline.fps,scene=normalized.sceneId===undefined?undefined:timeline.scenes.find(item=>item.id===normalized.sceneId);
 if(normalized.sceneId!==undefined&&!scene)throw mediaError('AUDIO_OUT_OF_BOUNDS','Music scene is absent from the full timeline');
 const startMs=(scene?.startMs??0)+normalized.startMs,boundaryMs=scene?scene.startMs+scene.durationMs:fullDurationMs,availableMs=boundaryMs-startMs;
 if(!(availableMs>0))throw mediaError('AUDIO_OUT_OF_BOUNDS','Music starts beyond its placement scope');
 const clipDurationMs=normalized.sourceEndMs-normalized.sourceStartMs;
 let durationMs=normalized.durationMs??(normalized.loop?availableMs:Math.min(clipDurationMs,availableMs));
 if(durationMs>availableMs+.1||(!normalized.loop&&durationMs>clipDurationMs+.1))throw mediaError('AUDIO_OUT_OF_BOUNDS','Music duration exceeds its scene, film or source clip');
 durationMs=Math.min(durationMs,availableMs);
 if(normalized.fadeInMs+normalized.fadeOutMs>durationMs+.1)throw mediaError('INVALID_APPROVAL_SETTINGS','Music fades exceed the active duration');

 const directory=await mkdtemp(join(tmpdir(),'supervideo-music-'));
 try{
  const crop=join(directory,'crop.wav'),active=join(directory,'active.wav');await mkdir(dirname(outputPath),{recursive:true});
  await ffmpeg(runtime,['-i',source,'-vn','-af',`atrim=start=${seconds(normalized.sourceStartMs)}:end=${seconds(normalized.sourceEndMs)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo`,'-ar','48000','-ac','2','-c:a','pcm_f32le','-y',crop],'Music source crop failed');
  const fades=[];
  if(normalized.fadeInMs)fades.push(`afade=t=in:st=0:d=${seconds(normalized.fadeInMs)}`);
  if(normalized.fadeOutMs)fades.push(`afade=t=out:st=${seconds(durationMs-normalized.fadeOutMs)}:d=${seconds(normalized.fadeOutMs)}`);
  await ffmpeg(runtime,[...(normalized.loop?['-stream_loop','-1']:[]),'-i',crop,'-vn','-t',seconds(durationMs),...(fades.length?['-af',fades.join(',')]:[]),'-ar','48000','-ac','2','-c:a','pcm_f32le','-y',active],'Music loop/fade preparation failed');
  const delaySamples=Math.round(startMs*48);
  await ffmpeg(runtime,['-i',active,'-vn','-af',`adelay=${delaySamples}S:all=1,apad=whole_dur=${seconds(fullDurationMs)},atrim=duration=${seconds(fullDurationMs)},asetpts=PTS-STARTPTS`,'-ar','48000','-ac','2','-c:a','pcm_f32le','-y',outputPath],'Music timeline placement failed');
  const output=await probePreparedMusic(outputPath,runtime);
  if(Math.abs(output.durationMs-fullDurationMs)>2)throw mediaError('OUTPUT_INVALID','Prepared music stem duration differs from the full timeline');
  return {path:outputPath,startMs,durationMs,fullDurationMs,sourceStartMs:normalized.sourceStartMs,sourceEndMs:normalized.sourceEndMs,loop:normalized.loop,measured:output,cacheKey:canonicalHash({assetId:asset.id,sha256:asset.sha256,track:normalized,timeline:{fps:timeline.fps,durationInFrames:timeline.durationInFrames,scenes:timeline.scenes}})};
 }finally{await rm(directory,{recursive:true,force:true});}
}

function validateRequest(request){
 if(!plainObject(request)||Object.keys(request).some(key=>!REQUEST_FIELDS.has(key)))throw mediaError('INVALID_MUSIC_REQUEST','Invalid music request fields');
 if(request.remove===true){if(Object.keys(request).some(key=>key!=='remove'))throw mediaError('INVALID_MUSIC_REQUEST','remove:true cannot be combined with music fields');return;}
 if(request.remove!==undefined)throw mediaError('INVALID_MUSIC_REQUEST','remove must be true when supplied');
 if((typeof request.path==='string'&&request.path.length>0)===(typeof request.assetId==='string'&&request.assetId.length>0))throw mediaError('INVALID_MUSIC_REQUEST','Provide exactly one music path or assetId');
 if(request.sceneId!==undefined&&(typeof request.sceneId!=='string'||!request.sceneId))throw mediaError('INVALID_MUSIC_REQUEST','sceneId must be nonempty');
 number(request.startMs,'startMs',0,MAX_MS);number(request.durationMs,'durationMs',.001,MAX_MS);number(request.sourceStartMs,'sourceStartMs',0,MAX_MS);number(request.sourceEndMs,'sourceEndMs',.001,MAX_MS);
 number(request.volume,'volume',0,2);number(request.fadeInMs,'fadeInMs',0,MAX_MS);number(request.fadeOutMs,'fadeOutMs',0,MAX_MS);
 if(request.loop!==undefined&&typeof request.loop!=='boolean')throw mediaError('INVALID_MUSIC_REQUEST','loop must be boolean');
 if(request.ducking!==undefined&&typeof request.ducking!=='boolean')throw mediaError('INVALID_MUSIC_REQUEST','ducking must be boolean');
}

function normalizeTrack(request,sourceDurationMs){
 const sourceStartMs=request.sourceStartMs??0,sourceEndMs=request.sourceEndMs??sourceDurationMs;
 if(sourceEndMs<=sourceStartMs||sourceEndMs>sourceDurationMs+.1)throw mediaError('AUDIO_OUT_OF_BOUNDS','Music source clip exceeds measured audio');
 const loop=request.loop??false,durationMs=request.durationMs,clipDurationMs=sourceEndMs-sourceStartMs,fadeInMs=request.fadeInMs??0,fadeOutMs=request.fadeOutMs??0;
 if(durationMs!==undefined&&!loop&&durationMs>clipDurationMs+.1)throw mediaError('AUDIO_OUT_OF_BOUNDS','Non-looping music duration exceeds its source clip');
 if(durationMs!==undefined&&fadeInMs+fadeOutMs>durationMs+.1)throw mediaError('INVALID_MUSIC_REQUEST','Music fades exceed duration');
 if(durationMs===undefined&&!loop&&fadeInMs+fadeOutMs>clipDurationMs+.1)throw mediaError('INVALID_MUSIC_REQUEST','Music fades exceed source clip');
 return {assetId:request.assetId,...(request.sceneId===undefined?{}:{sceneId:request.sceneId}),startMs:request.startMs??0,...(durationMs===undefined?{}:{durationMs}),sourceStartMs,sourceEndMs,loop,volume:request.volume??.2,fadeInMs,fadeOutMs};
}

function normalizeStoredTrack(track,sourceDurationMs){
 if(!plainObject(track)||Object.keys(track).some(key=>!TRACK_FIELDS.has(key))||typeof track.assetId!=='string'||!track.assetId)throw mediaError('INVALID_APPROVAL_SETTINGS','Invalid music track');
 if(track.sceneId!==undefined&&(typeof track.sceneId!=='string'||!track.sceneId))throw mediaError('INVALID_APPROVAL_SETTINGS','Invalid music scene');
 for(const [key,min,max]of[['startMs',0,MAX_MS],['durationMs',.001,MAX_MS],['sourceStartMs',0,MAX_MS],['sourceEndMs',.001,MAX_MS],['volume',0,2],['fadeInMs',0,MAX_MS],['fadeOutMs',0,MAX_MS]])storedNumber(track[key],key,min,max);
 if(track.loop!==undefined&&typeof track.loop!=='boolean')throw mediaError('INVALID_APPROVAL_SETTINGS','Invalid music loop');
 const normalized=normalizeTrack(track,sourceDurationMs);normalized.assetId=track.assetId;return normalized;
}

function validateTimeline(timeline){
 if(!plainObject(timeline)||!Number.isFinite(timeline.fps)||timeline.fps<=0||!Number.isInteger(timeline.durationInFrames)||timeline.durationInFrames<=0||!Array.isArray(timeline.scenes))throw mediaError('INVALID_TIMELINE','Full measured timeline required for music preparation');
 for(const scene of timeline.scenes)if(!plainObject(scene)||typeof scene.id!=='string'||!Number.isFinite(scene.startMs)||scene.startMs<0||!Number.isFinite(scene.durationMs)||scene.durationMs<=0)throw mediaError('INVALID_TIMELINE','Timeline scene placement is invalid');
}
function number(value,name,min,max){if(value!==undefined&&(!Number.isFinite(value)||value<min||value>max))throw mediaError('INVALID_MUSIC_REQUEST',`${name} is out of bounds`);}
function storedNumber(value,name,min,max){if(value!==undefined&&(!Number.isFinite(value)||value<min||value>max))throw mediaError('INVALID_APPROVAL_SETTINGS',`Invalid music ${name}`);}
function plainObject(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;}
function seconds(ms){return (ms/1000).toFixed(6);}
async function ffmpeg(runtime,args,detail){
 if(!runtime.ffmpeg)throw mediaError('DEPENDENCY_MISSING','Configured FFmpeg required');
 const result=await runProcess(runtime.ffmpeg,['-v','error',...args],{timeoutMs:runtime.timeoutMs??60000});
 if(result.timedOut)throw mediaError('PROVIDER_TIMEOUT','Music preparation timed out');if(result.code!==0)throw mediaError('OUTPUT_INVALID',`${detail}: ${result.stderr.trim()}`);
}
function success(artifacts,evidence){return {status:'succeeded',artifacts,checks:[{name:'music-configured',passed:true,evidence}]};}
