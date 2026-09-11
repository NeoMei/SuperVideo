import {assertProject,canonicalHash} from '../core/model.mjs';
import {assertRenderProject} from '../render/schema.mjs';
import {validateVoice} from '../providers/tts.mjs';

const fail=(detail,code='INVALID_BOOK_PLAN')=>{throw Object.assign(new Error(detail),{code});};
const string=value=>{if(typeof value!=='string'||!value.trim())fail('Expected nonempty book text or ID');};
const fields=(value,allowed)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))fail('Unknown or invalid book fields');};
const array=value=>{if(!Array.isArray(value))fail('Expected a book list');};
const ids=value=>{array(value);value.forEach(string);if(new Set(value).size!==value.length)fail('Duplicate book IDs');};
const unique=(items,key)=>{if(new Set(items.map(x=>x[key])).size!==items.length)fail(`Duplicate ${key}`);};

/** Shared schema for actual book settings. Review is host visual evidence, never
 * an authorization or a hash-based assertion of character identity. */
export function bookSettings(project){
 const b=project.settings.book;fields(b,['cast','turns','continuity']);
 for(const key of ['cast','turns','continuity'])array(b[key]);
 for(const c of b.cast){fields(c,['id','name','referenceAssetIds','voiceId']);[c.id,c.name,c.voiceId].forEach(string);ids(c.referenceAssetIds);}
 for(const t of b.turns){fields(t,['sentenceId','speakerId']);[t.sentenceId,t.speakerId].forEach(string);}
 for(const c of b.continuity){
  fields(c,['sceneId','characterIds','propAssetIds','review']);string(c.sceneId);ids(c.characterIds);ids(c.propAssetIds);
  if(c.review!==undefined){const r=c.review;fields(r,['assetIds','referenceAssetIds','evidence','conflicts']);ids(r.assetIds);ids(r.referenceAssetIds);string(r.evidence);array(r.conflicts);r.conflicts.forEach(string);}
 }
 return b;
}

/** Small deterministic host-plan mapper. A sentence supplies id/text/speakerId/
 * sourceNodeId. The resulting refs are positional: exactly one textual SourceRef
 * per sentence, in narration order; repeated refs permit several excerpts of one
 * paragraph. Host remains responsible for paraphrase accuracy and source coverage.
 * No input extension, image generator, TTS or rendering backend is selected here.
 * Returns {scenes,book}; caller applies these alongside settings.voices.
 */
export function buildBookScenes(project,request){
 assertProject(project);fields(request,['cast','scenes']);array(request.cast);array(request.scenes);
 const cast=structuredClone(request.cast),voiceByCharacter=new Map(cast.map(c=>[c.id,c.voiceId]));
 const turns=[],continuity=[];
 const scenes=request.scenes.map(plan=>{
  fields(plan,['id','sourceId','objective','sentences','assetId','characterIds','propAssetIds','review','targets','cues','leadMs','tailMs']);array(plan.sentences);
  const source=project.sources.find(s=>s.id===plan.sourceId);if(!source)fail('Book source does not resolve','BOOK_SOURCE_MAPPING');
  const refs=[];
  const sentences=plan.sentences.map(line=>{
   fields(line,['id','text','speakerId','sourceNodeId']);
   const voiceId=voiceByCharacter.get(line.speakerId);if(!voiceId)fail(`Map speaker ${line.speakerId} to a cast voice`,'SPEAKER_UNMAPPED');
   const node=source.nodes.find(n=>n.id===line.sourceNodeId);if(!node)fail('Sentence source node does not resolve','BOOK_SOURCE_MAPPING');
   refs.push({sourceId:source.id,nodeId:node.id,contentHash:canonicalHash(node)});turns.push({sentenceId:line.id,speakerId:line.speakerId});
   return {id:line.id,text:line.text,voiceId};
  });
  continuity.push({sceneId:plan.id,characterIds:structuredClone(plan.characterIds),propAssetIds:structuredClone(plan.propAssetIds),...(plan.review===undefined?{}:{review:structuredClone(plan.review)})});
  return {id:plan.id,objective:plan.objective,refs,sentences,visual:{kind:'image',assetIds:[plan.assetId],props:plan.targets===undefined?{}:{targets:structuredClone(plan.targets)}},cues:structuredClone(plan.cues??[]),leadMs:plan.leadMs??150,tailMs:plan.tailMs??450};
 });
 const b={cast,turns,continuity};
 const receipt=validateBookPlan({...project,scenes,settings:{...project.settings,book:b}});
 if(receipt.status!=='succeeded')fail(receipt.error.detail,receipt.error.code);
 return {scenes,book:b};
}

/** Structural narrative and declared comparative-review validation. Successful
 * receipt is not real speech, subjective listening, or rendered-video acceptance.
 * Narrator has an explicit cast/turn just like dialogue, with no visible reference
 * required unless continuity says that role is on screen.
 * @returns {import('../core/model.mjs').Receipt}
 */
export function validateBookPlan(project){
 try{
  assertProject(project);assertRenderProject(project);
  if(project.mode!=='book'||!project.scenes.length)fail('Book requires planned scenes');
  const b=bookSettings(project);unique(b.cast,'id');unique(b.continuity,'sceneId');
  const cast=new Map(b.cast.map(c=>[c.id,c]));
  const character=id=>{const c=cast.get(id);if(!c)fail(`Map speaker/character ${id} to the cast`,'SPEAKER_UNMAPPED');return c;};
  const image=id=>{const a=project.assets.find(a=>a.id===id);if(!a?.mediaType.startsWith('image/'))fail(`Book image asset ${id} does not resolve`,'BOOK_ASSET_UNRESOLVED');return a;};
  for(const c of b.cast){validateVoice(project.settings.voices?.[c.voiceId]);c.referenceAssetIds.forEach(image);}
  const all=project.scenes.flatMap(s=>s.sentences),sentenceIds=all.map(s=>s.id);
  if(new Set(sentenceIds).size!==sentenceIds.length||b.turns.length!==all.length||new Set(b.turns.map(t=>t.sentenceId)).size!==all.length||b.turns.some(t=>!sentenceIds.includes(t.sentenceId)))fail('Exactly one turn must map every project sentence','BOOK_TURN_COVERAGE');
  for(const [i,t]of b.turns.entries()){
   const c=character(t.speakerId);
   if(t.sentenceId!==all[i].id)fail('Turns must follow the spoken sentence order','BOOK_TURN_ORDER');
   if(c.voiceId!==all[i].voiceId)fail(`Sentence ${t.sentenceId} must use ${c.id} voice ${c.voiceId}; rebuild the role mapping`,'BOOK_VOICE_MISMATCH');
  }
  if(b.continuity.length!==project.scenes.length||b.continuity.some(c=>!project.scenes.some(s=>s.id===c.sceneId)))fail('One continuity record is required per scene','BOOK_CONTINUITY_REQUIRED');
  const last=new Map();let reviews=0;
  for(const scene of project.scenes){
   if(!scene.sentences.length||scene.sentences.some(s=>!s.text.trim())||scene.refs.length!==scene.sentences.length)fail('Provide one ordered textual source reference per spoken sentence','BOOK_SOURCE_MAPPING');
   for(const ref of scene.refs){
    const node=project.sources.find(s=>s.id===ref.sourceId).nodes.find(n=>n.id===ref.nodeId);
    if(!['paragraph','heading','table','code','math'].includes(node.kind)||!node.text.trim())fail('Narration must reference textual source nodes','BOOK_SOURCE_MAPPING');
    if(node.order<(last.get(ref.sourceId)??-1))fail('Book narration must preserve original source order','BOOK_SOURCE_ORDER');
    last.set(ref.sourceId,node.order);
   }
   if(!['image','page'].includes(scene.visual.kind))fail('Book scenes require contained illustration images');
   const assets=scene.visual.assetIds.map(image),c=b.continuity.find(c=>c.sceneId===scene.id);
   const references=new Set(c.propAssetIds);c.propAssetIds.forEach(image);
   for(const id of c.characterIds){const role=character(id);if(!role.referenceAssetIds.length)fail(`Visible ${id} needs a character reference image`,'BOOK_REFERENCE_REQUIRED');role.referenceAssetIds.forEach(id=>references.add(id));}
   if(!c.review&&assets.some(a=>a.origin.kind!=='source'))fail(`Compare generated illustration for ${scene.id} with its character and prop references`,'BOOK_REVIEW_REQUIRED');
   if(c.review){
    const r=c.review;[...r.assetIds,...r.referenceAssetIds].forEach(image);
    if(r.conflicts.length)fail(`Resolve visual continuity conflicts: ${r.conflicts.join('; ')}`,'BOOK_CONTINUITY_CONFLICT');
    if(assets.some(a=>!r.assetIds.includes(a.id))||r.assetIds.some(id=>!scene.visual.assetIds.includes(id))||[...references].some(id=>!r.referenceAssetIds.includes(id)))fail('Comparative review must cover the scene illustration and all character/prop references','BOOK_REVIEW_REQUIRED');
    reviews++;
   }
   // Explicit regions locate explanatory annotations. Shared visual zoom/move
   // remains available; framing safety needs host inspection of actual pixels.
   // Animating an empty region overlay is not a subject-aware camera operation.
   for(const cue of scene.cues)if(['point','highlight'].includes(cue.action)&&!scene.visual.props.targets?.some(t=>t.id===cue.target))fail(`Cue ${cue.id} requires an explicit object region; review framing to retain the subject`,'BOOK_SUBJECT_REGION_REQUIRED');
  }
  return {status:'succeeded',artifacts:[],checks:[
   {name:'cast-voice-continuity',passed:true,evidence:`${all.length} ordered turns use explicit cast voice IDs, including narration. Actual installed voice and speech decode are checked by shared audio preparation.`},
   {name:'source-order',passed:true,evidence:'Each sentence has an ordered source node; semantic fidelity and excerpt completeness require host review.'},
   {name:'visual-continuity',passed:true,evidence:`${reviews} scene comparative reviews recorded. Source illustrations require no generation. Identity, expressions and subject framing require actual visual inspection; asset hashes alone cannot establish them.`},
  ]};
 }catch(error){return {status:'failed',artifacts:[],checks:[],error:{code:error.code??'INVALID_BOOK_PLAN',detail:error.message}};}
}
