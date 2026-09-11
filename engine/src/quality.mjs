import {readFile} from 'node:fs/promises';
import {dirname,join,relative,isAbsolute,basename,normalize} from 'node:path';
import {readProject,withProjectLock} from './core/store.mjs';
import {canonicalHash,exportSettings,validateApprovalTarget} from './core/model.mjs';
import {approvalSettings,isCurrent} from './core/approvals.mjs';
import {renderContentKey} from './render/render.mjs';
import {assertRenderProject} from './render/schema.mjs';
import {prepareTimeline,CAPTION_POLICY} from './media/audio.mjs';
import {projectMediaPath,sha256,mediaError} from './providers/assets.mjs';
import {runProcess} from './providers/process.mjs';

const check=(name,evidence)=>({name,passed:true,evidence:typeof evidence==='string'?evidence:JSON.stringify(evidence)});
const equal=(a,b)=>canonicalHash(a)===canonicalHash(b);
const fail=(code,detail)=>{throw mediaError(code,detail);};
export function failedReceipt(error,checks=[]){return {status:['FINAL_APPROVAL_REQUIRED','FONT_REQUIRED','FONT_LICENSE_REQUIRED','DEPENDENCY_MISSING','SCRIPT_APPROVAL_REQUIRED','SAMPLE_APPROVAL_REQUIRED','COMPONENT_REVIEW_REQUIRED'].includes(error.code)?'needs_input':'failed',artifacts:[],checks,error:{code:error.code??'OUTPUT_INVALID',detail:error.message}};}

/** Hash-confined reference closure, never a recursive directory copy or remote fetch. */
export async function projectFiles(root,project,segments,workflowPaths,{fontLicense=false}={}){
  const files=new Map(),ids=new Set(project.scenes.flatMap(s=>s.visual.assetIds));
  const add=async(descriptor,structuredJson=false)=>{
    if(!descriptor||typeof descriptor.path!=='string'||! /^[a-f0-9]{64}$/.test(descriptor.sha256))fail('MISSING_REFERENCE','Reference has no path/SHA');
    const bytes=await readFile(await projectMediaPath(root,descriptor.path));
    if(sha256(bytes)!==descriptor.sha256)fail('ASSET_HASH_MISMATCH',`Changed reference: ${descriptor.path}`);
    const existing=files.get(descriptor.path);if(existing&&existing.sha256!==descriptor.sha256)fail('ASSET_HASH_MISMATCH','Conflicting path versions');
    structuredJson=structuredJson||existing?.structuredJson||/^(application\/json|[^;]+\+json)(;|$)/i.test(descriptor.mediaType??'');
    files.set(descriptor.path,{path:descriptor.path,sha256:descriptor.sha256,size:bytes.length,...(structuredJson?{structuredJson:true}:{})});return bytes;
  };
  const assetId=async(id,structuredJson=false)=>{const asset=project.assets.find(a=>a.id===id);if(!asset)fail('MISSING_REFERENCE',`Unresolved asset ${id}`);await add(asset,structuredJson);return asset;};
  const registered=async(path,sourceId,structuredJson=false)=>{
    const matches=project.assets.filter(a=>a.path===path&&(!sourceId||a.origin.reference===sourceId));
    for(const a of matches){try{return await add(a,structuredJson);}catch(e){if(e.code!=='ASSET_HASH_MISMATCH')throw e;}}
    fail('MISSING_REFERENCE',`Missing verified registered reference: ${path}`);
  };
  for(const source of project.sources)for(const node of source.nodes)node.assetIds.forEach(id=>ids.add(id));
  const settings=approvalSettings(project,'sample',project.scenes.map(s=>s.id));
  for(const track of [...settings.audio.music,...settings.audio.sfx])ids.add(track.assetId);
  for(const cast of settings.book?.cast??[])cast.referenceAssetIds.forEach(id=>ids.add(id));
  for(const c of settings.book?.continuity??[])for(const id of [...c.propAssetIds,...(c.review?.assetIds??[]),...(c.review?.referenceAssetIds??[])])ids.add(id);
  for(const d of settings.components??[])for(const f of d.files)ids.add(f.assetId);
  if(!settings.render.fontAssetId)fail('FONT_REQUIRED','Explicit registered font required');ids.add(settings.render.fontAssetId);
  for(const id of ids)await assetId(id);
  const seen=new Set();
  const segment=async seg=>{
    const key=canonicalHash(seg);if(seen.has(key))return;seen.add(key);
    await registered(seg.path);
    if(seg.alignment){const a=await assetId(seg.alignment.assetId,true),doc=JSON.parse(await readFile(await projectMediaPath(root,a.path)));if(doc.transform?.sourceAlignmentAssetId)await assetId(doc.transform.sourceAlignmentAssetId,true);}
    if(seg.derivation){const base=JSON.parse(await registered(seg.derivation.sourceCachePath,undefined,true));await segment(base.segment);}
  };
  for(const seg of segments)await segment(seg);
  // Current per-sentence cache manifests are optional for legacy narration, but when
  // present bind the exact segment; derived base caches above are mandatory.
  const {speechKey}=await import('./core/jobs.mjs');
  for(const sentence of project.scenes.flatMap(s=>s.sentences)){
    const path=`audio/cache/${speechKey(sentence,project.settings.voices?.[sentence.voiceId])}.json`;
    if(project.assets.some(a=>a.path===path)){const cache=JSON.parse(await registered(path,undefined,true));const current=segments.find(s=>s.sentenceId===sentence.id);if(!equal(cache.segment,current))fail('AUDIO_STALE','Current cache and segment differ');await segment(cache.segment);}
  }
  for(const path of workflowPaths){
    const doc=JSON.parse(await registered(path,undefined,true));await registered(path,doc.sourceId,true);
    for(const s of doc.segments){
      await assetId(s.videoAssetId);await registered(s.video,doc.sourceId);await registered(s.timing,doc.sourceId,true);
      for(const event of s.events){const e=JSON.parse(await registered(event.evidence,doc.sourceId,true));
        for(const p of [e.video,e.before?.screenshot,e.after?.screenshot])await registered(p,doc.sourceId);
        for(const p of [e.capture,e.before?.dom,e.after?.dom])await registered(p,doc.sourceId,true);
      }
    }
  }
  const segmentBytes=await readFile(await projectMediaPath(root,'audio/segments.json'));
  if(!equal(JSON.parse(segmentBytes),segments))fail('AUDIO_STALE','Segment document changed');
  files.set('audio/segments.json',{path:'audio/segments.json',sha256:sha256(segmentBytes),size:segmentBytes.length,structuredJson:true});
  if(fontLicense){
    const f=exportSettings(project).fontLicense,asset=project.assets.find(a=>a.id===settings.render.fontAssetId);
    if(!f||f.fontAssetId!==asset.id||f.fontSha256!==asset.sha256)fail('FONT_LICENSE_REQUIRED','Explicit license/provenance must bind the actual render font');
    await add(f.license);const provenance=JSON.parse(await add(f.provenance,true));
    if(!Array.isArray(provenance.files)||!provenance.files.some(x=>x.sha256===asset.sha256)||!provenance.files.some(x=>x.sha256===f.license.sha256))fail('FONT_LICENSE_REQUIRED','Provenance must identify exact font and license SHA256');
  }
  return [...files.values()];
}

/** Path-independent timeline identity; private bundle hash/path is not evidence. */
function semantic(t){return {fps:t.fps,durationInFrames:t.durationInFrames,scenes:t.scenes,audio:t.audio.map(({path,...a})=>a),captions:t.captions};}
async function command(runtime,executable,args,name){
  const r=await runProcess(executable,args,{timeoutMs:runtime.timeoutMs??120000});
  if(r.code!==0)fail(r.timedOut?'PROVIDER_TIMEOUT':'OUTPUT_INVALID',`${name} failed: ${r.stderr.slice(-1200)}`);return r;
}
function parseSrt(text){
  if(!text.trim())return [];
  const stamp=s=>{const m=s.match(/^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/);if(!m)fail('CAPTIONS_INVALID','Invalid SRT timestamp');return (+m[1]*3600 + +m[2]*60 + +m[3])*1000 + +m[4];};
  return text.trim().replace(/\r/g,'').split(/\n\s*\n/).map((block,i)=>{const lines=block.split('\n'),time=lines[1]?.split(' --> ');if(lines[0]!==String(i+1)||time?.length!==2)fail('CAPTIONS_INVALID','Invalid SRT cue');return {startMs:stamp(time[0]),endMs:stamp(time[1]),text:lines.slice(2).join('\n')};});
}

/** Inspects an exact full render and captures the dependencies for a later CAS. */
export async function inspectOutput(root,path,{runtime={},workflowPaths,target,fontLicense=false}={}){
  if(typeof path!=='string'||!path)fail('INVALID_OUTPUT_PATH','Expected an exact manifest.json or video.mp4 path');
  if(isAbsolute(path))path=relative(root,path).split('\\').join('/');
  if(!['manifest.json','video.mp4'].includes(basename(path)))fail('INVALID_OUTPUT_PATH','Expected an exact manifest.json or video.mp4 path');
  // Require the caller's actual file to exist and remain confined before normalization.
  await projectMediaPath(root,path);path=normalize(path);
  const manifestPath=basename(path)==='manifest.json'?path:join(dirname(path),'manifest.json');
  const bytes=await readFile(await projectMediaPath(root,manifestPath)),manifest=JSON.parse(bytes),project=await readProject(root);
  if(target){validateApprovalTarget(target,'final');if(target.manifestPath!==manifestPath||target.sha256!==sha256(bytes))fail('FINAL_TARGET_CHANGED','Final target manifest changed');}
  if(manifest.kind!=='full'||!equal(manifest.scope,project.scenes.map(s=>s.id)))fail('OUTPUT_STALE','Exact full render scope required');
  if(manifest.captionPolicy!==CAPTION_POLICY)fail('OUTPUT_STALE','Render again with exact sentence-span subtitles');
  if(!Array.isArray(manifest.workflowPaths)||manifest.workflowPaths.some(p=>typeof p!=='string')||new Set(manifest.workflowPaths).size!==manifest.workflowPaths.length)fail('OUTPUT_STALE','Render again to bind explicit workflow paths');
  if(project.settings.preparation?.workflowPaths!==undefined&&!equal(project.settings.preparation.workflowPaths,manifest.workflowPaths))fail('OUTPUT_STALE','Saved workflow selection differs from output');
  if(workflowPaths!==undefined&&!equal(workflowPaths,manifest.workflowPaths))fail('OUTPUT_STALE','Workflow selection differs from immutable output');
  const covers=(stage,ids)=>ids.every(id=>project.approvals.some(a=>a.stage===stage&&a.scope.includes(id)&&isCurrent(project,a)));
  if(!covers('script',manifest.scope))fail('SCRIPT_APPROVAL_REQUIRED','Current script authorization required');
  const sample=project.settings.review?.sampleSceneIds??[project.scenes[0]?.id];
  if(!Array.isArray(sample)||!sample.length||sample.some(id=>!manifest.scope.includes(id))||!covers('sample',sample))fail('SAMPLE_APPROVAL_REQUIRED','Current designated sample authorization required');
  assertRenderProject(project);
  if(manifest.sourceDigest!==renderContentKey(project,manifest.scope))fail('OUTPUT_STALE','Creative content differs from output');
  if(!runtime.ffmpeg||!runtime.ffprobe)fail('DEPENDENCY_MISSING','Configured FFmpeg and ffprobe required');
  const segments=JSON.parse(await readFile(await projectMediaPath(root,'audio/segments.json')));
  const timeline=await prepareTimeline(root,segments,{runtime,workflowPaths:manifest.workflowPaths});
  if(!equal(semantic(timeline),semantic(manifest.timeline)))fail('OUTPUT_STALE','Current audio, exact timing, captions or cues differ from output');
  const files=await projectFiles(root,project,segments,manifest.workflowPaths,{fontLicense});
  const names=['video.mp4','mix.wav','captions.srt',...(manifest.frames??[]).map(f=>f.path)];
  if(!Array.isArray(manifest.frames)||!manifest.frames.length||!Array.isArray(manifest.artifactFiles)||!equal([...names].sort(),manifest.artifactFiles.map(f=>f.path).sort())||new Set(names).size!==names.length)fail('OUTPUT_INVALID','Incomplete/duplicate artifact hash manifest');
  const directory=dirname(manifestPath);
  for(const f of manifest.artifactFiles){
    if(!/^(video\.mp4|mix\.wav|captions\.srt|frame-\d+\.png)$/.test(f.path)||! /^[a-f0-9]{64}$/.test(f.sha256)||!Number.isSafeInteger(f.size)||f.size<=0)fail('OUTPUT_INVALID','Invalid artifact descriptor');
    const p=join(directory,f.path),data=await readFile(await projectMediaPath(root,p));
    if(data.length!==f.size||sha256(data)!==f.sha256)fail('OUTPUT_INVALID',`Output bytes changed: ${f.path}`);
    files.push({...f,path:p});
  }
  files.push({path:manifestPath,sha256:sha256(bytes),size:bytes.length});
  const video=await projectMediaPath(root,join(directory,'video.mp4'));
  const probe=JSON.parse((await command(runtime,runtime.ffprobe,['-v','error','-count_frames','-show_streams','-show_format','-of','json',video],'Probe')).stdout);
  const v=probe.streams.find(s=>s.codec_type==='video'),a=probe.streams.find(s=>s.codec_type==='audio');
  const fps=v?.avg_frame_rate?.split('/').map(Number),expectedMs=timeline.durationInFrames*1000/timeline.fps;
  if(!v||!a||v.width!==project.output.width||v.height!==project.output.height||Number(v.nb_read_frames)!==timeline.durationInFrames||Math.abs(fps[0]/fps[1]-timeline.fps)>1e-6)fail('OUTPUT_INVALID','Stream geometry/fps/counted frames differ');
  const toleranceMs=Math.max(100,2000/project.output.fps),vs=Number(v.start_time)*1000,as=Number(a.start_time)*1000,vd=Number(v.duration)*1000,ad=Number(a.duration)*1000;
  if(![vs,as,vd,ad].every(Number.isFinite)||Math.max(Math.abs(vs-as),Math.abs((vs+vd)-(as+ad)),Math.abs(vd-expectedMs),Math.abs(ad-expectedMs))>toleranceMs)fail('AV_OUT_OF_SYNC','Stream start/end/duration exceeds max(100ms, 2 frames)');
  await command(runtime,runtime.ffmpeg,['-v','error','-xerror','-i',video,'-f','null','-'],'Full video decode');
  const levels=[],allSilentApproved=project.scenes.every(s=>!s.sentences.length&&s.silenceReason?.trim());
  for(const name of ['video.mp4','mix.wav']){
    const decoded=await command(runtime,runtime.ffmpeg,['-hide_banner','-nostats','-xerror','-i',await projectMediaPath(root,join(directory,name)),'-vn','-af','volumedetect','-f','null','-'],'Audio decode/levels');
    const peak=Number(decoded.stderr.match(/max_volume: (-?[\d.]+) dB/)?.[1]),mean=Number(decoded.stderr.match(/mean_volume: (-?[\d.]+) dB/)?.[1]);
    if((!Number.isFinite(mean)||mean<=-80||!Number.isFinite(peak)||peak<=-80)&&!allSilentApproved)fail('AUDIO_SILENT','Silent output has no supported explicit scene authorization');
    if(peak>=0)fail('AUDIO_CLIPPED','Output reaches digital full scale');levels.push({file:name,peakDb:peak,meanDb:mean});
  }
  const quietScenes=[];
  for(const slot of timeline.scenes){
    const scene=project.scenes.find(s=>s.id===slot.id);
    if(slot.durationMs<=0)continue;
    const decoded=await command(runtime,runtime.ffmpeg,['-hide_banner','-nostats','-xerror','-i',video,'-vn','-af',`atrim=start=${slot.startMs/1000}:duration=${slot.durationMs/1000},volumedetect`,'-f','null','-'],'Scene audio levels');
    const mean=Number(decoded.stderr.match(/mean_volume: (-?[\d.]+) dB/)?.[1]);
    if(!Number.isFinite(mean)||mean<=-80){
      if(scene.sentences.length)fail('AUDIO_SILENT',`Required narration is silent in scene ${scene.id}`);
      if(!scene.silenceReason?.trim())fail('SILENCE_REASON_REQUIRED',`Silent scene ${scene.id} needs explicit authored/reviewed intent`);
      quietScenes.push({sceneId:scene.id,reason:scene.silenceReason});
    }
  }
  const captions=parseSrt(await readFile(await projectMediaPath(root,join(directory,'captions.srt')),'utf8'));
  if(captions.length!==timeline.captions.length||captions.some((c,i)=>{const expected=timeline.captions[i];return c.startMs<0||c.endMs<=c.startMs||c.endMs>expectedMs+1000/timeline.fps||Math.abs(c.startMs-expected.startMs)>1||Math.abs(c.endMs-expected.endMs)>1||c.text.replace(/\r/g,'').trim()!==expected.text.replace(/\r/g,'').trim();}))fail('CAPTIONS_INVALID','SRT must match final caption text and exact timing');
  const checks=[check('full-decode','MP4 and mix'),check('counted-frames',timeline.durationInFrames),check('geometry',project.output),check('audio-levels',levels),check('av-sync',{toleranceMs,videoMs:vd,audioMs:ad,videoStartMs:vs,audioStartMs:as}),check('captions',captions.length),check('font',project.settings.render.fontAssetId),check('explicit-silent-scenes',quietScenes),check('current-inputs','Semantic scene/cue/caption/audio SHA/exact time/frame equality'),check('artifact-hashes',manifest.artifactFiles)];
  const snapshot={projectHash:canonicalHash(project),manifest,manifestPath,files,checks,segments};
  await verifySnapshot(root,snapshot);return snapshot;
}

/** Recheck immutable bytes and the current project immediately before publication. */
export async function verifySnapshot(root,snapshot){
  if(canonicalHash(await readProject(root))!==snapshot.projectHash)fail('OUTPUT_STALE','Project changed during output verification');
  for(const f of snapshot.files){const bytes=await readFile(await projectMediaPath(root,f.path));if(bytes.length!==f.size||sha256(bytes)!==f.sha256)fail('OUTPUT_STALE',`Reference changed during verification: ${f.path}`);}
}
export async function checkOutput(root,path,config={}){
  try{const snapshot=await inspectOutput(root,path,config);return await withProjectLock(root,async()=>{await verifySnapshot(root,snapshot);return {status:'succeeded',artifacts:[join(dirname(snapshot.manifestPath),'video.mp4')],checks:snapshot.checks,humanChecks:['visual-layout','pronunciation','knowledge-accuracy'].map(name=>({name,status:'pending',evidence:'Requires explicit human review; technical metrics do not sign this check'}))};});}
  catch(error){return failedReceipt(error);}
}
