import {access, mkdir, readFile, realpath} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ACTIONS = ['status', 'start', 'plan', 'approve', 'produce', 'revise', 'music', 'record', 'asset', 'deliver', 'resume'];
const FIELDS = {
  status: ['action'],
  start: ['action', 'mode', 'output', 'paths', 'url', 'viewport', 'voice'],
  plan: ['action', 'scenes', 'settings', 'expectedRevision'],
  approve: ['action', 'expectedRevision', 'stage', 'scope', 'decision', 'evidence', 'target'],
  produce: ['action', 'kind', 'sceneIds', 'hostReceipts', 'concurrency'],
  revise: ['action', 'expectedRevision', 'sceneId', 'field', 'value'],
  music: ['action', 'path', 'assetId', 'sceneId', 'startMs', 'durationMs', 'sourceStartMs', 'sourceEndMs', 'loop', 'volume', 'fadeInMs', 'fadeOutMs', 'ducking', 'remove', 'expectedRevision'],
  record: ['action', 'sourceId', 'steps', 'initial', 'success', 'checkpoint'],
  asset: ['action', 'path', 'origin', 'font', 'expectedRevision'],
  deliver: ['action', 'destination', 'includeSources', 'renderManifestPath'],
  resume: ['action', 'concurrency'],
};
const NEEDS_INPUT = new Set([
  'PROJECT_NOT_FOUND', 'PROJECT_LOCKED', 'LOCK_RECOVERY_REQUIRED', 'REVISION_CONFLICT', 'APPROVAL_STALE',
  'PLAN_REQUIRED', 'DEPENDENCY_MISSING', 'DEPENDENCY_VERSION_MISMATCH', 'HOST_AUDIO_REQUIRED', 'FONT_REQUIRED',
  'FONT_LICENSE_REQUIRED', 'SCRIPT_APPROVAL_REQUIRED', 'SAMPLE_APPROVAL_REQUIRED', 'FINAL_APPROVAL_REQUIRED',
  'COMPONENT_REVIEW_REQUIRED', 'LOGIN_REQUIRED', 'UNCERTAIN_ACTION', 'RESUME_STATE_CHANGED', 'INCOMPLETE_MEDIA',
  'JOB_OWNED', 'UNKNOWN_JOB', 'WORD_ALIGNMENT_REQUIRED', 'TTS_UNAVAILABLE', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND',
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code, message) => Object.assign(new Error(message), {code});
const check = (name, evidence, passed = true) => ({name, passed, evidence: typeof evidence === 'string' ? evidence : JSON.stringify(evidence)});

function parse(argv) {
  if (argv.length === 1 && argv[0] === '--help') return {help: true};
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!['--project', '--request', '--runtime'].includes(flag) || Object.hasOwn(options, flag.slice(2))) throw failure('INVALID_ARGUMENT', 'Use each of --project, --request and optional --runtime at most once');
    if (typeof value !== 'string' || !value || value.startsWith('--')) throw failure('INVALID_ARGUMENT', `${flag} requires a value`);
    options[flag.slice(2)] = value;
  }
  if (!options.project || !options.request) throw failure('INVALID_ARGUMENT', '--project and --request are required');
  return options;
}

const modulePointer = (engineRoot, relativePath) => {
  const sourcePath = join(engineRoot, ...relativePath.split('/'));
  return {sourcePath, moduleUrl: pathToFileURL(sourcePath).href};
};
const apiPointer = (engineRoot, relativePath, exportName) => ({...modulePointer(engineRoot, relativePath), export: exportName});

async function machineHelp() {
  const sourcePath = await realpath(fileURLToPath(import.meta.url)).catch(() => fileURLToPath(import.meta.url));
  const sourceDirectory = dirname(sourcePath), engineRoot = basename(sourceDirectory) === 'src' ? dirname(sourceDirectory) : sourceDirectory;
  const modes = {
    ppt: {module: modulePointer(engineRoot, 'src/modes/ppt.mjs'), builder: {export: 'buildPptScenes', input: '(Project,PptPlanRequest)', output: 'Scene[]'}, validator: {export: 'validatePptPlan', input: 'Project', output: 'Receipt'}},
    book: {module: modulePointer(engineRoot, 'src/modes/book.mjs'), builder: {export: 'buildBookScenes', input: '(Project,BookPlanRequest)', output: '{scenes:Scene[],book:BookSettings}'}, validator: {export: 'validateBookPlan', input: 'Project', output: 'Receipt'}},
    website: {module: modulePointer(engineRoot, 'src/modes/website.mjs'), builder: {export: 'buildWebsiteScenes', input: '(Source,VerifiedEvent[],WebsitePlanSettings)', output: 'Scene[]'}, validator: {export: 'assertWebsiteBindings', input: '(Project,VerifiedEvent[]?)', output: 'void|throws'}},
    lesson: {module: modulePointer(engineRoot, 'src/modes/lesson.mjs'), builder: {export: 'lessonSettings', input: '(Project,sceneId[]?)', output: 'LessonSettings'}, validator: {export: 'validateLessonPlan', input: 'Project', output: 'Receipt'}},
  };
  const schemas = {
    project: {module: modulePointer(engineRoot, 'src/core/model.mjs'), exports: ['assertProject', 'validateApprovalTarget', 'exportSettings']},
    render: {module: modulePointer(engineRoot, 'src/render/schema.mjs'), exports: ['assertRenderProject', 'renderSettings']},
    component: {module: modulePointer(engineRoot, 'src/render/components-schema.mjs'), exports: ['componentSettings', 'componentDigest']},
    voice: {module: modulePointer(engineRoot, 'src/providers/tts.mjs'), exports: ['validateVoice']},
    audio: {module: modulePointer(engineRoot, 'src/media/audio.mjs'), exports: ['audioSettings', 'prepareAudio']},
    recording: {module: modulePointer(engineRoot, 'src/media/recording.mjs'), exports: ['recordWebsite', 'recoverRecordingMedia']},
    recovery: {module: modulePointer(engineRoot, 'src/core/jobs.mjs'), exports: ['resumeJobs']},
    asset: {module: modulePointer(engineRoot, 'src/providers/assets.mjs'), exports: ['importAsset', 'projectMediaPath']},
  };
  const types = {
    SourceRef: {sourceId: 'source-id', nodeId: 'source-node-id', contentHash: 'lowercase-sha256'},
    Scene: {id: 'scene-id', objective: 'string', refs: ['SourceRef'], sentences: [{id: 'sentence-id', text: 'string', voiceId: 'voice-id', eventId: 'event-id?', audioRate: '0.5..2?'}], visual: {kind: 'page|image|recording|component|diagram', assetIds: ['asset-id'], component: 'component-id?', props: {recording: 'RecordingMap?', model: 'component-model?', targets: [{id: 'target-id', rect: ['x', 'y', 'width', 'height']}]}}, cues: [{id: 'cue-id', anchor: {kind: 'sentence|word|event', id: 'anchor-id', edge: 'start|end'}, offsetMs: 'number', action: 'highlight|reveal|move|zoom|compare|point', target: 'target-id', params: 'object'}], leadMs: 'nonnegative-number', tailMs: 'nonnegative-number'},
    VoiceSettings: {oneOf: [{provider: 'host'}, {provider: 'system', voice: 'string', rate: '80..500?'}, {provider: 'openmontage', voice: 'string', model: 'string?'}, {provider: 'bailian', voice: 'string', model: 'string', language: 'string'}]},
    ProjectSettings: {voices: {'voice-id': 'VoiceSettings'}, review: {sampleSceneIds: ['scene-id']}, render: 'RenderSettings', audio: {music: ['BgmTrack'], sfx: ['SfxTrack'], normalize: 'boolean', ducking: 'DuckingSettings'}, components: ['ComponentDescriptor'], preparation: {workflowPaths: ['project-relative workflow.json']}, book: 'BookSettings?', lesson: 'LessonSettings?'},
    RecordingRequest: {sourceId: 'source-id', initial: {role: 'string', name: 'string', text: 'string?'}, success: {role: 'string', name: 'string', text: 'string?'}, steps: [{id: 'step-id', action: 'click|fill|press|wait', role: 'string', name: 'string', value: 'string?', expected: {role: 'string', name: 'string', text: 'string?'}}], checkpoint: 'uuid?'},
    ComponentDescriptor: {id: 'component-id', entry: 'relative .tsx', model: 'relative .mjs', files: [{path: 'relative .tsx|.mjs', assetId: 'host-source-asset-id'}], checks: ['model-export-name'], review: {digest: 'current componentDigest', evidence: 'nonempty host review'}},
    AssetOrigin: {kind: 'source|host|provider', reference: 'string', version: 'string'},
    FontDescriptor: {license: {path: 'project-relative path', sha256: 'lowercase-sha256'}, provenance: {path: 'project-relative path', sha256: 'lowercase-sha256'}},
    FinalTarget: {kind: 'render', manifestPath: 'renders/<id>/manifest.json', sha256: 'lowercase-sha256 of current full manifest'},
    BgmTrack: {assetId: 'audio-asset-id', volume: '0..2', sceneId: 'scene-id?', startMs: 'nonnegative-number?', durationMs: 'positive-number?', sourceStartMs: 'nonnegative-number?', sourceEndMs: 'positive-number?', loop: 'boolean?', fadeInMs: 'nonnegative-number?', fadeOutMs: 'nonnegative-number?'},
  };
  const requestTypes = {
    status: {action: 'status'},
    start: {action: 'start', mode: 'ppt|book|website|lesson', output: {width: 'positive-integer', height: 'positive-integer', fps: 'positive-number'}, paths: ['absolute input path?'], url: 'URL?', viewport: {width: 'positive-integer', height: 'positive-integer'}, voice: 'VoiceSettings?'},
    plan: {action: 'plan', scenes: ['Scene'], settings: 'ProjectSettings', expectedRevision: 'nonnegative-safe-integer?'},
    approve: {action: 'approve', expectedRevision: 'nonnegative-safe-integer', stage: 'script|sample|final', scope: ['scene-id'], decision: 'approved|waived', evidence: 'nonempty explicit authorization', target: 'FinalTarget for final only?'},
    produce: {action: 'produce', kind: 'sample|full', sceneIds: ['sample scene-id?'], hostReceipts: {'sentence-id': 'HostAudioReceipt'}, concurrency: '1..8?'},
    revise: {action: 'revise', expectedRevision: 'nonnegative-safe-integer?', sceneId: 'scene-id', field: 'sentences|visual|cues', value: 'replacement value'},
    music: {action: 'music', path: 'absolute audio path?', assetId: 'audio-asset-id?', sceneId: 'scene-id?', startMs: 'nonnegative-number?', durationMs: 'positive-number?', sourceStartMs: 'nonnegative-number?', sourceEndMs: 'positive-number?', loop: 'boolean?', volume: '0..2?', fadeInMs: 'nonnegative-number?', fadeOutMs: 'nonnegative-number?', ducking: 'boolean?', remove: 'true? (exclusive of other music fields)', expectedRevision: 'nonnegative-safe-integer?'},
    record: {action: 'record', ...types.RecordingRequest},
    asset: {action: 'asset', path: 'absolute media path', origin: 'AssetOrigin', font: 'FontDescriptor?', expectedRevision: 'nonnegative-safe-integer?'},
    deliver: {action: 'deliver', destination: 'absolute directory', includeSources: 'boolean', renderManifestPath: 'FinalTarget.manifestPath?; use status candidate or sole exact approved render'},
    resume: {action: 'resume', concurrency: '1..8?'},
  };
  return {
    status: 'succeeded',
    artifacts: [],
    checks: [check('runtime-contract', {
      protocolVersion: 1,
      usage: 'video.mjs --project <directory> --request <json-file> [--runtime <json-file>]',
      request: '{action,...fields}',
      actions: ACTIONS,
      fields: FIELDS,
      requestTypes,
      receipts: {status: ['succeeded', 'failed', 'needs_input'], exitCodes: {succeeded: 0, failed: 1, needs_input: 2}, nextStepCheck: 'next-step'},
      descriptorFormat: 'supervideo-compact-type-v1',
      descriptorNotice: 'Structural navigation aid; authoritative validation is performed by the listed exports, not by JSON Schema.',
      engine: {rootPath: engineRoot, rootUrl: pathToFileURL(engineRoot).href, runtime: {sourcePath, moduleUrl: pathToFileURL(sourcePath).href, export: 'runRuntime'}},
      modes,
      schemas,
      types,
      finalTarget: types.FinalTarget,
      advanced: {
        doctor: apiPointer(engineRoot, 'src/providers/doctor.mjs', 'doctor'),
        project: apiPointer(engineRoot, 'src/core/store.mjs', 'readProject'),
        approvalDigest: apiPointer(engineRoot, 'src/core/approvals.mjs', 'approvalDigest'),
        audio: apiPointer(engineRoot, 'src/media/audio.mjs', 'prepareAudio'),
        recordingRecovery: apiPointer(engineRoot, 'src/media/recording.mjs', 'recoverRecordingMedia'),
        jobRecovery: apiPointer(engineRoot, 'src/core/jobs.mjs', 'resumeJobs'),
        preview: apiPointer(engineRoot, 'src/render/render.mjs', 'openPreview'),
        outputCheck: apiPointer(engineRoot, 'src/quality.mjs', 'checkOutput'),
      },
    })],
  };
}

async function readRequest(path) {
  let request;
  try { request = JSON.parse(await readFile(resolve(path), 'utf8')); }
  catch { throw failure('INVALID_REQUEST', 'Request must be a readable JSON object file'); }
  if (!object(request) || typeof request.action !== 'string' || !ACTIONS.includes(request.action)) throw failure('INVALID_ACTION', `Expected one action: ${ACTIONS.join(', ')}`);
  if (Object.keys(request).some(key => !FIELDS[request.action].includes(key))) throw failure('INVALID_REQUEST', `Unknown ${request.action} request field`);
  return request;
}

function revision(value, name = 'expectedRevision') {
  if (!Number.isSafeInteger(value) || value < 0) throw failure('INVALID_REQUEST', `${name} must be a nonnegative safe integer`);
  return value;
}

function concurrency(value) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 8) throw failure('INVALID_REQUEST', 'concurrency must be an integer from 1 to 8');
  return value;
}

function renderSelection(project, request) {
  if (!['sample', 'full'].includes(request.kind) || request.kind === 'full' && request.sceneIds !== undefined) throw failure('INVALID_REQUEST', 'produce requires kind full, or sample with optional sceneIds');
  const ids = request.kind === 'full' ? project.scenes.map(scene => scene.id) : (request.sceneIds ?? project.scenes.slice(0, 1).map(scene => scene.id));
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !project.scenes.some(scene => scene.id === id))) throw failure('INVALID_REQUEST', 'produce scene selection does not resolve');
  return ids;
}

function validateReviewScope(scenes, settings) {
  const ids = settings?.review?.sampleSceneIds;
  if (ids !== undefined && (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !scenes?.some(scene => scene.id === id)))) throw failure('INVALID_REQUEST', 'review.sampleSceneIds must contain distinct planned scene IDs');
}

async function approvalState(project) {
  const {isCurrent} = await import('./core/approvals.mjs');
  const covers = (stage, ids) => ids.every(id => project.approvals.some(approval => approval.stage === stage && approval.scope.includes(id) && isCurrent(project, approval)));
  const all = project.scenes.map(scene => scene.id);
  const selectedSample = project.settings.review?.sampleSceneIds ?? all.slice(0, 1);
  const sample = project.scenes.filter(scene => selectedSample.includes(scene.id)).map(scene => scene.id);
  const coversTarget = (ids, target) => ids.every(id => project.approvals.some(approval => approval.stage === 'final' && approval.scope.includes(id) && approval.target?.kind === target.kind && approval.target.manifestPath === target.manifestPath && approval.target.sha256 === target.sha256 && isCurrent(project, approval)));
  return {all, sample, covers, coversTarget};
}

async function authorizeProduce(project, request) {
  const selected = renderSelection(project, request);
  const {all, sample, covers} = await approvalState(project);
  if (!covers('script', all)) throw failure('SCRIPT_APPROVAL_REQUIRED', 'Current explicit script approval or waiver must cover every scene before whole-project narration preparation');
  if (request.kind === 'full' && !covers('sample', sample)) throw failure('SAMPLE_APPROVAL_REQUIRED', 'Current sample approval or waiver must cover designated sample scenes');
  return selected;
}

async function authorizeResume(project) {
  const mediaJobs = project.jobs.filter(job => ['audio', 'tts', 'render'].includes(job.kind));
  if (!mediaJobs.length) return;
  const {all, sample, covers} = await approvalState(project);
  if (!covers('script', all)) throw failure('SCRIPT_APPROVAL_REQUIRED', 'Current explicit script approval or waiver must cover every scene before resuming narration or rendering');
  const currentFullRender = mediaJobs.some(job => job.kind === 'render' && job.request?.kind === 'full');
  if (currentFullRender && !covers('sample', sample)) throw failure('SAMPLE_APPROVAL_REQUIRED', 'Current sample approval or waiver must cover designated sample scenes before resuming a full render');
}

async function currentRenderJobs(root, project) {
  const {currentJobKey} = await import('./core/jobs.mjs');
  const {canonicalHash} = await import('./core/model.mjs');
  const {projectMediaPath, sha256} = await import('./providers/assets.mjs');
  const workflowPaths = project.settings.preparation?.workflowPaths ?? [], result = [];
  for (const job of project.jobs.filter(item => item.kind === 'render' && item.state === 'succeeded')) {
    try {
      if (job.key !== await currentJobKey(root, project, job) || canonicalHash(job.workflowPaths ?? []) !== canonicalHash(workflowPaths)) continue;
      const manifestFile = job.outputFiles?.find(file => file.path === job.manifestPath);
      if (!manifestFile) continue;
      const bytes = await readFile(await projectMediaPath(root, job.manifestPath));
      if (bytes.length !== manifestFile.size || sha256(bytes) !== manifestFile.sha256) continue;
      const manifest = JSON.parse(bytes);
      if (manifest.kind !== job.request?.kind || manifest.captionPolicy !== 'sentence-spans-v1' || canonicalHash(manifest.scope) !== canonicalHash(job.sceneIds) || canonicalHash(manifest.workflowPaths) !== canonicalHash(workflowPaths)) continue;
      result.push({job, artifacts: [...new Set([...(job.receipt?.artifacts ?? []), ...(job.outputs ?? [])])], target: manifest.kind === 'full' ? {kind: 'render', manifestPath: job.manifestPath, sha256: manifestFile.sha256} : undefined});
    } catch {}
  }
  return result;
}

function publicJobs(project, renders) {
  const current = new Set(renders.map(({job}) => job.id));
  return project.jobs.map(job => {
    const summary = {id: job.id, kind: job.kind, state: job.state};
    if (job.kind !== 'render') return summary;
    if (job.state === 'succeeded' && !current.has(job.id)) return {...summary, state: 'pending', current: false, historicalState: 'succeeded'};
    return {...summary, current: current.has(job.id)};
  });
}

async function nextStep(root, error, knownProject, knownRenders) {
  let project;
  try {
    if (knownProject) project = knownProject;
    else {
      const {readProject} = await import('./core/store.mjs');
      project = await readProject(root);
    }
  } catch {
    return error?.code === 'PROJECT_NOT_FOUND' ? {action: 'start', reason: 'project-missing'} : {action: 'status', reason: error?.code ?? 'project-unavailable'};
  }
  const base = {expectedRevision: project.revision};
  if (error) {
    if (error.code === 'SCRIPT_APPROVAL_REQUIRED') return {...base, action: 'approve', stage: 'script'};
    if (error.code === 'SAMPLE_APPROVAL_REQUIRED') return {...base, action: 'approve', stage: 'sample'};
    if (error.code === 'FINAL_APPROVAL_REQUIRED') return {...base, action: 'approve', stage: 'final'};
    if (['REVISION_CONFLICT', 'APPROVAL_STALE'].includes(error.code)) return {...base, action: 'status', reason: error.code};
    if (['FONT_REQUIRED', 'FONT_LICENSE_REQUIRED'].includes(error.code)) return {...base, action: 'asset', kind: 'font', reason: error.code};
    if (['LOGIN_REQUIRED', 'UNCERTAIN_ACTION', 'RESUME_STATE_CHANGED', 'INCOMPLETE_MEDIA'].includes(error.code)) return {...base, action: 'record', reason: error.code};
    if (['HOST_AUDIO_REQUIRED', 'TTS_UNAVAILABLE'].includes(error.code)) return {...base, action: 'produce', reason: error.code};
  }
  if (!project.scenes.length) return {...base, action: 'plan', reason: 'no-scenes'};
  const {all, sample, covers, coversTarget} = await approvalState(project);
  if (!covers('script', all)) return {...base, action: 'approve', stage: 'script'};
  const renders = knownRenders ?? await currentRenderJobs(root, project);
  const sampleJob = renders.find(({job}) => job.request?.kind === 'sample' && JSON.stringify(job.sceneIds) === JSON.stringify(sample));
  if (!sampleJob) return {...base, action: 'produce', kind: 'sample', sceneIds: sample};
  if (!covers('sample', sample)) return {...base, action: 'approve', stage: 'sample'};
  const fullJob = renders.find(({job}) => job.request?.kind === 'full' && JSON.stringify(job.sceneIds) === JSON.stringify(all));
  if (!fullJob) return {...base, action: 'produce', kind: 'full'};
  if (!coversTarget(all, fullJob.target)) return {...base, action: 'approve', stage: 'final', target: fullJob.target};
  return {...base, action: 'deliver', renderManifestPath: fullJob.target.manifestPath};
}

async function existingArtifacts(root, project, renders = []) {
  const artifacts = ['project.json'];
  for (const path of ['review.md', 'review.json', 'audio/segments.json', 'audio/timeline.json']) {
    try { await access(join(root, path)); artifacts.push(path); } catch {}
  }
  for (const render of renders) artifacts.push(...render.artifacts);
  return [...new Set(artifacts)];
}

async function saveTimeline(root, timeline, workflowPaths) {
  const {canonicalHash} = await import('./core/model.mjs');
  const {atomicWriteFile, readProject, withProjectLock} = await import('./core/store.mjs');
  const {timelineProjectHash} = await import('./media/timeline.mjs');
  await withProjectLock(root, async () => {
    const current = await readProject(root);
    if (timelineProjectHash(current) !== timeline.projectHash || canonicalHash(current.settings.preparation?.workflowPaths ?? []) !== canonicalHash(workflowPaths)) throw failure('PREPARATION_STALE', 'Project or workflow selection changed before timeline publication');
    await mkdir(join(root, 'audio'), {recursive: true});
    await atomicWriteFile(join(root, 'audio/timeline.json'), JSON.stringify(timeline, null, 2));
  });
}

async function saveRecordingWorkflows(root, artifacts) {
  const workflowPaths = artifacts.filter(path => typeof path === 'string' && /(^|\/)workflow\.json$/.test(path));
  if (!workflowPaths.length) return false;
  if (workflowPaths.some(path => path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..'))) throw failure('INVALID_RECORDING_RECEIPT', 'Recording workflow path must be project-relative');
  const {readProject, saveProject} = await import('./core/store.mjs');
  const {canonicalHash} = await import('./core/model.mjs');
  const {projectMediaPath} = await import('./providers/assets.mjs');
  const inspect = async path => {
    let workflow;
    try { workflow = JSON.parse(await readFile(await projectMediaPath(root, path), 'utf8')); }
    catch { throw failure('INVALID_RECORDING_RECEIPT', `Cannot read recording workflow ${path}`); }
    if (!object(workflow) || workflow.schemaVersion !== 1 || typeof workflow.sourceId !== 'string' || !workflow.sourceId || typeof workflow.requestHash !== 'string' || !workflow.requestHash || !Array.isArray(workflow.segments)) throw failure('INVALID_RECORDING_RECEIPT', `Malformed recording workflow ${path}`);
    const events = new Map();
    for (const segment of workflow.segments) {
      if (!object(segment) || typeof segment.captureId !== 'string' || !Array.isArray(segment.events)) throw failure('INVALID_RECORDING_RECEIPT', `Malformed recording segment ${path}`);
      for (const event of segment.events) {
        if (!object(event) || typeof event.id !== 'string' || !event.id || events.has(event.id)) throw failure('RECORDING_WORKFLOW_CONFLICT', `Duplicate recording event ID in ${path}`);
        events.set(event.id, canonicalHash({captureId: segment.captureId, video: segment.video, videoAssetId: segment.videoAssetId, timing: segment.timing, event}));
      }
    }
    return {path, sourceId: workflow.sourceId, requestHash: workflow.requestHash, events};
  };
  const project = await readProject(root), retained = [];
  for (const path of project.settings.preparation?.workflowPaths ?? []) retained.push(await inspect(path));
  for (const path of [...new Set(workflowPaths)]) {
    const incoming = await inspect(path);
    for (let index = retained.length - 1; index >= 0; index--) {
      const prior = retained[index], sameRequest = prior.sourceId === incoming.sourceId && prior.requestHash === incoming.requestHash;
      const sharedIds = [...prior.events.keys()].filter(id => incoming.events.has(id));
      if (!sameRequest) {
        if (sharedIds.length) throw failure('RECORDING_WORKFLOW_CONFLICT', `Recording event ID is ambiguous between ${prior.path} and ${incoming.path}`);
        continue;
      }
      const covered = prior.events.size <= incoming.events.size && [...prior.events].every(([id, digest]) => incoming.events.get(id) === digest);
      if (!covered) throw failure('RECORDING_WORKFLOW_CONFLICT', `Recovered workflow does not contain the complete prior recording ${prior.path}`);
      retained.splice(index, 1);
    }
    retained.push(incoming);
  }
  project.settings.preparation = {workflowPaths: retained.map(item => item.path)};
  await saveProject(root, project, project.revision);
  return true;
}

async function verifyFontDescriptor(root, descriptor) {
  if (!object(descriptor) || Object.keys(descriptor).some(key => !['license', 'provenance'].includes(key)) || !descriptor.license || !descriptor.provenance) throw failure('INVALID_FONT_DESCRIPTOR', 'Font setup requires license and provenance descriptors');
  const {projectMediaPath, sha256} = await import('./providers/assets.mjs');
  for (const key of ['license', 'provenance']) {
    const item = descriptor[key];
    if (!object(item) || Object.keys(item).some(field => !['path', 'sha256'].includes(field)) || typeof item.path !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw failure('INVALID_FONT_DESCRIPTOR', `${key} must contain project-relative path and sha256`);
    let bytes;
    try { bytes = await readFile(await projectMediaPath(root, item.path)); }
    catch { throw failure('INVALID_FONT_DESCRIPTOR', `${key} must name an existing confined project file`); }
    if (sha256(bytes) !== item.sha256) throw failure('ASSET_HASH_MISMATCH', `${key} bytes differ from the supplied descriptor`);
  }
}

async function configureFont(root, asset, descriptor) {
  if (!asset.mediaType.startsWith('font/')) throw failure('INVALID_FONT_DESCRIPTOR', 'Imported font setup path must contain font bytes');
  await verifyFontDescriptor(root, descriptor);
  if (new Set([asset.sha256, descriptor.license.sha256, descriptor.provenance.sha256]).size !== 3) throw failure('INVALID_FONT_DESCRIPTOR', 'Font, license and provenance must be distinct files');
  const {readProject, saveProject} = await import('./core/store.mjs');
  const project = await readProject(root);
  project.settings.render = {...(project.settings.render ?? {}), fontAssetId: asset.id};
  project.settings.export = {...(project.settings.export ?? {}), fontLicense: {fontAssetId: asset.id, fontSha256: asset.sha256, license: structuredClone(descriptor.license), provenance: structuredClone(descriptor.provenance)}};
  await saveProject(root, project, project.revision);
}

function cleanReceipt(receipt) {
  if (!object(receipt) || !['succeeded', 'failed', 'needs_input'].includes(receipt.status)) throw failure('INVALID_RECEIPT', 'Runtime API returned no Receipt');
  return {...receipt, artifacts: Array.isArray(receipt.artifacts) ? receipt.artifacts : [], checks: Array.isArray(receipt.checks) ? receipt.checks : []};
}

/** One structured project entrypoint. Optional adapters are a test seam; CLI callers can only supply JSON. */
export async function runRuntime(argv, adapters = {}) {
  let root, action = 'arguments', artifacts = [], checks = [];
  try {
    const options = parse(argv);
    if (options.help) return machineHelp();
    root = resolve(options.project);
    const request = await readRequest(options.request);
    action = request.action;
    const {loadRuntimeConfig, exportProject} = await import('./export.mjs');
    const runtime = await loadRuntimeConfig(options.runtime);
    const {readProject, createProject, saveProject} = await import('./core/store.mjs');

    if (action === 'status') {
      const project = await readProject(root), state = await approvalState(project), renders = await currentRenderJobs(root, project);
      const full = renders.find(({job}) => job.request?.kind === 'full' && JSON.stringify(job.sceneIds) === JSON.stringify(state.all));
      return cleanReceipt({status: 'succeeded', artifacts: await existingArtifacts(root, project, renders), checks: [
        check('project-state', {projectId: project.id, revision: project.revision, mode: project.mode, sources: project.sources.length, scenes: project.scenes.length, jobs: publicJobs(project, renders), approvals: {script: state.covers('script', state.all), sample: state.covers('sample', state.sample), final: Boolean(full?.target && state.coversTarget(state.all, full.target))}}),
        check('next-step', await nextStep(root, undefined, project, renders)),
      ]});
    }

    if (action === 'start') {
      if (request.voice !== undefined && !object(request.voice)) throw failure('INVALID_REQUEST', 'voice must be an explicit voice object');
      if (request.paths !== undefined && (!Array.isArray(request.paths) || !request.paths.length || request.paths.some(path => typeof path !== 'string' || !path))) throw failure('INVALID_REQUEST', 'paths must contain nonempty filenames');
      if (request.url !== undefined && (typeof request.url !== 'string' || !request.url)) throw failure('INVALID_REQUEST', 'url must be nonempty');
      if (request.viewport !== undefined && !request.url) throw failure('INVALID_REQUEST', 'viewport applies only to URL ingestion');
      await createProject(root, {mode: request.mode, output: request.output});
      artifacts.push('project.json');
      const {BAILIAN_DEFAULT_VOICE} = await import('./providers/bailian.mjs');
      let project = await readProject(root);
      project.settings.voices = {narrator: structuredClone(request.voice ?? BAILIAN_DEFAULT_VOICE)};
      await saveProject(root, project, project.revision);
      if (request.paths?.length) {
        const {ingestFiles} = await import('./inputs/index.mjs');
        await ingestFiles(root, request.paths.map(path => resolve(path)), runtime);
        checks.push(check('source-ingest', 'Imported immutable local sources with extraction warnings retained'));
      }
      if (request.url) {
        const {inspectWebsite} = await import('./inputs/website.mjs');
        project = await readProject(root);
        await inspectWebsite(root, {url: request.url, viewport: request.viewport ?? {width: Math.min(4096, Math.max(100, project.output.width)), height: Math.min(4096, Math.max(100, project.output.height))}}, runtime);
        checks.push(check('website-ingest', 'Captured the supplied URL as source evidence'));
      }
    }

    if (action === 'plan') {
      const {applyPlan} = await import('./core/approvals.mjs');
      const current = await readProject(root), expected = request.expectedRevision === undefined ? current.revision : revision(request.expectedRevision);
      validateReviewScope(request.scenes, request.settings);
      await applyPlan(root, {scenes: request.scenes, settings: request.settings}, expected);
      const {writeReview} = await import('./review.mjs');
      await writeReview(root);
      artifacts.push('project.json', 'review.md', 'review.json');
      checks.push(check('plan-saved', {previousRevision: expected, revision: (await readProject(root)).revision}));
    }

    if (action === 'approve') {
      const expected = revision(request.expectedRevision), current = await readProject(root);
      if (current.revision !== expected) throw failure('REVISION_CONFLICT', 'Displayed project revision changed before approval');
      const {approvalDigest, approve} = await import('./core/approvals.mjs');
      const digest = approvalDigest(current, request.stage, request.scope, request.target);
      await approve(root, {stage: request.stage, scope: request.scope, decision: request.decision, evidence: request.evidence, digest, ...(request.target ? {target: request.target} : {})}, {runtime});
      const {writeReview} = await import('./review.mjs');
      await writeReview(root, {renderManifestPaths: request.target ? [request.target.manifestPath] : []});
      artifacts.push('project.json', 'review.md', 'review.json');
      checks.push(check('approval-saved', {stage: request.stage, scope: request.scope, displayedRevision: expected, digest}));
    }

    if (action === 'produce') {
      const current = await readProject(root);
      if (!current.scenes.length) throw failure('PLAN_REQUIRED', 'Save scenes before producing video');
      await authorizeProduce(current, request);
      const workflowPaths = structuredClone(current.settings.preparation?.workflowPaths ?? []), workers = concurrency(request.concurrency);
      const {prepareAudio, prepareTimeline} = await import('./media/audio.mjs');
      const prepare = adapters.prepareAudio ?? prepareAudio;
      const timelinePreparation = adapters.prepareTimeline ?? prepareTimeline;
      const segments = await prepare(root, {runtime, hostReceipts: request.hostReceipts ?? {}, workflowPaths});
      artifacts.push('project.json', 'audio/segments.json');
      const timeline = await timelinePreparation(root, segments, {runtime, workflowPaths});
      await saveTimeline(root, timeline, workflowPaths);
      artifacts.push('audio/timeline.json');
      const {renderVideo} = await import('./render/render.mjs');
      const render = adapters.renderVideo ?? renderVideo;
      const renderRequest = {kind: request.kind, ...(request.sceneIds ? {sceneIds: request.sceneIds} : {})};
      const receipt = cleanReceipt(await render(root, renderRequest, {runtime, workflowPaths, ...(workers ? {concurrency: workers} : {})}));
      if (receipt.status !== 'succeeded') return await finish(root, {...receipt, artifacts: [...new Set([...artifacts, ...receipt.artifacts])]}, receipt.error);
      artifacts.push(...receipt.artifacts); checks.push(...receipt.checks);
      const {writeReview} = await import('./review.mjs');
      await writeReview(root, {renderManifestPaths: receipt.artifacts.filter(path => path.endsWith('/manifest.json'))});
      artifacts.push('review.md', 'review.json');
    }

    if (action === 'revise') {
      const {revise} = await import('./core/revise.mjs');
      const current = await readProject(root), expected = request.expectedRevision === undefined ? current.revision : revision(request.expectedRevision);
      const result = await revise(root, {sceneId: request.sceneId, field: request.field, value: request.value}, expected);
      const {writeReview} = await import('./review.mjs');
      await writeReview(root);
      artifacts.push('project.json', 'review.md', 'review.json');
      checks.push(check('revision-saved', {previousRevision: expected, revision: result.project.revision, invalidatedJobIds: result.invalidatedJobIds}));
    }

    if (action === 'music') {
      const {expectedRevision, action: ignored, ...musicRequest} = request;
      void ignored;
      const {configureMusic} = await import('./media/music.mjs');
      const configure = adapters.configureMusic ?? configureMusic;
      const receipt = cleanReceipt(await configure(root, musicRequest, {runtime, ...(expectedRevision === undefined ? {} : {expectedRevision: revision(expectedRevision)})}));
      return finish(root, receipt, receipt.error);
    }

    if (action === 'record') {
      const {action: ignored, ...recordRequest} = request;
      void ignored;
      const {recordWebsite} = await import('./media/recording.mjs');
      const record = adapters.recordWebsite ?? recordWebsite;
      const result = await record(root, recordRequest, runtime);
      const receipt = cleanReceipt(result?.receipt);
      if (await saveRecordingWorkflows(root, receipt.artifacts)) receipt.artifacts.push('project.json');
      return finish(root, receipt, receipt.error);
    }

    if (action === 'asset') {
      if (request.expectedRevision !== undefined && (await readProject(root)).revision !== revision(request.expectedRevision)) throw failure('REVISION_CONFLICT', 'Project revision changed before asset import');
      if (request.font !== undefined) await verifyFontDescriptor(root, request.font);
      const {importAsset} = await import('./providers/assets.mjs');
      const asset = await importAsset(root, {path: resolve(request.path), origin: request.origin});
      if (request.font !== undefined) await configureFont(root, asset, request.font);
      artifacts.push('project.json', asset.path);
      checks.push(check('asset-imported', {assetId: asset.id, mediaType: asset.mediaType, origin: asset.origin, fontConfigured: request.font !== undefined}));
    }

    if (action === 'deliver') {
      const receipt = cleanReceipt(await exportProject(root, {destination: request.destination, includeSources: request.includeSources, ...(request.renderManifestPath ? {renderManifestPath: request.renderManifestPath} : {})}, {runtime}));
      return finish(root, receipt, receipt.error);
    }

    if (action === 'resume') {
      const {resumeJobs} = await import('./core/jobs.mjs');
      await authorizeResume(await readProject(root));
      const workers = concurrency(request.concurrency);
      const resume = adapters.resumeJobs ?? resumeJobs;
      const receipt = cleanReceipt(await resume(root, {runtime, ...(workers ? {concurrency: workers} : {})}));
      return finish(root, receipt, receipt.error);
    }

    return finish(root, {status: 'succeeded', artifacts: [...new Set(artifacts)], checks}, undefined);
  } catch (error) {
    const publicError = {code: error.code ?? 'RUNTIME_FAILED', detail: `${action}: ${error.message ?? 'Operation failed'}`};
    return finish(root, {status: NEEDS_INPUT.has(publicError.code) ? 'needs_input' : 'failed', artifacts: [...new Set(artifacts)], checks, error: publicError}, publicError);
  }
}

async function finish(root, receipt, error) {
  const result = cleanReceipt(receipt);
  if (result.status === 'failed' && NEEDS_INPUT.has(error?.code)) result.status = 'needs_input';
  if (!result.checks.some(item => item.name === 'next-step')) result.checks.push(check('next-step', root ? await nextStep(root, error) : {action: 'status', reason: error?.code ?? 'invalid-arguments'}));
  result.artifacts = [...new Set(result.artifacts)];
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1]).catch(() => resolve(process.argv[1]))).href) {
  const receipt = await runRuntime(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = {succeeded: 0, failed: 1, needs_input: 2}[receipt.status];
}
