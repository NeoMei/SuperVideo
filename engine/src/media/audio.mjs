import {assertModePlan} from '../core/readiness.mjs';
import {assertWebsiteBindings} from '../modes/website.mjs';
import {assertInteraction} from './interaction.mjs';
import {audioKey,claimJob,finishJob,failJob,outputFiles} from '../core/jobs.mjs';
import { mkdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalHash } from '../core/model.mjs';
import { atomicWriteFile, readProject, withProjectLock } from '../core/store.mjs';
import { runProcess } from '../providers/process.mjs';
import { callOpenMontage } from '../providers/openmontage.mjs';
import { synthesize } from '../providers/tts.mjs';
import { importAsset,mediaError,verifiedAssetPath,projectMediaPath } from '../providers/assets.mjs';
import { resolveTimeline, recordingCuts, timelineProjectHash, validateWords } from './timeline.mjs';
import {prepareMusicTrack} from './music.mjs';

export const CAPTION_POLICY='sentence-spans-v1';

export async function probeAudio(path,runtime) {
 if(!runtime.ffprobe||!runtime.ffmpeg)throw mediaError('DEPENDENCY_MISSING','Configured FFmpeg and ffprobe required');
 const probe=await runProcess(runtime.ffprobe,['-v','error','-show_entries','stream=codec_type,channels,sample_rate,duration:format=duration','-of','json',path],{timeoutMs:runtime.timeoutMs??15000});
 let data;try{data=JSON.parse(probe.stdout);}catch{}
 const stream=data?.streams?.find(s=>s.codec_type==='audio'),durationMs=Number(stream?.duration??data?.format?.duration)*1000;
 if(probe.code!==0||!stream||!Number.isFinite(durationMs)||durationMs<=0||![1,2].includes(stream.channels))throw mediaError('OUTPUT_INVALID','Audio must have a positive measured duration and mono/stereo channels');
 const decode=await runProcess(runtime.ffmpeg,['-hide_banner','-nostats','-i',path,'-vn','-af','volumedetect','-f','null','-'],{timeoutMs:runtime.timeoutMs??60000});
 const peakDb=Number(decode.stderr.match(/max_volume: (-?[\d.]+) dB/)?.[1]),meanDb=Number(decode.stderr.match(/mean_volume: (-?[\d.]+) dB/)?.[1]);
 if(decode.code!==0||!Number.isFinite(peakDb)||!Number.isFinite(meanDb)||peakDb<=-80||meanDb<=-80)throw mediaError('OUTPUT_INVALID','Audio must fully decode and contain audible samples');
 return {durationMs,channels:stream.channels,sampleRate:Number(stream.sample_rate),peakDb,meanDb};
}

/** Actual settings consumed by mixing; no mirrored approval fields. */
export function audioSettings(project,scope=project.scenes.map(s=>s.id)) {
 const a=project.settings.audio;if(a===undefined)return {music:[],sfx:[],normalize:true,ducking:{enabled:true,musicVolumeDuringSpeech:.15,attackMs:200,releaseMs:500}};
 const fail=()=>{throw mediaError('INVALID_APPROVAL_SETTINGS','Invalid audio mix settings');};
 if(!a||Array.isArray(a)||Object.keys(a).some(k=>!['music','sfx','normalize','ducking'].includes(k)))fail();
 if(a.normalize!==undefined&&typeof a.normalize!=='boolean')fail();
 const d={enabled:true,musicVolumeDuringSpeech:.15,attackMs:200,releaseMs:500,...a.ducking};
 if(a.ducking!==undefined&&(!a.ducking||Array.isArray(a.ducking)||Object.keys(a.ducking).some(k=>!['enabled','musicVolumeDuringSpeech','attackMs','releaseMs'].includes(k))))fail();
 if(typeof d.enabled!=='boolean'||!Number.isFinite(d.musicVolumeDuringSpeech)||d.musicVolumeDuringSpeech<0||d.musicVolumeDuringSpeech>1||!Number.isFinite(d.attackMs)||d.attackMs<10||d.attackMs>2000||!Number.isFinite(d.releaseMs)||d.releaseMs<10||d.releaseMs>9000)fail();
 for(const key of ['music','sfx']){
  if(a[key]!==undefined&&!Array.isArray(a[key]))fail();
  for(const t of a[key]??[]){
   const allowed=key==='music'?['assetId','volume','sceneId','startMs','durationMs','sourceStartMs','sourceEndMs','loop','fadeInMs','fadeOutMs']:['assetId','volume','sceneId','offsetMs'];
   if(!t||Object.keys(t).some(k=>!allowed.includes(k))||!project.assets.some(asset=>asset.id===t.assetId&&asset.mediaType.startsWith('audio/'))||!Number.isFinite(t.volume)||t.volume<0||t.volume>2)fail();
   const offset=key==='music'?t.startMs??0:t.offsetMs;
   if(!Number.isFinite(offset)||offset<0||(key==='sfx'&&!project.scenes.some(s=>s.id===t.sceneId)))fail();
   if(key==='music'){
    if(t.sceneId!==undefined&&!project.scenes.some(s=>s.id===t.sceneId))fail();
    for(const field of ['durationMs','sourceEndMs'])if(t[field]!==undefined&&(!Number.isFinite(t[field])||t[field]<=0))fail();
    for(const field of ['sourceStartMs','fadeInMs','fadeOutMs'])if(t[field]!==undefined&&(!Number.isFinite(t[field])||t[field]<0))fail();
    if(t.sourceEndMs!==undefined&&t.sourceEndMs<=(t.sourceStartMs??0)||t.loop!==undefined&&typeof t.loop!=='boolean'||t.durationMs!==undefined&&(t.fadeInMs??0)+(t.fadeOutMs??0)>t.durationMs)fail();
   }
  }
 }
 return {music:(a.music??[]).filter(t=>t.sceneId===undefined||scope.includes(t.sceneId)),sfx:(a.sfx??[]).filter(t=>scope.includes(t.sceneId)),normalize:a.normalize??true,ducking:d};
}

/** Successful per-sentence receipts survive later failure. The aggregate publishes last. */
export async function prepareAudio(root,{runtime={},hostReceipts={},workflowPaths}={}) {
 const project=await readProject(root);assertModePlan(project);
 if(project.scenes.some(s=>s.requiredEvents))assertWebsiteBindings(project,await loadVerifiedEvents(root,project,workflowPaths??project.settings.preparation?.workflowPaths??[],runtime));
 const key=audioKey(project);
 const job=await claimJob(root,{id:'audio',kind:'audio',sceneIds:project.scenes.map(s=>s.id),key,inputs:[]});
 try{
  const segments=[];
  for(const scene of project.scenes)for(const sentence of scene.sentences)segments.push(await synthesize(root,sentence,{runtime,voice:project.settings.voices?.[sentence.voiceId],hostReceipt:hostReceipts[sentence.id]}));
  await withProjectLock(root,async()=>{
   const current=await readProject(root);if(audioKey(current)!==key)throw mediaError('PREPARATION_STALE','Narration changed during preparation');
   await mkdir(join(root,'audio'),{recursive:true});
   await atomicWriteFile(join(root,'audio/segments.json'),JSON.stringify(segments,null,2));
  });
  await finishJob(root,job,{outputFiles:await outputFiles(root,['audio/segments.json',...segments.map(s=>s.path)])},current=>{if(audioKey(current)!==key)throw mediaError('PREPARATION_STALE','Narration changed before completion');});
  return segments;
 }catch(error){await failJob(root,job,error);throw error;}
}

/** Shared verified cache/readiness boundary, including derived genuine alignment. */
export async function verifyAudioSegment(root,seg,sentence,voice,runtime){
 if(seg?.audioRate!==undefined&&(!Number.isFinite(seg.audioRate)||seg.audioRate<.5||seg.audioRate>2))throw mediaError('AUDIO_STALE','Invalid delivered audio rate');
 if(!seg||seg.sentenceId!==sentence.id||seg.textHash!==canonicalHash(sentence.text)||seg.voiceHash!==canonicalHash(voice??{})||(seg.audioRate??1)!==(sentence.audioRate??1))throw mediaError('AUDIO_STALE','Narration text, voice or delivery changed');
 const project=await readProject(root);
 if(!project.assets.some(a=>a.path===seg.path&&a.sha256===seg.sha256))throw mediaError('AUDIO_STALE','Narration must be registered');
 const path=await verifiedAssetPath(root,seg),probe=await probeAudio(path,runtime);
 if(Math.abs(probe.durationMs-seg.durationMs)>.1)throw mediaError('AUDIO_STALE','Audio duration changed');
 if((seg.audioRate??1)!==1&&!seg.derivation)throw mediaError('AUDIO_STALE','Local rate adjustment requires base speech provenance');
 if(seg.derivation){
  const d=seg.derivation;if(d.operation!=='atempo'||d.rate!==seg.audioRate||!d.sourceCachePath)throw mediaError('AUDIO_STALE','Invalid audio derivation');
  const receipt=project.assets.find(a=>a.path===d.sourceCachePath);if(!receipt)throw mediaError('AUDIO_STALE','Missing base audio receipt');
  const base=JSON.parse(await readFile(await verifiedAssetPath(root,receipt))).segment;
  if(base.sha256!==d.sourceSha256||base.path!==d.sourcePath||(base.audioRate??1)!==1||base.derivation)throw mediaError('AUDIO_STALE','Invalid base speech');
  await verifyAudioSegment(root,base,{...sentence,audioRate:1},voice,runtime);
 }
 if(seg.words){
  validateWords(seg.words,seg.durationMs,sentence.text);
  const asset=project.assets.find(a=>a.id===seg.alignment?.assetId);if(!asset)throw mediaError('INVALID_ALIGNMENT','Missing alignment asset');
  const alignment=JSON.parse(await readFile(await verifiedAssetPath(root,asset)));
  if(alignment.unit!=='ms'||alignment.audioSha256!==seg.sha256||alignment.textHash!==seg.textHash||canonicalHash(alignment.words)!==canonicalHash(seg.words))throw mediaError('INVALID_ALIGNMENT','Alignment differs from audio/text/words');
  if(alignment.provenance?.kind==='derived'){
   const t=alignment.transform,sourceAsset=project.assets.find(a=>a.id===t?.sourceAlignmentAssetId);
   if(!sourceAsset||t.operation!=='atempo'||t.rate!==seg.audioRate||t.sourceAudioSha256!==seg.derivation?.sourceSha256||alignment.provenance.reference!==sourceAsset.id||alignment.provenance.version!=='ffmpeg-atempo-v1')throw mediaError('INVALID_ALIGNMENT','Invalid derived alignment source');
   const source=JSON.parse(await readFile(await verifiedAssetPath(root,sourceAsset)));
   if(!['forced-aligner','provider'].includes(source.provenance?.kind)||source.audioSha256!==t.sourceAudioSha256||source.textHash!==seg.textHash||canonicalHash(source.words.map(w=>({...w,startMs:w.startMs/t.rate,endMs:w.endMs/t.rate})))!==canonicalHash(seg.words))throw mediaError('INVALID_ALIGNMENT','Derived times must follow verified original alignment');
  }else if(!['forced-aligner','provider'].includes(alignment.provenance?.kind))throw mediaError('INVALID_ALIGNMENT','Unverified alignment provenance');
 }
 return probe;
}

/** Hydrates Task4 workflow evidence. Source association comes from the workflow and registered video origin. */
export async function loadVerifiedEvents(root,project,workflowPaths,runtime) {
 const events=[];
 const registered=async(path,sourceId)=>{const matches=project.assets.filter(a=>a.path===path&&a.origin.reference===sourceId);if(!matches.length)throw mediaError('EVENT_UNVERIFIED','Evidence is not registered to this source');for(const asset of matches){try{return await verifiedAssetPath(root,asset);}catch(error){if(error.code!=='ASSET_HASH_MISMATCH')throw error;}}throw mediaError('ASSET_HASH_MISMATCH','Registered evidence bytes changed');};
 for(const workflowPath of workflowPaths){
  const workflow=JSON.parse(await readFile(await projectMediaPath(root,workflowPath),'utf8'));
  await registered(workflowPath,workflow.sourceId);
  if(!project.sources.some(s=>s.id===workflow.sourceId&&s.kind==='url')||!Array.isArray(workflow.segments))throw mediaError('EVENT_UNVERIFIED','Invalid workflow source');
  for(const segment of workflow.segments){
   const asset=project.assets.find(a=>a.id===segment.videoAssetId);if(!asset||asset.path!==segment.video||asset.origin.reference!==workflow.sourceId)throw mediaError('EVENT_UNVERIFIED','Workflow video source differs from registered asset');
   const video=await verifiedAssetPath(root,asset);
   const decode=await runProcess(runtime.ffmpeg,['-v','error','-i',video,'-f','null','-'],{timeoutMs:60000});if(decode.code!==0)throw mediaError('EVENT_UNVERIFIED','Capture video failed decode');
   const timing=JSON.parse(await readFile(await registered(segment.timing,workflow.sourceId),'utf8'));
   for(const event of segment.events){
    const e=JSON.parse(await readFile(await registered(event.evidence,workflow.sourceId),'utf8'));
    if(e.verified!==true||e.id!==event.id||e.startMs!==event.startMs||e.endMs!==event.endMs||e.captureId!==segment.captureId||e.videoAssetId!==asset.id||e.video!==asset.path||e.endMs>timing.durationMs)throw mediaError('EVENT_UNVERIFIED','Event evidence does not match capture');
    for(const capture of [e.before,e.after])for(const field of ['screenshot','dom'])await registered(capture?.[field],workflow.sourceId);
    if(e.interaction!==undefined)assertInteraction(e.interaction,e.startMs,e.endMs);
    events.push({id:e.id,startMs:e.startMs,endMs:e.endMs,evidence:event.evidence,verified:true,sourceId:workflow.sourceId,captureId:segment.captureId,videoAssetId:asset.id,
      ...(e.interaction!==undefined && !e.reconciled?{interaction:e.interaction}:{})});
   }
  }
 }return events;
}

/** Verifies current narration/media bytes and recording evidence before pure timeline resolution. */
export async function prepareTimeline(root,segments,{runtime={},workflowPaths=[]}={}) {
 const project=await readProject(root);assertModePlan(project);
 const events=await loadVerifiedEvents(root,project,workflowPaths,runtime);assertWebsiteBindings(project,events);
 for(const seg of segments){
  const sentence=project.scenes.flatMap(s=>s.sentences).find(s=>s.id===seg.sentenceId);
  if(!sentence)throw mediaError('AUDIO_STALE','Unknown sentence');
  await verifyAudioSegment(root,seg,sentence,project.settings.voices?.[sentence.voiceId],runtime);
 }
 for(const scene of project.scenes)for(const c of recordingCuts(project,scene)){
  const path=await verifiedAssetPath(root,project.assets.find(a=>a.id===c.videoAssetId));
  const probe=await runProcess(runtime.ffprobe,['-v','error','-show_entries','format=duration','-of','json',path],{timeoutMs:15000});let duration;try{duration=Number(JSON.parse(probe.stdout).format.duration)*1000;}catch{}
  if(probe.code!==0||!Number.isFinite(duration)||c.sourceEndMs>duration+.1)throw mediaError('INVALID_RECORDING_MAP','Cut exceeds measured video duration');
 }
 return resolveTimeline(project,segments,events);
}

/** Mix and subtitles consume only the final timeline. Publish immutable output after verification. */
export async function mixAudio(root,timeline,{runtime={}}={}) {
 const project=await readProject(root),settings=audioSettings(project),directory=await mkdtemp(join(tmpdir(),'supervideo-mix-'));
 try{
  if(timeline.projectHash!==timelineProjectHash(project))throw mediaError('TIMELINE_STALE','Project changed after timeline resolution');
  if(!timeline.durationInFrames||timeline.fps!==project.output.fps)throw mediaError('INVALID_TIMELINE','Final measured timeline required');
  const tracks=[],narration=[];
  const duration=timeline.durationInFrames/timeline.fps;
  const mixDuration=duration+0.5; // Flush loudnorm filter latency beyond the deliverable endpoint.
  for(const seg of timeline.audio){const path=await verifiedAssetPath(root,seg);await probeAudio(path,runtime);narration.push({...seg,path});}
  if(narration.length){
   const stem=join(directory,'narration.wav');
   // Schedule short source clips on the absolute sample clock, then sum at unity.
   // Upstream sees one speech bus, so its default amix cannot divide voice/key by sentence count.
   const filters=narration.map((seg,index)=>`[${index}:a]atrim=duration=${seg.durationMs/1000},aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,adelay=${Math.round(seg.startMs*48)}S:all=1[n${index}]`);
   filters.push(`${narration.map((_,index)=>`[n${index}]`).join('')}amix=inputs=${narration.length}:duration=longest:dropout_transition=0:normalize=0,apad=whole_dur=${mixDuration},atrim=duration=${mixDuration},asetpts=PTS-STARTPTS[out]`);
   const assembled=await runProcess(runtime.ffmpeg,['-v','error',...narration.flatMap(seg=>['-i',seg.path]),'-filter_complex',filters.join(';'),'-map','[out]','-ar','48000','-ac','2','-c:a','pcm_f32le','-y',stem],{timeoutMs:runtime.timeoutMs??60000});
   if(assembled.code!==0)throw mediaError(assembled.timedOut?'PROVIDER_TIMEOUT':'OUTPUT_INVALID','Narration stem assembly failed');
   tracks.push({path:stem,role:'speech',start_seconds:0});
  }
  for(const t of settings.music){
   const path=join(directory,`music-${tracks.length}.wav`);await prepareMusicTrack(root,t,timeline,path,{runtime});
   tracks.push({path,role:'music',volume:t.volume,start_seconds:0});
  }
  for(const t of settings.sfx){
   const asset=project.assets.find(a=>a.id===t.assetId),path=await verifiedAssetPath(root,asset),measuredTrack=await probeAudio(path,runtime),scene=timeline.scenes.find(s=>s.id===t.sceneId);
   if(!scene||t.offsetMs+measuredTrack.durationMs>scene.durationMs)throw mediaError('SFX_OUT_OF_BOUNDS',t.assetId);
   tracks.push({path,role:'sfx',volume:t.volume,start_seconds:(scene.startMs+t.offsetMs)/1000});
  }
  // Equal end times avoid premature EOF in FFmpeg 9's sidechain/amix graph.
  // Narration is already one full-span stem; schedule music/effects upstream.
  for(const [index,track]of tracks.entries()){
   if(track.role==='speech')continue;
   const remaining=mixDuration-track.start_seconds;if(!(remaining>0))throw mediaError('AUDIO_OUT_OF_BOUNDS','Track starts beyond the final timeline');
   const padded=join(directory,`track-${index}.wav`);
   const preparation=await runProcess(runtime.ffmpeg,['-v','error','-i',track.path,'-vn','-af',`apad=whole_dur=${remaining},atrim=duration=${remaining},asetpts=PTS-STARTPTS`,'-ar','48000','-ac','2','-c:a','pcm_f32le','-y',padded],{timeoutMs:runtime.timeoutMs??60000});
   if(preparation.timedOut)throw mediaError('PROVIDER_TIMEOUT','Audio track preparation timed out');
   if(preparation.code!==0)throw mediaError('OUTPUT_INVALID','Audio track preparation failed');track.path=padded;
  }
  const output=join(directory,'mixed.wav'),d=settings.ducking;
  // Pinned upstream divides these fields by 1000; compensate to preserve FFmpeg milliseconds.
  const receipt=await callOpenMontage(runtime,{operation:'mix',args:{tracks,normalize:settings.normalize,ducking:{enabled:d.enabled,music_volume_during_speech:d.musicVolumeDuringSpeech,attack_ms:d.attackMs*1000,release_ms:d.releaseMs*1000},target_duration:mixDuration,output_path:output}});
  if(receipt.status!=='succeeded')throw mediaError(receipt.error.code,receipt.error.detail);
  const raw=await probeAudio(output,runtime);
  if(raw.durationMs<duration*1000)throw mediaError('OUTPUT_INVALID','OpenMontage output ended before the final timeline');
  const final=join(directory,'final.wav');
  const conform=await runProcess(runtime.ffmpeg,['-v','error','-i',output,'-af',`atrim=duration=${duration},asetpts=PTS-STARTPTS`,'-ar','48000','-ac','2','-c:a','pcm_s24le','-y',final],{timeoutMs:runtime.timeoutMs??60000});
  if(conform.code!==0)throw mediaError(conform.timedOut?'PROVIDER_TIMEOUT':'OUTPUT_INVALID','Mix output conversion failed');
  const measured=await probeAudio(final,runtime);
  if(Math.abs(measured.durationMs-timeline.durationInFrames*1000/timeline.fps)>2||measured.peakDb>=0)throw mediaError('OUTPUT_INVALID',`Mixed audio duration or clipping check failed: ${JSON.stringify(measured)}`);
  // Sentence-only segments are single upstream tokens; prevent grouping across
  // sentence/scene/intentional quiet boundaries without fabricating word timing.
  const subtitle=join(directory,'captions.srt');const captions=await callOpenMontage(runtime,{operation:'subtitles',args:{segments:timeline.captions.map(c=>({start:c.startMs/1000,end:c.endMs/1000,text:c.text})),format:'srt',max_chars_per_line:40,max_words_per_cue:1,output_path:subtitle}});
  if(captions.status!=='succeeded')throw mediaError(captions.error.code,captions.error.detail);
  if(timelineProjectHash(await readProject(root))!==timeline.projectHash)throw mediaError('TIMELINE_STALE','Project changed during mix');
  const asset=await importAsset(root,{path:final,origin:{kind:'provider',reference:'OpenMontage full_mix',version:canonicalHash({timeline,settings})}});
  await mkdir(join(root,'audio'),{recursive:true});const captionPath=`audio/${canonicalHash(timeline.captions)}.srt`;await atomicWriteFile(join(root,captionPath),await readFile(subtitle));
  return {status:'succeeded',artifacts:[asset.path,captionPath],checks:[{name:'pinned-openmontage',passed:true,evidence:receipt.checks.find(c=>c.name==='pinned-openmontage').evidence},{name:'output-file',passed:true,evidence:asset.path},{name:'mixed-audio-levels',passed:true,evidence:JSON.stringify(measured)}]};
 }finally{await rm(directory,{recursive:true,force:true});}
}
