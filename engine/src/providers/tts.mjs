import {readProject,atomicWriteFile,withProjectLock} from '../core/store.mjs';
import {speechKey,claimJob,finishJob,failJob,outputFiles} from '../core/jobs.mjs';
import { requestBailian, validateBailianVoice, BAILIAN_MODEL } from './bailian.mjs';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { canonicalHash } from '../core/model.mjs';
import { runProcess } from './process.mjs';
import { callOpenMontage, inspectOpenMontage, OPENMONTAGE_COMMIT } from './openmontage.mjs';
import { importAsset,mediaError,sha256,verifiedAssetPath } from './assets.mjs';
import { probeAudio, verifyAudioSegment } from '../media/audio.mjs';
import { validateWords } from '../media/timeline.mjs';

export function validateVoice(voice) {
 if(!voice||!['system','host','openmontage','bailian'].includes(voice.provider))throw mediaError('INVALID_VOICE','Select system, host, openmontage or bailian voice provider');
 const allowed={bailian:['provider','voice','model','language','instructions','optimizeInstructions'],system:['provider','voice','rate'],host:['provider'],openmontage:['provider','voice','model','stability','similarityBoost','style','speed','speakerBoost']}[voice.provider];
 if(Object.keys(voice).some(k=>!allowed.includes(k)))throw mediaError('INVALID_VOICE','Unknown voice setting');
 if(voice.provider!=='host'&&(typeof voice.voice!=='string'||!voice.voice.trim()))throw mediaError('INVALID_VOICE','Explicit voice is required');
 for(const [key,min,max]of[['rate',80,500],['stability',0,1],['similarityBoost',0,1],['style',0,1],['speed',.7,1.2]])if(voice[key]!==undefined&&(!Number.isFinite(voice[key])||voice[key]<min||voice[key]>max))throw mediaError('INVALID_VOICE',`Invalid ${key}`);
 if(voice.model!==undefined&&(typeof voice.model!=='string'||!voice.model.trim()))throw mediaError('INVALID_VOICE','Invalid model');
 if(voice.speakerBoost!==undefined&&typeof voice.speakerBoost!=='boolean')throw mediaError('INVALID_VOICE','Invalid speakerBoost');
 if(voice.provider==='bailian')validateBailianVoice(voice);
 return voice;
}

export async function ttsCapabilities(runtime={},env=process.env) {
 const say=process.platform==='darwin'?await runProcess(runtime.say??'/usr/bin/say',['-v','?'],{timeoutMs:5000}):{code:1};
 const dependency=await inspectOpenMontage(runtime);
 let service=false;
 if(dependency.available&&env.ELEVENLABS_API_KEY&&runtime.python){const p=await runProcess(runtime.python,['-c','import requests'],{timeoutMs:5000});service=p.code===0;}
 const cap=(id,available,version,reason)=>({id,available,version:available?version:null,reason:available?null:reason,remedy:available?null:'Configure the explicit provider runtime or supply a host audio receipt.'});
 return [cap('tts-bailian',Boolean(env.DASHSCOPE_API_KEY?.trim()),BAILIAN_MODEL,'DASHSCOPE_API_KEY is required; configured credentials do not prove quota or service acceptance'),cap('tts-system',say.code===0,'macOS-say', 'System speech is unavailable'),cap('tts-host',true,'host-receipt-v1',null),cap('tts-openmontage',service,OPENMONTAGE_COMMIT,'Pinned runtime, Python requests and ELEVENLABS_API_KEY are required')];
}

/** Runtime paths/receipts are operational config; creative voice values come from project.settings.voices. */
async function synthesizeBase(root,sentence,{voice,runtime={},hostReceipt}={}) {
 validateVoice(voice);if(!sentence?.id||!sentence.text?.trim())throw mediaError('INVALID_SENTENCE','Nonempty narration required');
 let directory;
 try{
  let path,origin,words,alignment,providerReceipt;
  if(voice.provider==='host'){
   const r=hostReceipt;
   if(r?.status==='failed')throw mediaError(r.error?.code??'PROVIDER_FAILED',r.error?.detail??'Host speech generation failed; retry the provider');
   if(!r||r.status!=='succeeded')throw mediaError('HOST_AUDIO_REQUIRED','Supply a succeeded audio receipt from the host');
   if(r.sentenceId!==sentence.id||r.textHash!==canonicalHash(sentence.text)||! /^[a-f0-9]{64}$/.test(r.sha256))throw mediaError('HOST_RECEIPT_MISMATCH','Receipt must bind sentence, text and audio hash');
   origin=r.origin;const bytes=await readFile(r.path);if(sha256(bytes)!==r.sha256)throw mediaError('HOST_RECEIPT_MISMATCH','Audio bytes differ from the host receipt');
   directory=await mkdtemp(join(tmpdir(),'supervideo-host-audio-'));path=join(directory,`narration${extname(r.path)}`);await writeFile(path,bytes);
   const measured=await probeAudio(path,runtime);
   if(r.alignmentPath&&r.alignment)throw mediaError('INVALID_ALIGNMENT','Supply one alignment document');
   alignment=r.alignmentPath?JSON.parse(await readFile(r.alignmentPath,'utf8')):r.alignment;
   if(alignment){
    const p=alignment.provenance;
    if(alignment.unit!=='ms'||alignment.audioSha256!==r.sha256||alignment.textHash!==r.textHash||!['forced-aligner','provider'].includes(p?.kind)||!p.reference?.trim()||!p.version?.trim())throw mediaError('INVALID_ALIGNMENT','Require millisecond alignment bound to audio/text with aligner provenance');
    words=validateWords(alignment.words,measured.durationMs,sentence.text);
   }
  }else{
   directory=await mkdtemp(join(tmpdir(),'supervideo-tts-'));
   if(voice.provider==='system'){
    const inventory=await runProcess(runtime.say??'/usr/bin/say',['-v','?'],{timeoutMs:runtime.timeoutMs??5000});
    if(inventory.timedOut)throw mediaError('PROVIDER_TIMEOUT','System voice probe timed out');
    if(inventory.code!==0||!inventory.stdout.split('\n').some(line=>line.split(/\s{2,}/)[0]===voice.voice))throw mediaError('TTS_UNAVAILABLE','Selected system voice is not installed');
    path=join(directory,'narration.aiff');
    const result=await runProcess(runtime.say??'/usr/bin/say',['-v',voice.voice,'-r',String(voice.rate??190),'-o',path],{input:sentence.text,timeoutMs:runtime.timeoutMs??60000});
    if(result.timedOut)throw mediaError('PROVIDER_TIMEOUT','System TTS timed out; retry preparation');
    if(result.code!==0)throw mediaError('TTS_FAILED','System speech failed; check the selected installed voice');
    origin={kind:'provider',reference:`macOS say:${voice.voice}`,version:'system'};
   }else if(voice.provider==='bailian'){
    const result=await requestBailian(sentence.text,voice,runtime);path=join(directory,'narration.wav');await writeFile(path,result.bytes);providerReceipt=result.evidence;
    origin={kind:'provider',reference:`Bailian/${voice.model}/${voice.voice}`,version:voice.model};
   }else{
    const cap=(await ttsCapabilities(runtime)).find(c=>c.id==='tts-openmontage');if(!cap.available)throw mediaError('TTS_UNAVAILABLE',cap.reason);
    path=join(directory,'narration.mp3');const args={text:sentence.text,voice_id:voice.voice,output_path:path,output_format:'mp3_44100_128'};
    for(const [key,upstream]of Object.entries({model:'model_id',stability:'stability',similarityBoost:'similarity_boost',style:'style',speed:'speed',speakerBoost:'use_speaker_boost'}))if(voice[key]!==undefined)args[upstream]=voice[key];
    const receipt=await callOpenMontage(runtime,{operation:'tts',args});if(receipt.status!=='succeeded')throw mediaError(receipt.error.code,receipt.error.detail);
    origin={kind:'provider',reference:`OpenMontage/ElevenLabs:${voice.voice}`,version:OPENMONTAGE_COMMIT};
   }
  }
  const measured=await probeAudio(path,runtime),asset=await importAsset(root,{path,origin});
  let alignmentAsset;
  if(words){
   if(!directory)directory=await mkdtemp(join(tmpdir(),'supervideo-alignment-'));
   const alignmentPath=join(directory,'alignment.json');await writeFile(alignmentPath,JSON.stringify(alignment));
   alignmentAsset=await importAsset(root,{path:alignmentPath,origin:{kind:'host',reference:alignment.provenance.reference,version:alignment.provenance.version}});
  }
  return {audioRate:1,sentenceId:sentence.id,path:asset.path,sha256:asset.sha256,durationMs:measured.durationMs,textHash:canonicalHash(sentence.text),voiceHash:canonicalHash(voice),...(providerReceipt?{providerReceipt}:{}),...(words?{words,alignment:{assetId:alignmentAsset.id,unit:'ms',audioSha256:asset.sha256,textHash:canonicalHash(sentence.text),provenance:alignment.provenance}}:{})};
 }finally{if(directory)await rm(directory,{recursive:true,force:true});}
}


async function cachedSegment(root,key,sentence,voice,runtime){
 try{
  const p=await readProject(root),asset=p.assets.find(a=>a.path===`audio/cache/${key}.json`&&a.origin.version===key);
  if(!asset)return null;
  const entry=JSON.parse(await readFile(await verifiedAssetPath(root,asset),'utf8'));
  if(entry.key!==key)return null;
  await verifyAudioSegment(root,entry.segment,sentence,voice,runtime);return entry.segment;
 }catch{return null;}
}
async function cacheSegment(root,key,segment){
 const path=`audio/cache/${key}.json`,bytes=JSON.stringify({key,segment},null,2);
 await mkdir(join(root,'audio/cache'),{recursive:true});
 await withProjectLock(root,async()=>{
  const p=await readProject(root);
  await atomicWriteFile(join(root,path),bytes);
  const asset={id:`speech-cache-${key}`,path,sha256:sha256(bytes),mediaType:'application/json',origin:{kind:'provider',reference:'SuperVideo verified speech cache',version:key}};
  p.assets=p.assets.filter(a=>a.id!==asset.id);p.assets.push(asset);p.revision++;
  await atomicWriteFile(join(root,'project.json'),JSON.stringify(p,null,2));
 });return path;
}

/** Per-sentence cache includes measured base speech before any local tempo edit. */
export async function synthesize(root,sentence,{voice,runtime={},hostReceipt}={}){
 validateVoice(voice);const rate=sentence.audioRate??1;
 if(!Number.isFinite(rate)||rate<.5||rate>2)throw mediaError('INVALID_SENTENCE','audioRate must be between 0.5 and 2');
 const key=speechKey(sentence,voice),baseSentence={...sentence,audioRate:1},baseKey=speechKey(baseSentence,voice);
 let segment=await cachedSegment(root,key,sentence,voice,runtime);
 const p=await readProject(root),scene=p.scenes.find(s=>s.sentences.some(line=>line.id===sentence.id));
 const job=scene?await claimJob(root,{id:`tts-${sentence.id}`,kind:'tts',sentenceId:sentence.id,sceneIds:[scene.id],key,inputs:[canonicalHash(sentence.text),canonicalHash(voice)]}):null;
 try{
  // An explicitly supplied host receipt is new evidence, never silently ignored by a cache hit.
  if(voice.provider==='host'&&hostReceipt!==undefined){
   const supplied=await synthesizeBase(root,baseSentence,{voice,runtime,hostReceipt});
   await cacheSegment(root,baseKey,supplied);
   segment=rate===1?supplied:await changeRate(root,supplied,rate,runtime,baseKey);
   await cacheSegment(root,key,segment);
  }
  if(!segment){
   let base=await cachedSegment(root,baseKey,baseSentence,voice,runtime);
   if(!base){
    // Migrate already verified narration without an unnecessary service call.
    try{const old=JSON.parse(await readFile(join(root,'audio/segments.json'))).find(s=>s.sentenceId===sentence.id);await verifyAudioSegment(root,old,baseSentence,voice,runtime);base={...old,audioRate:1};}catch{}
    if(!base)base=await synthesizeBase(root,baseSentence,{voice,runtime,hostReceipt});
    await cacheSegment(root,baseKey,base);
   }
   segment=rate===1?base:await changeRate(root,base,rate,runtime,baseKey);
   await cacheSegment(root,key,segment);
  }
  if(job)await finishJob(root,job,{outputFiles:await outputFiles(root,[`audio/cache/${key}.json`,segment.path,...(segment.alignment?[ (await readProject(root)).assets.find(a=>a.id===segment.alignment.assetId).path ]:[])])},current=>{
   const line=current.scenes.flatMap(s=>s.sentences).find(s=>s.id===sentence.id);
   if(!line||speechKey(line,current.settings.voices?.[line.voiceId])!==key)throw mediaError('PREPARATION_STALE','Sentence changed during synthesis');
  });
  return segment;
 }catch(error){if(job)await failJob(root,job,error);throw error;}
}

async function changeRate(root,base,rate,runtime,baseKey){
 const directory=await mkdtemp(join(tmpdir(),'supervideo-tempo-'));
 try{
  const source=await verifiedAssetPath(root,base),path=join(directory,'narration.wav');
  const result=await runProcess(runtime.ffmpeg,['-v','error','-i',source,'-vn','-af',`atempo=${rate}`,'-c:a','pcm_s24le','-y',path],{timeoutMs:runtime.timeoutMs??60000});
  if(result.code!==0)throw mediaError(result.timedOut?'PROVIDER_TIMEOUT':'OUTPUT_INVALID','Local pitch-preserving tempo adjustment failed');
  const measured=await probeAudio(path,runtime),asset=await importAsset(root,{path,origin:{kind:'provider',reference:'Local FFmpeg atempo',version:canonicalHash({sourceSha256:base.sha256,rate})}});
  const segment={sentenceId:base.sentenceId,path:asset.path,sha256:asset.sha256,durationMs:measured.durationMs,textHash:base.textHash,voiceHash:base.voiceHash,audioRate:rate,
   derivation:{operation:'atempo',rate,sourceSha256:base.sha256,sourcePath:base.path,sourceCachePath:`audio/cache/${baseKey}.json`},...(base.providerReceipt?{sourceProviderReceipt:base.providerReceipt}:{})};
  const project=await readProject(root);
  if(base.words){
   const original=project.assets.find(a=>a.id===base.alignment.assetId);
   const evidence=JSON.parse(await readFile(await verifiedAssetPath(root,original)));
   const words=validateWords(evidence.words.map(w=>({...w,startMs:w.startMs/rate,endMs:w.endMs/rate})),measured.durationMs);
   const provenance={kind:'derived',reference:original.id,version:'ffmpeg-atempo-v1'};
   const alignment={unit:'ms',audioSha256:asset.sha256,textHash:base.textHash,words,provenance,transform:{operation:'atempo',rate,sourceAlignmentAssetId:original.id,sourceAudioSha256:base.sha256}};
   const document=join(directory,'alignment.json');await writeFile(document,JSON.stringify(alignment));
   const registered=await importAsset(root,{path:document,origin:{kind:'provider',reference:original.id,version:'ffmpeg-atempo-v1'}});
   segment.words=words;segment.alignment={assetId:registered.id,unit:'ms',audioSha256:asset.sha256,textHash:base.textHash,provenance};
  }
  return segment;
 }finally{await rm(directory,{recursive:true,force:true});}
}
