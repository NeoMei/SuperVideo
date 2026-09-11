import {assertWebsiteBindings} from '../modes/website.mjs';
import { isAbsolute } from 'node:path';
import { assertProject, canonicalHash } from '../core/model.mjs';
import { mediaError } from '../providers/assets.mjs';
const fail=(code,message)=>{throw mediaError(code,message);};
const finite=(v,min=0)=>Number.isFinite(v)&&v>=min;
const textKey=s=>s.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu,'');

/** Real aligner output must retain every spoken token, never infer word timing. */
export function validateWords(words,durationMs,text) {
 if(!Array.isArray(words)||!words.length) fail('INVALID_ALIGNMENT','Alignment must contain words');
 const ids=new Set();let end=0;
 for(const w of words){
  if(!w||typeof w.id!=='string'||!w.id||ids.has(w.id)||typeof w.text!=='string'||!w.text.trim()||!finite(w.startMs)||!finite(w.endMs)||w.startMs<end||w.endMs<=w.startMs||w.endMs>durationMs)fail('INVALID_ALIGNMENT','Word IDs, ordering or audio bounds are invalid');
  ids.add(w.id);end=w.endMs;
 }
 if(text!==undefined&&textKey(words.map(w=>w.text).join(''))!==textKey(text))fail('INVALID_ALIGNMENT','Alignment does not cover the narration text');
 return words;
}

/** Capture-local source times are mapped only through explicit kept intervals. */
export function recordingCuts(project,scene) {
 const recording=scene.visual.props.recording;
 if(scene.visual.kind!=='recording') {if(recording!==undefined)fail('INVALID_RECORDING_MAP','Recording map requires recording visual');return [];}
 if(!recording||recording.durationPolicy!=='hold'||!Array.isArray(recording.cuts)||!recording.cuts.length||Object.keys(recording).some(k=>!['durationPolicy','cuts'].includes(k)))fail('INVALID_RECORDING_MAP','Recording requires explicit hold policy and cuts');
 let end=0;
 return recording.cuts.map(c=>{
  if(!c||Object.keys(c).some(k=>!['captureId','sourceId','videoAssetId','sourceStartMs','sourceEndMs','sceneStartMs','playbackRate'].includes(k))||!c.captureId||!project.sources.some(s=>s.id===c.sourceId)||!scene.refs.some(r=>r.sourceId===c.sourceId)||!scene.visual.assetIds.includes(c.videoAssetId)||!project.assets.some(a=>a.id===c.videoAssetId&&a.mediaType.startsWith('video/'))||!finite(c.sourceStartMs)||!finite(c.sourceEndMs)||c.sourceEndMs<=c.sourceStartMs||!finite(c.sceneStartMs)||!finite(c.playbackRate,Number.MIN_VALUE)||c.sceneStartMs<end)fail('INVALID_RECORDING_MAP','Cuts require associated source/video, ordered nonoverlapping scene windows and positive rate');
  end=c.sceneStartMs+(c.sourceEndMs-c.sourceStartMs)/c.playbackRate;return {...c,sceneEndMs:end};
 });
}

export function timelineProjectHash(project) {
 const voiceIds=new Set(project.scenes.flatMap(s=>s.sentences.map(sentence=>sentence.voiceId)));
 return canonicalHash({scenes:project.scenes,output:project.output,voices:Object.fromEntries([...voiceIds].sort().map(id=>[id,project.settings.voices?.[id]??{}])),audio:project.settings.audio??{}});
}

/** Pure readiness boundary. All frames derive from accumulated absolute milliseconds. */
export function resolveTimeline(project,segments,events) {
 const sentences=project.scenes.flatMap(s=>s.sentences); const sentenceIds=new Set();
 for(const s of sentences){if(sentenceIds.has(s.id))fail('DUPLICATE_SENTENCE_ID',s.id);sentenceIds.add(s.id);}
 for(const scene of project.scenes)for(const cue of scene.cues)if(cue.anchor.kind==='sentence'&&!scene.sentences.some(s=>s.id===cue.anchor.id))fail('SENTENCE_NOT_FOUND',cue.anchor.id);
 assertProject(project);assertWebsiteBindings(project,events);
 const bySentence=new Map(),words=new Map(),byEvent=new Map();
 for(const seg of segments){
  if(bySentence.has(seg.sentenceId))fail('DUPLICATE_AUDIO_SEGMENT',seg.sentenceId);
  if(!sentenceIds.has(seg.sentenceId))fail('SENTENCE_NOT_FOUND',seg.sentenceId);
  if(!finite(seg.durationMs,Number.MIN_VALUE)||typeof seg.path!=='string'||!seg.path||isAbsolute(seg.path)||seg.path.split(/[\\/]/).includes('..')||! /^[a-f0-9]{64}$/.test(seg.sha256))fail('INVALID_AUDIO_SEGMENT','Invalid measured segment');
  const sentence=sentences.find(s=>s.id===seg.sentenceId);
  if(!Number.isFinite(seg.audioRate??1)||(seg.audioRate??1)!==(sentence.audioRate??1))fail('AUDIO_STALE','Audio delivery rate changed');
  if(seg.textHash!==undefined&&seg.textHash!==canonicalHash(sentence.text))fail('AUDIO_STALE',seg.sentenceId);
  if(seg.voiceHash!==undefined&&seg.voiceHash!==canonicalHash(project.settings.voices?.[sentence.voiceId]??{}))fail('AUDIO_STALE',seg.sentenceId);
  bySentence.set(seg.sentenceId,seg);
  if(seg.words)for(const word of validateWords(seg.words,seg.durationMs,sentence.text)){if(words.has(word.id))fail('DUPLICATE_WORD_ID',word.id);words.set(word.id,{...word,sentenceId:seg.sentenceId});}
 }
 for(const event of events){if(byEvent.has(event.id))fail('DUPLICATE_EVENT_ID',event.id);byEvent.set(event.id,event);}
 const fps=project.output.fps,frame=ms=>Math.round(ms*fps/1000),timeline={fps,projectHash:timelineProjectHash(project),durationInFrames:0,scenes:[],audio:[],captions:[]};let globalMs=0;
 for(const scene of project.scenes){
  const start=globalMs,cuts=recordingCuts(project,scene),anchors=new Map();let narration=start+scene.leadMs;
  for(const sentence of scene.sentences){
   const seg=bySentence.get(sentence.id);if(!seg)fail('AUDIO_REQUIRED',sentence.id);
   const end=narration+seg.durationMs; if(frame(end)<=frame(narration))fail('AUDIO_TOO_SHORT',sentence.id);
   anchors.set(sentence.id,{startMs:narration,endMs:end});
   timeline.audio.push({sentenceId:sentence.id,path:seg.path,from:frame(narration),durationInFrames:frame(end)-frame(narration),startMs:narration,durationMs:seg.durationMs,sha256:seg.sha256});
   timeline.captions.push({id:sentence.id,text:sentence.text,startMs:narration,endMs:end});narration=end;
  }
  globalMs=Math.max(narration+scene.tailMs,start+(cuts.at(-1)?.sceneEndMs??0));
  const cues=scene.cues.map(cue=>{
   let anchor;
   if(cue.anchor.kind==='sentence'){anchor=anchors.get(cue.anchor.id);if(!anchor)fail('SENTENCE_NOT_FOUND',cue.anchor.id);}
   else if(cue.anchor.kind==='word'){
    const w=words.get(cue.anchor.id);if(!w)fail(words.size?'WORD_NOT_FOUND':'WORD_ALIGNMENT_REQUIRED',cue.anchor.id);
    const s=anchors.get(w.sentenceId);if(!s)fail('WORD_NOT_FOUND','Word belongs to another scene');anchor={startMs:s.startMs+w.startMs,endMs:s.startMs+w.endMs};
   }else{
    const e=byEvent.get(cue.anchor.id);if(!e)fail('EVENT_NOT_FOUND',cue.anchor.id);
    if(e.verified!==true||!e.evidence||!finite(e.startMs)||!finite(e.endMs)||e.endMs<e.startMs)fail('EVENT_UNVERIFIED',e.id);
    const matches=cuts.filter(c=>c.captureId===e.captureId&&c.sourceId===e.sourceId&&c.videoAssetId===e.videoAssetId&&e.startMs>=c.sourceStartMs&&e.endMs<=c.sourceEndMs);
    if(matches.length!==1)fail(matches.length?'EVENT_MAPPING_AMBIGUOUS':'EVENT_UNMAPPED',e.id);
    const c=matches[0],map=ms=>start+c.sceneStartMs+(ms-c.sourceStartMs)/c.playbackRate;anchor={startMs:map(e.startMs),endMs:map(e.endMs)};
   }
   const at=anchor[`${cue.anchor.edge}Ms`]+cue.offsetMs;if(at<start||at>globalMs)fail('CUE_OUT_OF_BOUNDS',cue.id);
   return {id:cue.id,frame:frame(at),atMs:at};
  });
  if(frame(globalMs)<=frame(start))fail('EMPTY_SCENE',scene.id);
  timeline.scenes.push({id:scene.id,from:frame(start),durationInFrames:frame(globalMs)-frame(start),startMs:start,durationMs:globalMs-start,cues});
 }
 timeline.durationInFrames=frame(globalMs);return timeline;
}
