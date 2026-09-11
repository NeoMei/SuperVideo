import {canonicalHash} from '../core/model.mjs';
import {assertInteraction} from '../media/interaction.mjs';
const fail=detail=>{throw Object.assign(new Error(detail),{code:'INVALID_WEBSITE_PLAN'});};
const keys=(v,allowed)=>{if(!v||typeof v!=='object'||Object.keys(v).some(k=>!allowed.includes(k)))fail('Unknown website plan fields');};
/** Host maps only verified recording windows. Capture clocks never share an implicit origin. */
export function buildWebsiteScenes(source,events,settings){
 keys(settings,['scenes']);if(!source?.nodes?.length||!Array.isArray(events)||new Set(events.map(e=>e.id)).size!==events.length||!Array.isArray(settings.scenes)||!settings.scenes.length)fail('Source, unique events and scenes required');
 const used=new Set();
 const scenes=settings.scenes.map(s=>{
  keys(s,['id','objective','sentences','cuts','eventIds','cues','targets','leadMs','tailMs']);
  if(!Array.isArray(s.cuts)||!s.cuts.length||!Array.isArray(s.eventIds)||!s.eventIds.length||!Array.isArray(s.sentences)||!s.sentences.length)fail('Explicit cuts, required events and sentences required');
  let end=0;
  for(const c of s.cuts){keys(c,['captureId','sourceId','videoAssetId','sourceStartMs','sourceEndMs','sceneStartMs','playbackRate']);if(!c.captureId||c.sourceId!==source.id||!c.videoAssetId||![c.sourceStartMs,c.sourceEndMs,c.sceneStartMs,c.playbackRate].every(Number.isFinite)||c.sourceStartMs<0||c.sourceEndMs<=c.sourceStartMs||c.sceneStartMs<end||c.playbackRate<=0)fail('Invalid/nonsequential cut');end=c.sceneStartMs+(c.sourceEndMs-c.sourceStartMs)/c.playbackRate;}
  for(const id of s.eventIds){const e=events.find(e=>e.id===id);if(used.has(id)||!e?.verified||!e.evidence||e.sourceId!==source.id||e.endMs<e.startMs)fail('Required action lacks unique verified result');used.add(id);const cuts=s.cuts.filter(c=>c.captureId===e.captureId&&c.sourceId===e.sourceId&&c.videoAssetId===e.videoAssetId&&c.sourceStartMs<=e.startMs&&c.sourceEndMs>=e.endMs);if(cuts.length!==1)fail('Required action and result must remain inside exactly one cut');}
  const sentences=s.sentences.map(line=>{keys(line,['id','text','voiceId','eventId']);if(!s.eventIds.includes(line.eventId))fail('Every narration claim must name a retained verified event');return structuredClone(line);});
  // Verified timing does not imply that the host has identified a screen target.
  const cues=s.cues??[];
  for(const c of cues)if(!['event','sentence'].includes(c.anchor?.kind)||(c.anchor.kind==='event'?!s.eventIds.includes(c.anchor.id):!sentences.some(l=>l.id===c.anchor.id)))fail('Cue must use retained event/sentence anchor');
  return {id:s.id,objective:s.objective,requiredEvents:s.eventIds.map(id=>eventBinding(events.find(e=>e.id===id))),refs:[{sourceId:source.id,nodeId:source.nodes[0].id,contentHash:canonicalHash(source.nodes[0])}],sentences,visual:{kind:'recording',assetIds:[...new Set(s.cuts.map(c=>c.videoAssetId))],props:{recording:{durationPolicy:'hold',cuts:structuredClone(s.cuts)},...(s.targets?{targets:structuredClone(s.targets)}:{})}},cues:structuredClone(cues),leadMs:s.leadMs??0,tailMs:s.tailMs??300};
 });
 if(events.some(e=>e.verified&&!used.has(e.id)))fail('All verified workflow actions must be retained');return scenes;
}

const eventFields=['id','captureId','sourceId','videoAssetId','startMs','endMs','evidence','interaction'];
const eventBinding=e=>{
 if(e.interaction!==undefined)assertInteraction(e.interaction,e.startMs,e.endMs);
 return Object.fromEntries(eventFields.filter(k=>e[k]!==undefined).map(k=>[k,structuredClone(e[k])]));
};
const bindingError=(code,detail)=>{throw Object.assign(new Error(detail),{code});};
/** Old drafts stay readable. Explicit claim bindings are required for website
 * recordings and opt-in recordings in other modes; pointers are independent. */
export function assertWebsiteBindings(project,verifiedEvents) {
 const used=new Set();
 for(const scene of project.scenes){
  const required=scene.requiredEvents;
  if(!(project.mode==='website'&&scene.visual.kind==='recording')&&required===undefined&&!scene.sentences.some(s=>s.eventId!==undefined))continue;
  if(!Array.isArray(required)||!required.length)bindingError('WEBSITE_BINDINGS_REQUIRED','Rebuild this legacy recording plan with real requiredEvents and sentence.eventId bindings from its verified workflow; no claims are inferred');
  if(scene.visual.kind!=='recording')bindingError('INVALID_WEBSITE_PLAN','Event-bound claims require a recording');
  const cuts=scene.visual.props.recording?.cuts??[];
  for(const event of required){
   if(!event||Object.keys(event).some(k=>!eventFields.includes(k))||eventFields.slice(0,4).some(k=>typeof event[k]!=='string'||!event[k])||typeof event.evidence!=='string'||!event.evidence||![event.startMs,event.endMs].every(v=>Number.isFinite(v)&&v>=0)||event.endMs<event.startMs||used.has(event.id))bindingError('INVALID_WEBSITE_PLAN','Required events need unique explicit capture/source/video/evidence identities and bounded windows');
   used.add(event.id);
   if(event.interaction!==undefined)assertInteraction(event.interaction,event.startMs,event.endMs);
   if(!scene.refs.some(r=>r.sourceId===event.sourceId))bindingError('INVALID_WEBSITE_PLAN','Required event source does not belong to this scene');
   const matches=cuts.filter(c=>c.captureId===event.captureId&&c.sourceId===event.sourceId&&c.videoAssetId===event.videoAssetId&&c.sourceStartMs<=event.startMs&&c.sourceEndMs>=event.endMs);
   if(matches.length!==1)bindingError(matches.length?'EVENT_MAPPING_AMBIGUOUS':'EVENT_UNMAPPED',`Required action and result ${event.id} must remain inside exactly one cut`);
   if(verifiedEvents!==undefined){
    const actual=verifiedEvents.filter(e=>e.id===event.id);
    if(actual.length!==1||actual[0].verified!==true||canonicalHash(eventBinding(actual[0]))!==canonicalHash(event))bindingError('EVENT_UNVERIFIED',`Required event ${event.id} does not match the verified workflow`);
   }
  }
  if(scene.sentences.some(s=>!required.some(e=>e.id===s.eventId)))bindingError('WEBSITE_BINDINGS_REQUIRED','Every narration claim must name its retained verified event');
 }
}
