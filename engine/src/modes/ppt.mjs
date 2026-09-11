import { assertProject, canonicalHash } from '../core/model.mjs';
import { assertRenderProject } from '../render/schema.mjs';

const fail = (detail, code = 'INVALID_PPT_PLAN') => { throw Object.assign(new Error(detail), { code }); };
const fields = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) fail('Unknown or invalid PPT plan fields');
};
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const list = value => { if (!Array.isArray(value) || !value.length) fail('Expected a nonempty plan list'); };
const narration = sentences => {
  if (!Array.isArray(sentences) || !sentences.length || sentences.some(s => !nonempty(s.text) || /^(?:Slide\s+\d+|(?:slide|rendered-page):\d+(?:\/.*)?)$/i.test(s.text.trim())))
    fail('Host must provide source-derived spoken sentences for this page; notes are optional.', 'PPT_NARRATION_REQUIRED');
};
const belongs = (node, page, source) => {
  const visited = new Set();
  while (node && !visited.has(node.id)) {
    if (node.id === page.id) return true;
    visited.add(node.id); node = source.nodes.find(n => n.id === node.parentId);
  }
  return false;
};
const pageAsset = (project, page) => page.assetIds.find(id => project.assets.find(a => a.id === id)?.mediaType.startsWith('image/'));
const uncertainGeometry = (source, node) => {
  if (source.kind === 'ppt' || source.warnings.some(w => w.code === 'LEGACY_GEOMETRY_UNVERIFIED')) return true;
  // Extraction reports transforms on the containing object/group while its
  // descendants inherit unrotated boxes. Check the whole parent chain.
  const visited = new Set();
  while (node && !visited.has(node.id)) {
    if (source.warnings.some(w => w.code === 'UNSUPPORTED_APPEARANCE' && w.locator === node.locator && /rotation|flip/i.test(w.detail))) return true;
    visited.add(node.id); node = source.nodes.find(n => n.id === node.parentId);
  }
  return false;
};

/**
 * Host authors source-derived spoken sentences; this deterministic mapper never
 * fabricates narration or requires notes, a microphone, or native slide capture.
 * pages selects an explicit subset, sorted into original source order. A page can
 * contain several segments. Each segment supplies id/objective/sourceNodeIds,
 * Sentence[] and optional leadMs/tailMs/highlights. Highlights supply id/nodeId/
 * sentenceId; an explicit normalized rect requires host geometryEvidence.
 * Targets stay SOURCE-normalized: shared Scene.tsx fits them inside the contained
 * original page for either aspect ratio. No output-frame multiplication here.
 * @returns {import('../core/model.mjs').Scene[]}
 */
export function buildPptScenes(project, request) {
  assertProject(project); fields(request, ['sourceId', 'pages']); list(request.pages);
  const source = project.sources.find(s => s.id === request.sourceId);
  if (!source) fail('Selected source does not resolve');
  const selected = request.pages.map(plan => {
    fields(plan, ['pageId', 'segments']); list(plan.segments);
    const page = source.nodes.find(n => n.id === plan.pageId && n.kind === 'page');
    if (!page) fail('Selected page does not resolve');
    return { plan, page };
  }).sort((a,b) => a.page.order - b.page.order);
  if (new Set(selected.map(s => s.page.id)).size !== selected.length) fail('Duplicate selected page');
  const scenes = selected.flatMap(({ plan, page }) => plan.segments.map(segment => {
    fields(segment, ['id','objective','sourceNodeIds','sentences','highlights','leadMs','tailMs']);
    list(segment.sourceNodeIds); narration(segment.sentences);
    const assetId = pageAsset(project, page);
    if (!assetId) fail('Original rendered page image is missing', 'PPT_PAGE_ASSET_REQUIRED');
    const nodes = [page, ...segment.sourceNodeIds.map(id => {
      const node = source.nodes.find(n => n.id === id);
      if (!node || !belongs(node, page, source)) fail('Narration source node is outside the selected page');
      return node;
    })];
    if (!nonempty(segment.id) || !nonempty(segment.objective)) fail('Segment id and objective are required');
    const sentences = segment.sentences.map(s => { fields(s, ['id','text','voiceId']); return {...s}; });
    const targets = [], cues = [];
    if (segment.highlights !== undefined && !Array.isArray(segment.highlights)) fail('highlights must be an array');
    for (const h of segment.highlights ?? []) {
      fields(h, ['id','nodeId','sentenceId','rect','geometryEvidence']);
      const node = source.nodes.find(n => n.id === h.nodeId);
      if (!nonempty(h.id) || !node || !belongs(node,page,source) || !sentences.some(s => s.id === h.sentenceId)) fail('Highlight source or sentence does not resolve within segment');
      if (h.rect !== undefined && !nonempty(h.geometryEvidence)) fail('Explicit highlight region requires visual verification evidence');
      const rect = h.rect ?? (uncertainGeometry(source,node) ? undefined : node.rect);
      // Legacy/unsupported geometry is optional: unverified highlights cannot
      // block ordinary page narration, nor silently use converted object boxes.
      if (!rect) continue;
      if (!Array.isArray(rect)) fail('Invalid highlight rectangle');
      nodes.push(node); targets.push({id:h.id,rect:[...rect]});
      cues.push({id:`${segment.id}-${h.id}`,anchor:{kind:'sentence',id:h.sentenceId,edge:'start'},offsetMs:0,action:'highlight',target:h.id,params:{}});
    }
    return {id:segment.id,objective:segment.objective,refs:[...new Map(nodes.map(n => [n.id,n])).values()].map(n => ({sourceId:source.id,nodeId:n.id,contentHash:canonicalHash(n)})),
      sentences,visual:{kind:'page',assetIds:[assetId],props:targets.length ? {targets} : {}},cues,leadMs:segment.leadMs ?? 150,tailMs:segment.tailMs ?? 250};
  }));
  const next = {...project, scenes};
  const receipt = validatePptPlan(next);
  if (receipt.status !== 'succeeded') fail(receipt.error.detail,receipt.error.code);
  return scenes;
}

/** Structural planning receipt, not audio/render proof. Scope is precisely the
 * page visuals referenced by these scenes, not all pages of all ingested sources.
 * Additional valid source refs remain supported for mixed-source explanations.
 * @returns {import('../core/model.mjs').Receipt}
 */
export function validatePptPlan(project) {
  try {
    assertProject(project); assertRenderProject(project);
    if (!project.scenes.length) fail('Host must plan at least one selected page', 'PPT_NARRATION_REQUIRED');
    const last = new Map(), selected = [], sentenceIds = new Set();
    for (const scene of project.scenes) {
      const match = scene.refs.map(ref => ({source:project.sources.find(s => s.id === ref.sourceId),ref}))
        .map(({source,ref}) => ({source,page:source.nodes.find(n => n.id === ref.nodeId)}))
        .find(({page}) => page.kind === 'page' && scene.visual.assetIds[0] === pageAsset(project,page));
      if (scene.visual.kind !== 'page' || !match) fail('PPT scene must preserve its referenced original page image');
      const {source,page} = match;
      if (page.order < (last.get(source.id) ?? -1)) fail('Page scenes must follow original source order');
      last.set(source.id,page.order); selected.push(`${source.id}#${page.locator}`);
      narration(scene.sentences);
      for (const s of scene.sentences) { if (sentenceIds.has(s.id)) fail('Sentence IDs must be unique across page segments'); sentenceIds.add(s.id); }
    }
    const warnings = project.sources.filter(s => last.has(s.id)).flatMap(s => s.warnings.filter(w => /ANIMATION|OBJECT|MEDIA|STATIC_PAGE|GEOMETRY/.test(w.code)).map(w => `${w.code} (${w.locator}): ${w.detail}`));
    return {status:'succeeded',artifacts:[],checks:[
      {name:'selected-pages',passed:true,evidence:[...new Set(selected)].join('\n')},
      {name:'source-derived-narration',passed:true,evidence:`${sentenceIds.size} host-authored sentences have source-bound scenes. Semantic accuracy remains a host review responsibility; real speech timing is prepared separately.`},
      {name:'static-page-visuals',passed:true,evidence:`Original rendered static pages; native animation/media playback is not preserved. No recording or presenter is required.\n${warnings.join('\n')}`},
    ]};
  } catch (error) {
    const code = error.code ?? 'INVALID_PPT_PLAN';
    return {status:['PPT_NARRATION_REQUIRED','PPT_PAGE_ASSET_REQUIRED'].includes(code)?'needs_input':'failed',artifacts:[],checks:[],error:{code,detail:error.message}};
  }
}
