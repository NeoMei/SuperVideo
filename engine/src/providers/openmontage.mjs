import { access, lstat, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import pathAPI, { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { runProcess } from './process.mjs';

export const OPENMONTAGE_COMMIT = '08e2151fa02de28a5d6a312b3d575692bf147ad7';
// This trust anchor is reviewed with adapter code, never read from the subset itself.
export const OPENMONTAGE_PROVENANCE_SHA256 = '540f51e200a31263c6e31f1266d8cc6915352cc8b16a490e2e11c9e285a6a9bf';
export const OPENMONTAGE_BUNDLED_ROOT = fileURLToPath(new URL('../../vendor/openmontage', import.meta.url));
const BRIDGE = fileURLToPath(new URL('../../python/bridge.py', import.meta.url));

const receipt = (status, error) => ({ status, artifacts: [], checks: [], ...(error ? { error } : {}) });

export async function inspectOpenMontage(config = {}) {
  const root = config.openmontageRoot || OPENMONTAGE_BUNDLED_ROOT;
  if (!root || !(await isDirectory(root))) return { available: false, code: 'DEPENDENCY_MISSING', detail: 'OpenMontage checkout is missing' };
  if (!config.openmontageRoot || await lstat(join(root, 'provenance.json')).then(() => true, () => false)) return inspectSubset(root);
  const git = await runProcess('git', ['-C', root, 'rev-parse', 'HEAD'], { timeoutMs: 5_000 });
  const head = git.stdout.trim();
  if (git.code !== 0 || head !== OPENMONTAGE_COMMIT) return { available: false, code: 'DEPENDENCY_VERSION_MISMATCH', detail: `OpenMontage must be Git revision ${OPENMONTAGE_COMMIT}; observed ${head || 'unverified checkout'}` };
  const dirty = await runProcess('git', ['-C', root, 'diff-index', '--quiet', 'HEAD', '--', 'tools/audio/audio_mixer.py', 'tools/subtitle/subtitle_gen.py', 'tools/base_tool.py', 'tools/audio/elevenlabs_tts.py'], { timeoutMs: 5_000 });
  if (dirty.code !== 0) return { available: false, code: 'DEPENDENCY_VERSION_MISMATCH', detail: 'OpenMontage audited tool files differ from the pinned Git tree' };
  for (const relative of ['tools/audio/audio_mixer.py', 'tools/subtitle/subtitle_gen.py', 'LICENSE']) {
    try { await access(join(root, relative), constants.R_OK); } catch { return { available: false, code: 'DEPENDENCY_MISSING', detail: `OpenMontage is missing ${relative}` }; }
  }
  return { available: true, version: head };
}

async function inspectSubset(root) {
  const mismatch = (detail) => ({ available: false, code: 'DEPENDENCY_VERSION_MISMATCH', detail });
  try {
    const manifestPath = join(root, 'provenance.json');
    if (!(await lstat(manifestPath)).isFile()) return mismatch('OpenMontage provenance must be a regular file');
    const bytes = await readFile(manifestPath);
    if (sha256(bytes) !== OPENMONTAGE_PROVENANCE_SHA256) return mismatch('OpenMontage bundled provenance differs from the audited release');
    const manifest = JSON.parse(bytes);
    const expected = new Set(['provenance.json', ...Object.keys(manifest.files)]);
    const observed = await subsetFiles(root);
    if (observed.length !== expected.size || observed.some(file => !expected.has(file))) return mismatch('OpenMontage bundled subset contains missing or unexpected files');
    for (const [relative, hash] of Object.entries(manifest.files)) {
      if (sha256(await readFile(join(root, relative))) !== hash) return mismatch(`OpenMontage bundled file differs from the audited release: ${relative}`);
    }
    return { available: true, version: OPENMONTAGE_COMMIT, distribution: 'bundled-subset' };
  } catch (error) {
    return mismatch(`OpenMontage bundled subset could not be verified (${error.code || 'invalid contents'})`);
  }
}

async function subsetFiles(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await subsetFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error('Bundled runtime entries must be regular files or directories');
  }
  return files;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function callOpenMontage(config, request) {
  if (!request || !['subtitles', 'mix', 'tts'].includes(request.operation) || !plainObject(request.args)) return receipt('failed', { code: 'INVALID_REQUEST', detail: 'operation must be subtitles, mix or tts and args must be an object' });
  const dependency = await inspectOpenMontage(config);
  if (!dependency.available) return receipt('needs_input', { code: dependency.code, detail: dependency.detail });
  if (!config.python || !(await executable(config.python))) return receipt('needs_input', { code: 'DEPENDENCY_MISSING', detail: 'Configured Python is unavailable' });
  if (request.operation !== 'subtitles' && (!config.ffmpeg || !config.ffprobe || !(await executable(config.ffmpeg)) || !(await executable(config.ffprobe)))) return receipt('needs_input', { code: 'DEPENDENCY_MISSING', detail: 'Configured FFmpeg and ffprobe are required for audio providers' });

  let shimDir, call;
  try {
    if (request.operation === 'mix') shimDir = await createFfmpegShim(config.ffmpeg);
    const env = openMontageEnvironment(config, shimDir);
    call = await runProcess(config.python, [BRIDGE], { input: JSON.stringify(request), timeoutMs: config.timeoutMs ?? 60_000, env });
  } catch(error) {
    if(error.code==='FFMPEG_SHIM_UNAVAILABLE')return receipt('needs_input',{code:error.code,detail:error.message});
    throw error;
  } finally { if (shimDir) await rm(shimDir, { recursive: true, force: true }); }
  if (call.timedOut) return receipt('failed', { code: 'PROVIDER_TIMEOUT', detail: 'OpenMontage bridge exceeded its bounded timeout' });
  let result;
  try { result = JSON.parse(call.stdout); } catch { return receipt('failed', { code: 'PROVIDER_PROTOCOL_ERROR', detail: `OpenMontage returned invalid JSON: ${call.stderr.trim()}` }); }
  if (!result.success) return receipt('failed', { code: 'PROVIDER_FAILED', detail: String(result.error || call.stderr || 'OpenMontage failed') });
  const artifacts = [...new Set((result.artifacts || []).filter((item) => typeof item === 'string'))];
  const output = request.args.output_path;
  if (!artifacts.includes(output) || !(await nonemptyFile(output))) return receipt('failed', { code: 'OUTPUT_INVALID', detail: 'OpenMontage did not produce the requested non-empty artifact' });
  const checks = [{ name: 'pinned-openmontage', passed: true, evidence: dependency.version }, { name: 'output-file', passed: true, evidence: output }];
  if (request.operation !== 'subtitles') {
    const probe = await runProcess(config.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'json', output], { timeoutMs: 15_000 });
    const decode = await runProcess(config.ffmpeg, ['-v', 'error', '-i', output, '-f', 'null', '-'], { timeoutMs: 30_000 });
    let audio = false;
    try { audio = JSON.parse(probe.stdout).streams?.some((stream) => stream.codec_type === 'audio'); } catch {}
    checks.push({ name: 'audio-decode', passed: probe.code === 0 && decode.code === 0 && audio, evidence: probe.code === 0 && decode.code === 0 && audio ? probe.stdout.trim() : `${probe.stderr}\n${decode.stderr}`.trim() });
    if (!checks.at(-1).passed) return { status: 'failed', artifacts: [], checks, error: { code: 'OUTPUT_INVALID', detail: 'Provider audio did not fully probe and decode' } };
  }
  return { status: 'succeeded', artifacts, checks };
}

async function executable(path) { try { await access(path, constants.X_OK); return true; } catch { return false; } }
async function isDirectory(path) { try { return (await stat(path)).isDirectory(); } catch { return false; } }
async function nonemptyFile(path) { try { const item = await stat(path); return item.isFile() && item.size > 0; } catch { return false; } }
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }

/** Python and executable search paths use the host delimiter; inherited entries
 * remain available. The configured executable takes precedence in the shim. */
export function openMontageEnvironment(config,shimDir,inherited=process.env,paths=pathAPI) {
  return {...inherited,
    PYTHONDONTWRITEBYTECODE:'1',
    PYTHONPATH:[config.openmontageRoot || OPENMONTAGE_BUNDLED_ROOT,dirname(BRIDGE),inherited.PYTHONPATH].filter(Boolean).join(paths.delimiter),
    PATH:shimDir?[shimDir,inherited.PATH].filter(Boolean).join(paths.delimiter):inherited.PATH};
}
export async function createFfmpegShim(executable,{platform=process.platform,io={mkdtemp,symlink,rm}}={}) {
  let directory;
  try {
    directory=await io.mkdtemp(join(tmpdir(),'supervideo-ffmpeg-'));
    await io.symlink(resolve(executable),join(directory,platform==='win32'?'ffmpeg.exe':'ffmpeg'),'file');
    return directory;
  }catch(error){
    if(directory)await io.rm(directory,{recursive:true,force:true});
    throw Object.assign(new Error(`Cannot create the configured FFmpeg symlink (${error.code??'unavailable'}). On Windows enable Developer Mode or grant symlink creation rights, then retry explicitly.`),{code:'FFMPEG_SHIM_UNAVAILABLE'});
  }
}
