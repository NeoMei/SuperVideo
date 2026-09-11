import { readFile, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProject, readProject, atomicWriteFile, withProjectLock } from './core/store.mjs';
import { assertProject, canonicalHash } from './core/model.mjs';
import { applyPlan, approve } from './core/approvals.mjs';
import { revise } from './core/revise.mjs';
import { resumeJobs } from './core/jobs.mjs';
import { writeReview } from './review.mjs';

const requests = {
  create: ['mode', 'output'], ingest: ['paths', 'url', 'viewport'], plan: ['scenes', 'settings'],
  approve: ['stage', 'scope', 'decision', 'evidence', 'digest', 'target'],
  render: ['kind', 'sceneIds'], revise: ['sceneId', 'field', 'value'],
  export: ['destination', 'includeSources', 'renderManifestPath'],
};
const commands = ['doctor', 'create', 'ingest', 'plan', 'approve', 'prepare', 'render', 'revise', 'resume', 'export'];
const needsInput = new Set([
  'PROJECT_NOT_FOUND', 'PROJECT_LOCKED', 'REVISION_CONFLICT', 'APPROVAL_STALE', 'PLAN_REQUIRED',
  'DEPENDENCY_MISSING', 'DEPENDENCY_VERSION_MISMATCH', 'HOST_AUDIO_REQUIRED', 'FONT_REQUIRED',
  'FONT_LICENSE_REQUIRED', 'SCRIPT_APPROVAL_REQUIRED', 'SAMPLE_APPROVAL_REQUIRED', 'FINAL_APPROVAL_REQUIRED',
  'COMPONENT_REVIEW_REQUIRED', 'LOGIN_REQUIRED', 'UNCERTAIN_ACTION', 'RESUME_STATE_CHANGED',
  'INCOMPLETE_MEDIA', 'JOB_OWNED', 'UNKNOWN_JOB', 'WORD_ALIGNMENT_REQUIRED', 'TTS_UNAVAILABLE',
  'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND',
]);
const failed = (code, detail) => Object.assign(new Error(detail), { code });
const succeeded = (artifacts = [], checks = []) => ({ status: 'succeeded', artifacts, checks });
const check = (name, evidence) => ({ name, passed: true, evidence });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function parse(argv) {
  const [command, ...args] = argv;
  if (command === '--help' && !args.length) return { help: true };
  if (!commands.includes(command)) throw failed('INVALID_COMMAND', `Expected one command: ${commands.join(', ')}`);
  const options = { command };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help' && args.length === 1) return { command, help: true };
    if (!['--project', '--request', '--runtime', '--expected-revision', '--concurrency'].includes(flag) || Object.hasOwn(options, flag.slice(2))) throw failed('INVALID_ARGUMENT', 'Unknown or duplicate CLI flag');
    const value = args[++index];
    if (value === undefined || !value.length || value.startsWith('--')) throw failed('INVALID_ARGUMENT', 'CLI flag requires a value');
    options[flag.slice(2)] = value;
  }
  if (command !== 'doctor' && !options.project) throw failed('INVALID_ARGUMENT', '--project is required');
  if (Boolean(requests[command]) !== Boolean(options.request)) throw failed('INVALID_ARGUMENT', requests[command] ? '--request JSON file is required' : 'This command has no request body');
  const mutatesRevision = ['plan', 'revise'].includes(command);
  if (mutatesRevision !== Object.hasOwn(options, 'expected-revision')) throw failed('INVALID_ARGUMENT', mutatesRevision ? '--expected-revision is required' : '--expected-revision applies only to plan/revise');
  if (mutatesRevision && (!/^\d+$/.test(options['expected-revision']) || !Number.isSafeInteger(Number(options['expected-revision'])))) throw failed('INVALID_ARGUMENT', 'Expected revision must be a nonnegative safe integer');
  if (options.concurrency !== undefined && (!['render', 'resume'].includes(command) || !/^[1-9]\d*$/.test(options.concurrency) || Number(options.concurrency) > 8)) throw failed('INVALID_ARGUMENT', 'Render/resume concurrency must be an integer from 1 to 8');
  return options;
}

function help(command) {
  const syntax = {
    usage: 'node src/cli.mjs <command> --project <directory> [--request <json-file>] [--runtime <json-file>]',
    commands: command ? [command] : commands,
    requestFields: command ? requests[command] ?? [] : requests,
    flags: { '--expected-revision': 'Required for plan/revise', '--runtime': 'Explicit operational JSON; otherwise SUPERVIDEO_RUNTIME_CONFIG', '--concurrency': 'Optional render/resume integer 1..8' },
    exits: { succeeded: 0, failed: 1, needs_input: 2 },
  };
  return succeeded([], [check('cli-syntax', JSON.stringify(syntax))]);
}

async function readRequest(path, command) {
  let value;
  try { value = JSON.parse(await readFile(resolve(path), 'utf8')); }
  catch { throw failed('INVALID_REQUEST', 'Request must be a readable JSON object file'); }
  if (!object(value) || Object.keys(value).some(key => !requests[command].includes(key))) throw failed('INVALID_REQUEST', 'Unknown or invalid command request fields');
  if (command === 'render' && (!['sample', 'full'].includes(value.kind) || value.kind === 'full' && value.sceneIds !== undefined || value.sceneIds !== undefined && (!Array.isArray(value.sceneIds) || !value.sceneIds.length || value.sceneIds.some(id => typeof id !== 'string' || !id) || new Set(value.sceneIds).size !== value.sceneIds.length))) throw failed('INVALID_REQUEST', 'Render requires kind full, or kind sample with optional distinct sceneIds');
  return value;
}

function requireMediaRuntime(runtime) {
  if (!runtime.ffmpeg || !runtime.ffprobe) throw failed('DEPENDENCY_MISSING', 'Configure FFmpeg and ffprobe in the operational runtime file');
}

function reviewScope(project) {
  const ids = project.settings.review?.sampleSceneIds;
  if (ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !project.scenes.some(scene => scene.id === id)) || new Set(ids).size !== ids.length)) throw failed('INVALID_REQUEST', 'review.sampleSceneIds must contain distinct existing scene IDs');
}

/** Fixed process boundary. Host authors structured requests; no free-text execution interface. */
export async function runCli(argv) {
  const artifacts = [], checks = [];
  let step = 'arguments';
  try {
    const options = parse(argv), command = options.command;
    if (options.help) return help(command);
    step = 'request';
    const request = options.request ? await readRequest(options.request, command) : undefined;
    const root = options.project ? resolve(options.project) : undefined;
    step = 'runtime';
    const { loadRuntimeConfig, exportProject } = await import('./export.mjs');
    const runtime = await loadRuntimeConfig(options.runtime);
    const concurrency = options.concurrency ? Number(options.concurrency) : undefined;
    step = command;
    const projectArtifact = () => { if (!artifacts.includes('project.json')) artifacts.push('project.json'); };
    const review = async (renderManifestPaths = []) => {
      step = 'review';
      await writeReview(root, { renderManifestPaths });
      artifacts.push('review.md', 'review.json');
    };

    switch (command) {
      case 'doctor': {
        const { doctor } = await import('./providers/doctor.mjs');
        const capabilities = await doctor(runtime);
        const manifest = JSON.parse(await readFile(new URL('../runtime-manifest.json', import.meta.url)));
        const required = new Set(manifest.capabilities);
        const missing = capabilities.filter(c => required.has(c.id) && !c.available);
        return {
          status: missing.length ? 'needs_input' : 'succeeded', artifacts: [],
          checks: capabilities.map(c => ({ name: c.id, passed: c.available, evidence: JSON.stringify({ version: c.version, reason: c.reason, remedy: c.remedy, required: required.has(c.id) }) })),
          ...(missing.length ? { error: { code: 'DEPENDENCY_MISSING', detail: `Unavailable capabilities: ${missing.map(c => c.id).join(', ')}` } } : {}),
        };
      }
      case 'create':
        await createProject(root, request); projectArtifact(); break;
      case 'ingest': {
        if (request.paths !== undefined && (!Array.isArray(request.paths) || request.paths.some(path => typeof path !== 'string' || !path))) throw failed('INVALID_REQUEST', 'paths must contain nonempty filenames');
        if (request.url !== undefined && (typeof request.url !== 'string' || !request.url)) throw failed('INVALID_REQUEST', 'url must be nonempty');
        if (!request.paths?.length && !request.url) throw failed('INVALID_REQUEST', 'Provide paths or url');
        if (request.viewport !== undefined && !request.url) throw failed('INVALID_REQUEST', 'viewport applies only to URL ingestion');
        const { ingestFiles } = await import('./inputs/index.mjs');
        if (request.paths?.length) { await ingestFiles(root, request.paths.map(path => resolve(path)), runtime); projectArtifact(); checks.push(check('file-ingest', 'Source files imported')); }
        if (request.url) {
          step = 'website-ingest';
          const { inspectWebsite } = await import('./inputs/website.mjs');
          const project = await readProject(root);
          await inspectWebsite(root, { url: request.url, viewport: request.viewport ?? { width: Math.min(4096, Math.max(100, project.output.width)), height: Math.min(4096, Math.max(100, project.output.height)) } }, runtime);
          projectArtifact();
        }
        break;
      }
      case 'plan': {
        const current = await readProject(root);
        const candidate = assertProject({ ...current, ...request }); reviewScope(candidate);
        await applyPlan(root, request, Number(options['expected-revision'])); projectArtifact();
        checks.push(check('plan-saved', 'Draft saved at the explicit expected revision'));
        await review(); break;
      }
      case 'approve':
        await approve(root, request, { runtime }); projectArtifact();
        checks.push(check('approval-saved', 'Explicit stage, scope, digest and evidence recorded'));
        await review(); break;
      case 'revise': {
        const result = await revise(root, request, Number(options['expected-revision'])); projectArtifact();
        checks.push(check('revision-saved', JSON.stringify({ revision: result.project.revision, invalidatedJobIds: result.invalidatedJobIds })));
        await review(); break;
      }
      case 'prepare': {
        const project = await readProject(root);
        if (!project.scenes.length) throw failed('PLAN_REQUIRED', 'Save scenes before preparing narration');
        requireMediaRuntime(runtime);
        const { prepareAudio, prepareTimeline } = await import('./media/audio.mjs');
        const segments = await prepareAudio(root, { runtime });
        projectArtifact(); artifacts.push('audio/segments.json'); step = 'timeline';
        const workflowPaths = (await readProject(root)).settings.preparation?.workflowPaths ?? [];
        const timeline = await prepareTimeline(root, segments, { runtime, workflowPaths });
        const { timelineProjectHash } = await import('./media/timeline.mjs');
        await withProjectLock(root, async () => {
          const current = await readProject(root);
          if (timelineProjectHash(current) !== timeline.projectHash || canonicalHash(current.settings.preparation?.workflowPaths ?? []) !== canonicalHash(workflowPaths)) throw failed('PREPARATION_STALE', 'Project or workflow selection changed before timeline publication');
          await mkdir(join(root, 'audio'), { recursive: true });
          await atomicWriteFile(join(root, 'audio/timeline.json'), JSON.stringify(timeline, null, 2));
        });
        artifacts.push('audio/timeline.json'); checks.push(check('timeline-verified', 'Actual registered audio and selected workflow evidence verified')); break;
      }
      case 'render': {
        const project = await readProject(root);
        if (!project.scenes.length) throw failed('PLAN_REQUIRED', 'Save scenes before rendering');
        requireMediaRuntime(runtime);
        const { renderVideo } = await import('./render/render.mjs');
        const result = await renderVideo(root, request, { runtime, workflowPaths: project.settings.preparation?.workflowPaths ?? [], ...(concurrency ? { concurrency } : {}) });
        if (result.status !== 'succeeded') return result;
        artifacts.push(...result.artifacts); checks.push(...result.checks);
        await review(result.artifacts.filter(path => path.endsWith('/manifest.json'))); break;
      }
      case 'resume':
        return await resumeJobs(root, { runtime, ...(concurrency ? { concurrency } : {}) });
      case 'export':
        return await exportProject(root, request, { runtime });
    }
    return succeeded([...new Set(artifacts)], checks);
  } catch (error) {
    const code = error.code ?? 'CLI_FAILED';
    return { status: needsInput.has(code) ? 'needs_input' : 'failed', artifacts: [...new Set(artifacts)], checks, error: { code, detail: `${step}: ${error.message ?? 'Command failed'}` } };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1]).catch(() => resolve(process.argv[1]))).href) {
  const receipt = await runCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = { succeeded: 0, failed: 1, needs_input: 2 }[receipt.status];
}
