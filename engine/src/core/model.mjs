import { createHash } from 'node:crypto';
import { assertInteraction } from '../media/interaction.mjs';
import { isAbsolute, normalize } from 'node:path';

/**
 * @typedef {'ppt'|'book'|'website'|'lesson'} Mode
 * @typedef {{sourceId:string,nodeId:string,contentHash:string}} SourceRef
 * @typedef {{id:string,kind:'page'|'paragraph'|'image'|'table'|'code'|'math'|'heading'|'link',text:string,order:number,locator:string,assetIds:string[],parentId?:string,rect?:[number,number,number,number]}} SourceNode
 * @typedef {{id:string,kind:'pptx'|'ppt'|'docx'|'doc'|'md'|'url',original:string,hash:string,archive?:{path:string,sha256:string},nodes:SourceNode[],warnings:{code:string,locator:string,detail:string}[]}} Source
 * @typedef {{id:string,path:string,sha256:string,mediaType:string,origin:{kind:'source'|'host'|'provider',reference:string,version:string}}} Asset
 * @typedef {{id:string,text:string,voiceId:string,eventId?:string,audioRate?:number}} Sentence
 * @typedef {{id:string,anchor:{kind:'sentence'|'word'|'event',id:string,edge:'start'|'end'},offsetMs:number,action:'highlight'|'reveal'|'move'|'zoom'|'compare'|'point',target:string,params:Record<string,unknown>}} Cue
 * @typedef {{id:string,refs:SourceRef[],objective:string,sentences:Sentence[],visual:{kind:'page'|'image'|'recording'|'diagram'|'component',assetIds:string[],component?:string,props:Record<string,unknown>},cues:Cue[],leadMs:number,tailMs:number,silenceReason?:string,requiredEvents?:{id:string,captureId:string,sourceId:string,videoAssetId:string,startMs:number,endMs:number,evidence:string}[]}} Scene
 * @typedef {{id:string,stage:'script'|'sample'|'final',scope:string[],digest:string,decision:'approved'|'waived',evidence:string,target?:{kind:'render',manifestPath:string,sha256:string}}} Approval
 * @typedef {{id:string,kind:string,sceneIds:string[],key:string,state:'pending'|'running'|'succeeded'|'failed'|'needs_input',inputs:string[],outputs:string[],owner?:{pid:number,token:string},sentenceId?:string,request?:{kind:'sample'|'full',sceneIds?:string[]},workflowPaths?:string[],manifestPath?:string,outputFiles?:{path:string,sha256:string,size:number}[],error?:{code:string,detail:string}}} Job
 * @typedef {{schemaVersion:1,id:string,revision:number,mode:Mode,output:{width:number,height:number,fps:number},sources:Source[],assets:Asset[],scenes:Scene[],approvals:Approval[],jobs:Job[],settings:Record<string,unknown>}} Project
 * @typedef {{id:string,available:boolean,version:string|null,reason:string|null,remedy:string|null}} Capability
 * @typedef {{sentenceId:string,path:string,sha256:string,durationMs:number,audioRate?:number,derivation?:{operation:'atempo',rate:number,sourceSha256:string,sourcePath:string,sourceCachePath:string},sourceProviderReceipt?:Record<string,unknown>,textHash?:string,voiceHash?:string,providerReceipt?:{provider:string,model:string,voice:string,language:string,status:string,requestId?:string,characters?:number,input_tokens?:number,output_tokens?:number,total_tokens?:number},alignment?:{assetId:string,unit:'ms',audioSha256:string,textHash:string,provenance:{kind:string,reference:string,version:string}},words?:{id:string,text:string,startMs:number,endMs:number}[]}} AudioSegment
 * @typedef {{id:string,startMs:number,endMs:number,evidence:string,verified?:boolean,sourceId?:string,captureId?:string,videoAssetId?:string}} Event
 * @typedef {{fps:number,projectHash:string,durationInFrames:number,scenes:{id:string,from:number,durationInFrames:number,startMs:number,durationMs:number,cues:{id:string,frame:number,atMs:number}[]}[],audio:{sentenceId:string,path:string,from:number,durationInFrames:number,startMs:number,durationMs:number,sha256:string}[],captions:{id:string,text:string,startMs:number,endMs:number}[]}} Timeline
 * @typedef {{status:'succeeded'|'failed'|'needs_input',artifacts:string[],checks:{name:string,passed:boolean,evidence:string}[],error?:{code:string,detail:string}}} Receipt
 */

const HASH = /^[0-9a-f]{64}$/;
const MODES = ['ppt', 'book', 'website', 'lesson'];
const NODE_KINDS = ['page', 'paragraph', 'image', 'table', 'code', 'math', 'heading', 'link'];
const SOURCE_KINDS = ['pptx', 'ppt', 'docx', 'doc', 'md', 'url'];
const VISUAL_KINDS = ['page', 'image', 'recording', 'diagram', 'component'];
const ACTIONS = ['highlight', 'reveal', 'move', 'zoom', 'compare', 'point'];

export function canonicalHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  throw invalid('canonical hash input must contain only JSON values');
}

/**
 * Validates a structurally coherent draft project. Sentence anchors and all
 * references already represented in the draft must resolve. Word and event
 * anchors deliberately remain semantic until audio/recording evidence exists;
 * resolveTimeline is the later render-readiness gate that resolves them to frames.
 * @param {unknown} value
 * @returns {Project}
 */
export function assertProject(value) {
  try {
    record(value, 'project');
    exact(value.schemaVersion, 1, 'schemaVersion');
    string(value.id, 'id'); integer(value.revision, 'revision', 0);
    oneOf(value.mode, MODES, 'mode');
    record(value.output, 'output');
    integer(value.output.width, 'output.width', 1, 16384);
    integer(value.output.height, 'output.height', 1, 16384);
    finite(value.output.fps, 'output.fps', 1, 240);
    array(value.sources, 'sources'); array(value.assets, 'assets'); array(value.scenes, 'scenes');
    array(value.approvals, 'approvals'); array(value.jobs, 'jobs'); record(value.settings, 'settings');
    if (value.settings.preparation !== undefined) {
      const preparation = value.settings.preparation;
      record(preparation, 'settings.preparation');
      if (Object.keys(preparation).some(key => key !== 'workflowPaths')) fail('Unknown preparation field; only workflowPaths is saved');
      stringArray(preparation.workflowPaths, 'settings.preparation.workflowPaths');
      if (new Set(preparation.workflowPaths).size !== preparation.workflowPaths.length) fail('Duplicate preparation workflow paths');
      for (const path of preparation.workflowPaths) {
        relativePath(path, 'settings.preparation.workflowPaths');
        if (path.includes('\\') || /^[a-z]:/i.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) fail('Preparation workflow paths must be canonical project-relative paths');
      }
    }

    const assets = indexed(value.assets, validateAsset, 'assets');
    const sources = indexed(value.sources, (source, at) => validateSource(source, at, assets), 'sources');
    const scenes = indexed(value.scenes, (scene, at) => validateScene(scene, at, assets, sources), 'scenes');
    indexed(value.approvals, validateApproval, 'approvals');
    indexed(value.jobs, (job, at) => validateJob(job, at, scenes), 'jobs');
    return value;
  } catch (error) {
    if (error?.code === 'INVALID_PROJECT') throw error;
    throw invalid(error instanceof Error ? error.message : String(error));
  }
}

function validateAsset(asset, at) {
  record(asset, at); string(asset.id, `${at}.id`); relativePath(asset.path, `${at}.path`);
  hash(asset.sha256, `${at}.sha256`); string(asset.mediaType, `${at}.mediaType`); record(asset.origin, `${at}.origin`);
  oneOf(asset.origin.kind, ['source', 'host', 'provider'], `${at}.origin.kind`);
  string(asset.origin.reference, `${at}.origin.reference`); string(asset.origin.version, `${at}.origin.version`);
}

function validateSource(source, at, assets) {
  record(source, at); string(source.id, `${at}.id`); oneOf(source.kind, SOURCE_KINDS, `${at}.kind`);
  string(source.original, `${at}.original`); hash(source.hash, `${at}.hash`); array(source.nodes, `${at}.nodes`); array(source.warnings, `${at}.warnings`);
  if(source.archive!==undefined){record(source.archive,`${at}.archive`);if(Object.keys(source.archive).some(k=>!['path','sha256'].includes(k)))fail('Unknown source archive field');relativePath(source.archive.path,`${at}.archive.path`);hash(source.archive.sha256,`${at}.archive.sha256`);if(source.archive.sha256!==source.hash)fail('Archive hash must equal source hash');}
  const nodes = indexed(source.nodes, (node, nodeAt) => {
    record(node, nodeAt); string(node.id, `${nodeAt}.id`); oneOf(node.kind, NODE_KINDS, `${nodeAt}.kind`);
    string(node.text, `${nodeAt}.text`, true); integer(node.order, `${nodeAt}.order`, 0); string(node.locator, `${nodeAt}.locator`);
    stringArray(node.assetIds, `${nodeAt}.assetIds`); references(node.assetIds, assets, `${nodeAt}.assetIds`);
    if (node.parentId !== undefined) string(node.parentId, `${nodeAt}.parentId`);
    if (node.rect !== undefined) {
      array(node.rect, `${nodeAt}.rect`); exact(node.rect.length, 4, `${nodeAt}.rect.length`);
      node.rect.forEach((part, index) => finite(part, `${nodeAt}.rect[${index}]`));
    }
  }, `${at}.nodes`);
  for (const [index, node] of source.nodes.entries()) if (node.parentId !== undefined && !nodes.has(node.parentId)) fail(`${at}.nodes[${index}].parentId does not resolve`);
  source.warnings.forEach((warning, index) => {
    const warningAt = `${at}.warnings[${index}]`; record(warning, warningAt);
    string(warning.code, `${warningAt}.code`); string(warning.locator, `${warningAt}.locator`, true); string(warning.detail, `${warningAt}.detail`, true);
  });
}

function validateScene(scene, at, assets, sources) {
  record(scene, at); string(scene.id, `${at}.id`); string(scene.objective, `${at}.objective`, true);
  array(scene.refs, `${at}.refs`); array(scene.sentences, `${at}.sentences`); array(scene.cues, `${at}.cues`);
  finite(scene.leadMs, `${at}.leadMs`, 0); finite(scene.tailMs, `${at}.tailMs`, 0);
  if(scene.silenceReason!==undefined){string(scene.silenceReason,`${at}.silenceReason`);if(!scene.silenceReason.trim()||scene.silenceReason.length>2000||scene.sentences.length)fail('silenceReason is only valid for an explicitly unspoken scene');}
  if(scene.requiredEvents!==undefined){
    array(scene.requiredEvents,`${at}.requiredEvents`);
    const events=indexed(scene.requiredEvents,(event,eventAt)=>{
      record(event,eventAt);
      if(Object.keys(event).some(k=>!['id','captureId','sourceId','videoAssetId','startMs','endMs','evidence','interaction'].includes(k)))fail('Unknown required event field');
      for(const key of ['id','captureId','sourceId','videoAssetId'])string(event[key],`${eventAt}.${key}`);
      relativePath(event.evidence,`${eventAt}.evidence`);finite(event.startMs,`${eventAt}.startMs`,0);finite(event.endMs,`${eventAt}.endMs`,event.startMs);
      if(event.interaction!==undefined)assertInteraction(event.interaction,event.startMs,event.endMs);
      if(!sources.has(event.sourceId)||!assets.has(event.videoAssetId))fail('Required event source/video must resolve');
    },`${at}.requiredEvents`);
    for(const sentence of scene.sentences)if(!events.has(sentence.eventId))fail('Every bound narration sentence must name a required event');
  }
  const sentences = indexed(scene.sentences, (sentence, sentenceAt) => {
    record(sentence, sentenceAt); string(sentence.id, `${sentenceAt}.id`); string(sentence.text, `${sentenceAt}.text`, true); string(sentence.voiceId, `${sentenceAt}.voiceId`);
    if(sentence.eventId!==undefined)string(sentence.eventId,`${sentenceAt}.eventId`);
    if(sentence.audioRate!==undefined)finite(sentence.audioRate,`${sentenceAt}.audioRate`,0.5,2);
  }, `${at}.sentences`);
  scene.refs.forEach((ref, index) => {
    const refAt = `${at}.refs[${index}]`; record(ref, refAt); string(ref.sourceId, `${refAt}.sourceId`); string(ref.nodeId, `${refAt}.nodeId`); hash(ref.contentHash, `${refAt}.contentHash`);
    const source = sources.get(ref.sourceId); if (!source) fail(`${refAt}.sourceId does not resolve`);
    const node = source.nodes.find(({ id }) => id === ref.nodeId); if (!node) fail(`${refAt}.nodeId does not resolve`);
    if (canonicalHash(node) !== ref.contentHash) fail(`${refAt}.contentHash does not match node content`);
  });
  record(scene.visual, `${at}.visual`); oneOf(scene.visual.kind, VISUAL_KINDS, `${at}.visual.kind`);
  stringArray(scene.visual.assetIds, `${at}.visual.assetIds`); references(scene.visual.assetIds, assets, `${at}.visual.assetIds`);
  if (scene.visual.component !== undefined) string(scene.visual.component, `${at}.visual.component`);
  record(scene.visual.props, `${at}.visual.props`);
  indexed(scene.cues, (cue, cueAt) => {
    record(cue, cueAt); string(cue.id, `${cueAt}.id`); record(cue.anchor, `${cueAt}.anchor`);
    oneOf(cue.anchor.kind, ['sentence', 'word', 'event'], `${cueAt}.anchor.kind`); string(cue.anchor.id, `${cueAt}.anchor.id`);
    oneOf(cue.anchor.edge, ['start', 'end'], `${cueAt}.anchor.edge`); finite(cue.offsetMs, `${cueAt}.offsetMs`);
    oneOf(cue.action, ACTIONS, `${cueAt}.action`); string(cue.target, `${cueAt}.target`); record(cue.params, `${cueAt}.params`);
    if (cue.anchor.kind === 'sentence' && !sentences.has(cue.anchor.id)) fail(`${cueAt}.anchor.id does not resolve`);
  }, `${at}.cues`);
}

function validateApproval(approval, at) {
  record(approval, at); string(approval.id, `${at}.id`); oneOf(approval.stage, ['script', 'sample', 'final'], `${at}.stage`);
  stringArray(approval.scope, `${at}.scope`); string(approval.digest, `${at}.digest`); oneOf(approval.decision, ['approved', 'waived'], `${at}.decision`); string(approval.evidence, `${at}.evidence`);
  if(approval.target!==undefined)validateApprovalTarget(approval.target,approval.stage);
}

function validateJob(job, at, scenes) {
  record(job, at); string(job.id, `${at}.id`); string(job.kind, `${at}.kind`); stringArray(job.sceneIds, `${at}.sceneIds`); references(job.sceneIds, scenes, `${at}.sceneIds`);
  string(job.key, `${at}.key`); oneOf(job.state, ['pending', 'running', 'succeeded', 'failed', 'needs_input'], `${at}.state`);
  stringArray(job.inputs, `${at}.inputs`); stringArray(job.outputs, `${at}.outputs`);
  if(job.sentenceId!==undefined)string(job.sentenceId,`${at}.sentenceId`);
  if(job.workflowPaths!==undefined){stringArray(job.workflowPaths,`${at}.workflowPaths`);job.workflowPaths.forEach(path=>relativePath(path,`${at}.workflowPaths`));}
  if(job.manifestPath!==undefined)relativePath(job.manifestPath,`${at}.manifestPath`);
  if(job.outputFiles!==undefined){array(job.outputFiles,`${at}.outputFiles`);for(const file of job.outputFiles){record(file,`${at}.outputFiles`);relativePath(file.path,`${at}.outputFiles.path`);hash(file.sha256,`${at}.outputFiles.sha256`);integer(file.size,`${at}.outputFiles.size`,0);}}
  if(job.owner!==undefined){record(job.owner,`${at}.owner`);integer(job.owner.pid,`${at}.owner.pid`,1);string(job.owner.token,`${at}.owner.token`);}
  if (job.error !== undefined) { record(job.error, `${at}.error`); string(job.error.code, `${at}.error.code`); string(job.error.detail, `${at}.error.detail`, true); }
}

function indexed(items, validator, at) {
  const result = new Map();
  items.forEach((item, index) => {
    validator(item, `${at}[${index}]`);
    if (result.has(item.id)) fail(`${at} contains duplicate id ${item.id}`);
    result.set(item.id, item);
  });
  return result;
}
function references(ids, index, at) { ids.forEach((id) => { if (!index.has(id)) fail(`${at} contains unresolved id ${id}`); }); }
function relativePath(value, at) { string(value, at); if (isAbsolute(value) || normalize(value).split(/[\\/]/).includes('..')) fail(`${at} must be a relative project path`); }
function stringArray(value, at) { array(value, at); value.forEach((part, index) => string(part, `${at}[${index}]`)); }
function record(value, at) { if (!isRecord(value)) fail(`${at} must be an object`); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function array(value, at) { if (!Array.isArray(value)) fail(`${at} must be an array`); }
function string(value, at, empty = false) { if (typeof value !== 'string' || (!empty && value.length === 0)) fail(`${at} must be ${empty ? 'a string' : 'a non-empty string'}`); }
function hash(value, at) { if (typeof value !== 'string' || !HASH.test(value)) fail(`${at} must be a lowercase SHA-256 hash`); }
function finite(value, at, min = -Infinity, max = Infinity) { if (!Number.isFinite(value) || value < min || value > max) fail(`${at} is out of bounds`); }
function integer(value, at, min = -Infinity, max = Infinity) { if (!Number.isInteger(value) || value < min || value > max) fail(`${at} is out of bounds`); }
function oneOf(value, choices, at) { if (!choices.includes(value)) fail(`${at} is invalid`); }
function exact(value, expected, at) { if (value !== expected) fail(`${at} must equal ${expected}`); }
function fail(message) { throw invalid(message); }
function invalid(message) { return Object.assign(new TypeError(`Invalid project: ${message}`), { code: 'INVALID_PROJECT' }); }

/** Optional immutable output identity; historical untargeted approvals remain readable. */
export function validateApprovalTarget(target,stage) {
  record(target,'target');
  if(stage!=='final'||Object.keys(target).some(k=>!['kind','manifestPath','sha256'].includes(k)))fail('target is only supported for final render approval');
  exact(target.kind,'render','target.kind'); relativePath(target.manifestPath,'target.manifestPath');
  if(target.manifestPath.split(/[\\/]/).includes('..')||!/^renders\/[a-zA-Z0-9_-]+\/manifest\.json$/.test(target.manifestPath))fail('target must name a render manifest');
  hash(target.sha256,'target.sha256'); return target;
}

/** Dedicated redistribution proof, separate from render appearance settings. */
export function exportSettings(project) {
  const settings=project.settings.export;
  if(settings===undefined)return {};
  record(settings,'settings.export');
  if(Object.keys(settings).some(k=>k!=='fontLicense'))fail('Unknown export setting');
  const font=settings.fontLicense;record(font,'fontLicense');
  if(Object.keys(font).some(k=>!['fontAssetId','fontSha256','license','provenance'].includes(k)))fail('Unknown font license field');
  string(font.fontAssetId,'fontAssetId');hash(font.fontSha256,'fontSha256');
  for(const key of ['license','provenance']){record(font[key],key);if(Object.keys(font[key]).some(k=>!['path','sha256'].includes(k)))fail('Unknown license file field');relativePath(font[key].path,key);if(font[key].path.split(/[\\/]/).includes('..'))fail('License path escapes project');hash(font[key].sha256,key);}
  if(new Set([font.fontSha256,font.license.sha256,font.provenance.sha256]).size!==3)fail('Font, license and provenance must be distinct files');
  return {fontLicense:font};
}
