import { ttsCapabilities } from './tts.mjs';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { inspectOpenMontage } from './openmontage.mjs';
import { runProcess } from './process.mjs';

const missing = (id, reason, remedy) => ({ id, available: false, version: null, reason, remedy });
const available = (id, version) => ({ id, available: true, version, reason: null, remedy: null });

export async function doctor(config = {}) {
  const capabilities = [];
  capabilities.push(await versionCapability('python', config.python, ['--version'], /Python\s+([^\s]+)/, 'Configure a Python 3 executable.'));
  capabilities.push(await versionCapability('ffmpeg', config.ffmpeg, ['-version'], /ffmpeg version\s+([^\s]+)/, 'Install or configure FFmpeg.'));
  capabilities.push(await versionCapability('ffprobe', config.ffprobe, ['-version'], /ffprobe version\s+([^\s]+)/, 'Install or configure ffprobe.'));

  const upstream = await inspectOpenMontage(config);
  capabilities.push(upstream.available ? available('openmontage', upstream.version) : missing('openmontage', upstream.detail, 'Reinstall the verified SuperVideo runtime subset, or repair the explicitly configured legacy OpenMontage checkout'));

  capabilities.push(...await ttsCapabilities(config));
  capabilities.push(await pythonModules(config));
  capabilities.push(await browser(config));
  capabilities.push(await recording(config));
  capabilities.push(await fontCapability(config));
  capabilities.push(await versionCapability('document-renderer', config.documentRenderer, ['--version'], /([^\n]+)/, 'Configure a headless document renderer such as LibreOffice.'));
  capabilities.push(await versionCapability('pdftoppm', config.pdftoppm, ['-v'], /pdftoppm version\s+([^\s]+)/, 'Configure pdftoppm for rendered-page conversion.'));
  return capabilities;
}

export async function doctorDocuments(config = {}) {
  return [await pythonModules(config), await fontCapability(config), await versionCapability('document-renderer', config.documentRenderer, ['--version'], /([^\n]+)/, 'Configure a headless document renderer such as LibreOffice.'), await versionCapability('pdftoppm', config.pdftoppm, ['-v'], /pdftoppm version\s+([^\s]+)/, 'Configure pdftoppm for rendered-page conversion.')];
}

async function versionCapability(id, command, args, pattern, remedy) {
  if (!command || !(await executable(command))) return missing(id, `${id} executable is missing`, remedy);
  const result = await runProcess(command, args, { timeoutMs: 5_000 });
  const text = `${result.stdout}\n${result.stderr}`.trim();
  const version = text.match(pattern)?.[1]?.trim();
  if (result.code !== 0 || result.timedOut || !version) return missing(id, `${id} is unavailable: ${text || 'probe failed'}`, remedy);
  return available(id, version);
}

async function pythonModules(config) {
  if (!config.python || !(await executable(config.python))) return missing('python-modules', 'Python is missing', 'Configure Python with the required document modules.');
  const code = "import importlib,json; names=['docx','pptx','PIL','lxml','pypdf']; result={};\nfor n in names:\n try: importlib.import_module(n); result[n]=True\n except Exception as e: result[n]=str(e)\nprint(json.dumps(result))";
  const result = await runProcess(config.python, ['-c', code], { timeoutMs: 5_000 });
  try {
    const modules = JSON.parse(result.stdout); const absent = Object.entries(modules).filter(([, ok]) => ok !== true).map(([name, error]) => `${name}: ${error}`);
    return absent.length === 0 ? available('python-modules', Object.keys(modules).join(',')) : missing('python-modules', `Missing Python modules: ${absent.join(', ')}`, 'Install the missing modules in the configured Python runtime.');
  } catch { return missing('python-modules', `Python module probe failed: ${result.stderr.trim()}`, 'Use a working Python runtime.'); }
}

async function browser(config) {
  const browserPath = config.browserExecutable;
  if (!browserPath || !(await executable(browserPath))) return missing('playwright-browser', 'Browser executable is missing', 'Install and configure a Playwright-compatible browser.');
  if (!config.playwrightModule || !(await isDirectory(config.playwrightModule))) return missing('playwright-browser', 'Playwright module is missing', 'Install or configure Playwright.');
  const moduleEntry = config.playwrightModule.endsWith('.js') ? config.playwrightModule : `${config.playwrightModule}/index.js`;
  const result = await runProcess(process.execPath, ['--input-type=module', '-e', "const m=await import(process.argv[1]);const p=m.default??m;const b=await p.chromium.launch({headless:true,executablePath:process.argv[2]});console.log(await b.version());await b.close()", moduleEntry, browserPath], { timeoutMs: 15_000, env: { ...process.env, NODE_PATH: dirname(config.playwrightModule) } });
  return result.code === 0 && result.stdout.trim() ? available('playwright-browser', result.stdout.trim()) : missing('playwright-browser', `Headless browser launch failed: ${result.stderr.trim()}`, 'Install a compatible browser and verify headless launch permissions.');
}

async function recording(config) {
  if (!config.playwrightModule || !config.browserExecutable || !config.ffmpeg || !config.ffprobe) return missing('playwright-recording', 'Playwright, browser, FFmpeg and ffprobe must be configured', 'Configure website recording dependencies.');
  if (!(await isDirectory(config.playwrightModule)) || !(await executable(config.browserExecutable)) || !(await executable(config.ffmpeg)) || !(await executable(config.ffprobe))) return missing('playwright-recording', 'A configured website recording dependency is missing', 'Install the configured browser, Playwright, FFmpeg and ffprobe.');
  const outputDir = await mkdtemp(join(tmpdir(), 'supervideo-recording-'));
  let server;
  try {
    // Reuse production capture/encode/decode and its bounded subprocess cleanup.
    // An outer killed worker would orphan the inner encoder's detached group.
    const [{createServer}, {once}, {createProject}, {inspectWebsite}, {recordWebsite}] = await Promise.all([
      import('node:http'), import('node:events'), import('../core/store.mjs'),
      import('../inputs/website.mjs'), import('../media/recording.mjs'),
    ]);
    server = createServer((req, res) => {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end('<!doctype html><h1>Recording probe</h1>');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    // Never send host authentication state or user website settings to the probe.
    const probeConfig = Object.fromEntries(['playwrightModule', 'browserExecutable', 'ffmpeg', 'ffprobe'].map(key => [key, config[key]]));
    await createProject(outputDir, {mode: 'website', output: {width: 320, height: 240, fps: 25}});
    const source = await inspectWebsite(outputDir, {url: 'http://127.0.0.1:' + server.address().port, viewport: {width: 320, height: 240}}, probeConfig);
    const condition = {role: 'heading', name: 'Recording probe'};
    const {receipt} = await recordWebsite(outputDir, {sourceId: source.id, initial: condition, success: condition, steps: []}, probeConfig);
    const video = receipt.artifacts.find(path => path.endsWith('/recording.mp4'));
    if (receipt.status !== 'succeeded' || !video || !(await nonemptyFile(join(outputDir, video)))) {
      return missing('playwright-recording', `Website recording did not finalize: ${receipt.error?.code ?? 'no video artifact'}`, 'Verify browser capture and the configured FFmpeg encoder.');
    }
    return available('playwright-recording', 'chromium-cdp-ffmpeg');
  } catch (error) {
    return missing('playwright-recording', `Website recording probe failed: ${error.code ?? error.name ?? 'unknown error'}`, 'Verify browser capture and the configured FFmpeg/ffprobe runtime.');
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(outputDir, {recursive: true, force: true});
  }
}

async function fontCapability(config) {
  const paths = Array.isArray(config.fontPaths) ? config.fontPaths : ['/System/Library/Fonts/Hiragino Sans GB.ttc'];
  for (const path of paths) { try { const item = await stat(path); if (item.isFile() && item.size > 0) return available('font-readable', path); } catch {} }
  return missing('font-readable', 'No configured font file is readable; glyph coverage was not tested', 'Configure at least one readable font file and validate required glyphs during rendering.');
}

async function nonemptyFile(path) { try { const item = await stat(path); return item.isFile() && item.size > 0; } catch { return false; } }

async function executable(path) { try { await access(path, constants.X_OK); return true; } catch { return false; } }
async function isDirectory(path) { try { return (await stat(path)).isDirectory(); } catch { return false; } }
