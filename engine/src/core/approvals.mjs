import {assertModePlan} from './readiness.mjs';
import {join} from 'node:path';
import {componentSettings} from '../render/components-schema.mjs';
import { renderSettings } from '../render/schema.mjs';
import { audioSettings } from '../media/audio.mjs';
import { bookSettings } from '../modes/book.mjs';
import { randomUUID } from 'node:crypto';
import { assertProject, canonicalHash, validateApprovalTarget, exportSettings } from './model.mjs';
import { readProject, saveProject, withProjectLock, atomicWriteFile } from './store.mjs';

const STAGES = ['script', 'sample', 'final'];

/** Replaces the host-authored draft plan, keeping approvals only while their content still matches. */
export async function applyPlan(root, { scenes, settings }, expectedRevision) {
  const project = await readProject(root);
  const next = assertProject({ ...project, scenes, settings });
  // Validate consumed settings even when there are no existing approvals.
  for (const scene of scenes) approvalSettings(next, 'script', [scene.id]);
  assertModePlan(next,{draft:true});
  next.approvals = next.approvals.filter(approval => isCurrent(next, approval));
  return saveProject(root, next, expectedRevision);
}

/** Records only explicit caller authorization. Content and expected revision are checked before persistence. */
export async function approve(root, { stage, scope, decision, evidence, digest, target }, config={}) {
  const project = await readProject(root);
  assertModePlan(project);
  const selected = selectScenes(project, stage, scope);
  if (!['approved', 'waived'].includes(decision) || typeof evidence !== 'string' || !evidence.trim()) {
    throw invalidApproval('decision 与非空授权 evidence 必须明确提供');
  }
  if (digest !== approvalDigest(project, stage, scope, target)) {
    throw Object.assign(new Error('确认对应的内容已经变化'), { code: 'APPROVAL_STALE' });
  }
  const approval = { id: randomUUID(), stage, scope: selected.map(s => s.id), digest, decision, evidence, ...(target?{target:structuredClone(target)}:{}) };
  if(target){
    const {inspectOutput,verifySnapshot}=await import('../quality.mjs');
    const snapshot=await inspectOutput(root,target.manifestPath,{...config,target});
    if(canonicalHash(selected.map(s=>s.id))!==canonicalHash(snapshot.manifest.scope))throw invalidApproval('Final scope must cover the entire targeted full render');
    return withProjectLock(root,async()=>{
      await verifySnapshot(root,snapshot);
      const current=await readProject(root);
      if(current.revision!==project.revision||approvalDigest(current,stage,scope,target)!==digest)throw Object.assign(new Error('Project changed before final approval'),{code:'APPROVAL_STALE'});
      const next=assertProject({...current,revision:current.revision+1,approvals:[...current.approvals,approval]});
      await atomicWriteFile(join(root,'project.json'),JSON.stringify(next,null,2));return next;
    });
  }
  return saveProject(root, { ...project, approvals: [...project.approvals, approval] }, project.revision);
}

/**
 * Hashes ordered scoped creative content, resolved source nodes and referenced
 * asset versions. Never hash revisions, jobs or unreferenced generated media.
 * script approves storyboard intent; sample/final also bind output geometry.
 */
export function approvalDigest(project, stage, scope, target) {
  if(target!==undefined){try{validateApprovalTarget(target,stage);}catch(error){throw invalidApproval(error.message);}}
  assertProject(project);
  const scenes = selectScenes(project, stage, scope);
  const settings = approvalSettings(project, stage, scope);
  const sources = scenes.flatMap(scene => scene.refs.map(ref => {
    const source = project.sources.find(s => s.id === ref.sourceId);
    return { sourceId: source.id, kind: source.kind, original: source.original, hash:source.hash, node: source.nodes.find(n => n.id === ref.nodeId) };
  }));
  const assetIds = new Set([...scenes.flatMap(s => s.visual.assetIds), ...sources.flatMap(s => s.node.assetIds)]);
  for (const cast of settings.book?.cast ?? []) for (const id of cast.referenceAssetIds) assetIds.add(id);
  for (const continuity of settings.book?.continuity ?? []) for (const id of continuity.propAssetIds) assetIds.add(id);
  for (const continuity of settings.book?.continuity ?? []) for (const id of [...(continuity.review?.assetIds ?? []), ...(continuity.review?.referenceAssetIds ?? [])]) assetIds.add(id);
  for (const track of [...(settings.audio?.music ?? []), ...(settings.audio?.sfx ?? [])]) assetIds.add(track.assetId);
  for (const d of settings.components ?? []) for (const f of d.files) assetIds.add(f.assetId);
  if (settings.render?.fontAssetId) assetIds.add(settings.render.fontAssetId);
  const assets = [...assetIds].sort().map(id => {
    const asset = project.assets.find(a => a.id === id);
    if (!asset) throw settingsError(`asset ${id} does not resolve`);
    return asset;
  });
  return canonicalHash({ schema: 'scoped-approval-v1', projectId: project.id, mode: project.mode, stage,
    scenes, sources, assets, settings, ...(target?{target}:{}), ...(stage === 'script' ? {} : { output: project.output }) });
}

/**
 * Single extension point for settings actually consumed by media/mode modules.
 * Reads actual values, never a copied digest-input object. voices is a map from
 * voiceId to provider configuration. Book/lesson shapes follow their mode contracts.
 * Future audio/mix/render consumers MUST extend this projection and mutation tests
 * when adding settings; unconsumed metadata is intentionally not an approval input.
 * stage is available for future settings that affect only sample/final output.
 */
export function approvalSettings(project, stage, scope) {
  const scenes = selectScenes(project, stage, scope);
  const sceneIds = new Set(scenes.map(s => s.id));
  const sentenceIds = new Set(scenes.flatMap(s => s.sentences.map(line => line.id)));
  const voiceIds = new Set(scenes.flatMap(s => s.sentences.map(line => line.voiceId)));
  const settings = {};
  const components = componentSettings(project, scope);
  if (components.length) settings.components = components;
  if (project.mode === 'book' && project.settings.book !== undefined) {
    let book;
    try { book = bookSettings(project); } catch (error) { throw settingsError(error.message); }
    const turns = book.turns.filter(t => sentenceIds.has(t.sentenceId));
    const continuity = book.continuity.filter(c => sceneIds.has(c.sceneId));
    const characters = new Set([...turns.map(t => t.speakerId), ...continuity.flatMap(c => c.characterIds)]);
    const cast = book.cast.filter(c => characters.has(c.id));
    for (const character of cast) voiceIds.add(character.voiceId);
    if (cast.length || turns.length || continuity.length) settings.book = { cast, turns, continuity };
  }
  if (project.mode === 'lesson' && project.settings.lesson !== undefined) {
    const lesson = project.settings.lesson;
    requireObject(lesson, 'lesson'); requireArray(lesson.objectives, 'lesson.objectives'); requireArray(lesson.invariants, 'lesson.invariants');
    for (const item of lesson.objectives) { requireObject(item, 'lesson.objectives entry'); requireString(item.id); requireString(item.text); requireStrings(item.sceneIds); }
    for (const item of lesson.invariants) { requireObject(item, 'lesson.invariants entry'); for (const key of ['id', 'component', 'check', 'evidence']) requireString(item[key]); }
    const components = new Set(scenes.map(s => s.visual.component).filter(Boolean));
    const selectedLesson = {
      objectives: lesson.objectives.filter(o => o.sceneIds.some(id => sceneIds.has(id))).map(o => ({ ...o, sceneIds: o.sceneIds.filter(id => sceneIds.has(id)) })),
      invariants: lesson.invariants.filter(i => components.has(i.component)),
    };
    if (selectedLesson.objectives.length || selectedLesson.invariants.length) settings.lesson = selectedLesson;
  }
  if (project.settings.voices !== undefined) {
    requireObject(project.settings.voices, 'voices');
    const voices = Object.fromEntries([...voiceIds].sort().filter(id => Object.hasOwn(project.settings.voices, id)).map(id => [id, project.settings.voices[id]]));
    if (Object.keys(voices).length) settings.voices = voices;
  }
  // Absent containers and containers with no selected entries mean the same
  // thing for this scope; adding the first unrelated entry must not revoke it.
  settings.audio = audioSettings(project, scope);
  if(stage !== 'script') settings.render = renderSettings(project);
  if(stage==='final'&&project.settings.export!==undefined)settings.export=exportSettings(project);
  canonicalHash(settings); // Reject non-JSON settings before any file write.
  return settings;
}

export function isCurrent(project, approval) {
  try { return ['approved', 'waived'].includes(approval.decision) && Boolean(approval.evidence?.trim()) && approval.digest === approvalDigest(project, approval.stage, approval.scope, approval.target); }
  catch (error) { if (['INVALID_APPROVAL', 'INVALID_PROJECT', 'INVALID_APPROVAL_SETTINGS', 'INVALID_RENDER_SCHEMA', 'COMPONENT_REVIEW_REQUIRED'].includes(error.code)) return false; throw error; }
}

function selectScenes(project, stage, scope) {
  if (!STAGES.includes(stage) || !Array.isArray(scope) || !scope.length || scope.some(id => typeof id !== 'string' || !id) || new Set(scope).size !== scope.length) throw invalidApproval('stage 或 scope 无效');
  const selected = project.scenes.filter(scene => scope.includes(scene.id));
  if (selected.length !== scope.length) throw invalidApproval('scope 场景不存在');
  return selected;
}
function requireObject(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw settingsError(`${name} must be an object`); }
function requireArray(value, name) { if (!Array.isArray(value)) throw settingsError(`${name} must be an array`); }
function requireString(value) { if (typeof value !== 'string' || !value) throw settingsError('expected nonempty string'); }
function requireStrings(value) { requireArray(value, 'IDs'); value.forEach(requireString); }
function settingsError(message) { return Object.assign(new TypeError(message), { code: 'INVALID_APPROVAL_SETTINGS' }); }
function invalidApproval(message) { return Object.assign(new TypeError(message), { code: 'INVALID_APPROVAL' }); }
