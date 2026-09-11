import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runProcess } from '../providers/process.mjs';

const pythonScript = fileURLToPath(new URL('../../python/documents.py', import.meta.url));
const mime = { pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ppt: 'application/vnd.ms-powerpoint', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword', md: 'text/markdown' };
export const digest = data => createHash('sha256').update(data).digest('hex');
export const inputError = (code, detail) => Object.assign(new Error(detail), { code });

export async function inspectInput(path) {
  const kind = extname(path).slice(1).toLowerCase();
  if (!Object.hasOwn(mime, kind)) throw inputError('UNSUPPORTED_INPUT', `Unsupported input extension: ${kind}`);
  if ((await stat(path)).size > 256 * 1024 * 1024) throw inputError('INPUT_TOO_LARGE', 'Input exceeds 256 MiB');
  const bytes = await readFile(path);
  const zip = bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const cfb = bytes.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1';
  if ((['pptx', 'docx'].includes(kind) && !zip) || (['ppt', 'doc'].includes(kind) && !cfb)) throw inputError('DOCUMENT_SIGNATURE_MISMATCH', `${kind} file signature does not match ${path}`);
  if (kind === 'md') {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (bytes.includes(0)) throw new Error('NUL byte'); }
    catch { throw inputError('DOCUMENT_SIGNATURE_MISMATCH', 'Markdown must be UTF-8 text without NUL bytes'); }
  }
  return { kind, bytes, hash: digest(bytes) };
}

/** Shared extraction workspace. config.projectRoot is required and owns all relative asset paths. */
export async function beginExtraction(path, config) {
  if (!config?.projectRoot) throw inputError('INVALID_REQUEST', 'config.projectRoot is required for extraction outputs');
  const info = await inspectInput(path);
  const id = `${info.kind}-${info.hash}`;
  const relative = `sources/${id}`;
  const destination = join(resolve(config.projectRoot), relative);
  let manifest;
  try {
    manifest = await readFile(join(destination, 'manifest.json'), 'utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw inputError('SOURCE_CACHE_INVALID', error.message); }
  if (manifest !== undefined) try {
    const cached = JSON.parse(manifest);
    if (cached.source.id !== id) throw new Error('source ID mismatch');
    for (const asset of cached.assets) if (digest(await readFile(join(resolve(config.projectRoot), asset.path))) !== asset.sha256) throw new Error(`asset hash mismatch: ${asset.path}`);
    return { cached };
  } catch (error) { throw inputError('SOURCE_CACHE_INVALID', error.message); }
  const workspace = join(resolve(config.projectRoot), 'sources', `.extract-${randomUUID()}`);
  await mkdir(workspace, { recursive: true });
  const source = { id, kind: info.kind, original: path, hash: info.hash, archive:{path:`${relative}/original.${info.kind}`,sha256:info.hash}, nodes: [], warnings: [] };
  const assets = [];
  const context = { ...info, source, assets, workspace, relative, destination, config, diagnostics: [] };
  context.node = (kind, text, locator, extra = {}) => {
    const node = { id: `n-${digest(`${id}:${locator}`).slice(0, 32)}`, kind, text, order: source.nodes.length, locator, assetIds: [], ...extra };
    source.nodes.push(node); return node;
  };
  context.warning = (code, locator, detail) => source.warnings.push({ code, locator, detail });
  await putAsset(context, `original.${info.kind}`, info.bytes, mime[info.kind], path, true);
  return context;
}

export async function putAsset(ctx, name, bytes, mediaType, reference, readonly = false) {
  const sha256 = digest(bytes);
  const path = `${ctx.relative}/${name}`;
  await mkdir(dirname(join(ctx.workspace, name)), { recursive: true });
  await writeFile(join(ctx.workspace, name), bytes, { flag: 'wx', mode: readonly ? 0o444 : 0o600 });
  const asset = { id: `a-${digest(`${ctx.source.id}:${name}:${sha256}`).slice(0, 32)}`, path, sha256, mediaType, origin: { kind: 'source', reference, version: ctx.hash } };
  ctx.assets.push(asset); return asset;
}

export async function finishExtraction(ctx) {
  const evidence = { source: ctx.source, diagnostics: ctx.diagnostics, assets: ctx.assets.map(a => ({ ...a })) };
  await putAsset(ctx, 'extraction-evidence.json', Buffer.from(JSON.stringify(evidence, null, 2)), 'application/json', `${ctx.source.original}#extraction-evidence`);
  const result = { source: ctx.source, assets: ctx.assets };
  await writeFile(join(ctx.workspace, 'manifest.json'), JSON.stringify(result, null, 2));
  // Never replace previously imported source evidence, even under concurrent direct extraction.
  try { await rename(ctx.workspace, ctx.destination); }
  catch (error) { await rm(ctx.workspace, { recursive: true, force: true }); throw inputError('SOURCE_WRITE_CONFLICT', error.message); }
  return result;
}

async function checkedProcess(ctx, file, args, options = {}) {
  const result = await runProcess(file, args, { timeoutMs: ctx.config.documentTimeoutMs ?? 120_000, ...options });
  ctx.diagnostics.push({ command: file, args, code: result.code, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr });
  if (result.code !== 0 || result.timedOut) throw inputError('DOCUMENT_PROCESS_FAILED', `${file}: ${result.timedOut ? 'timed out' : result.stderr || result.stdout || 'process failed'}`);
  return result;
}

async function callPython(ctx, request) {
  const result = await checkedProcess(ctx, ctx.config.python, [pythonScript], { input: JSON.stringify(request) });
  let reply;
  try { reply = JSON.parse(result.stdout); } catch { throw inputError('DOCUMENT_EXTRACTION_FAILED', 'Python did not return valid JSON'); }
  if (reply.error) throw inputError(reply.error.code, reply.error.detail);
  return reply;
}

/**
 * @param {string} path Original PPTX/PPT/DOCX/DOC input; never modified.
 * @param {{projectRoot:string,python:string,documentRenderer:string,pdftoppm:string,fontPaths?:string[],documentTimeoutMs?:number}} config
 * @returns {Promise<{source:import('../core/model.mjs').Source,assets:import('../core/model.mjs').Asset[]}>}
 */
export async function extractDocument(path, config = {}) {
  // Fail signature checks before requesting installed rendering dependencies.
  const input = await inspectInput(path);
  if (input.kind === 'md') throw inputError('UNSUPPORTED_INPUT', 'Use extractMarkdown for Markdown');
  for (const key of ['python', 'documentRenderer', 'pdftoppm']) if (!config[key]) throw inputError('DEPENDENCY_MISSING', `Configure ${key} for real document extraction and rendering`);
  const ctx = await beginExtraction(path, config);
  if (ctx.cached) return ctx.cached;
  try {
    await callPython(ctx, { operation: 'inspect', path: join(ctx.workspace, `original.${ctx.kind}`), kind: ctx.kind });
    const xmlEscape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const fonts = config.fontPaths?.map(p => dirname(resolve(p))) ?? (process.platform === 'darwin' ? ['/System/Library/Fonts', '/Library/Fonts'] : ['/usr/share/fonts', '/usr/local/share/fonts']);
    const cache = join(ctx.workspace, 'font-cache'); await mkdir(cache);
    const fontConfig = join(ctx.workspace, 'fonts.conf');
    await writeFile(fontConfig, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig>${[...new Set(fonts)].map(p => `<dir>${xmlEscape(p)}</dir>`).join('')}<cachedir>${xmlEscape(cache)}</cachedir></fontconfig>`);
    const env = { ...process.env, FONTCONFIG_FILE: fontConfig };
    ctx.warning('FONT_GLYPH_COVERAGE_UNVERIFIED', 'document', 'Font directories are configured only for child processes. Font readability and renderer success do not prove glyph coverage; review rendered pages.');
    const profile = `-env:UserInstallation=${pathToFileURL(join(ctx.workspace, 'renderer-profile')).href}`;
    const convert = async (file, format, dir) => {
      await mkdir(dir, { recursive: true });
      await checkedProcess(ctx, config.documentRenderer, [profile, '--headless', '--convert-to', format, '--outdir', dir, file], { env });
    };
    let document = join(ctx.workspace, `original.${ctx.kind}`);
    let kind = ctx.kind;
    if (['ppt', 'doc'].includes(kind)) {
      const convertedKind = `${kind}x`;
      await convert(document, convertedKind, join(ctx.workspace, 'converted'));
      document = join(ctx.workspace, 'converted', `original.${convertedKind}`);
      await callPython(ctx, { operation: 'inspect', path: document, kind: convertedKind });
      const data = await readFile(document);
      // Conversion output is registered alongside the unchanged binary original.
      await putAsset(ctx, `converted.${convertedKind}`, data, mime[convertedKind], `${path}#converted-${convertedKind}`);
      ctx.warning('LEGACY_CONVERTED', 'document', `Converted real ${kind} with the configured LibreOffice renderer to ${convertedKind}. Converted object IDs describe this immutable source version; conversion may alter appearance or features.`);
      ctx.warning('LEGACY_GEOMETRY_UNVERIFIED', 'document', 'Converted object geometry may differ from the original rendered page, including alignment and box widths. Do not use extracted rects for automatic highlights without visual alignment verification.');
      kind = convertedKind;
    }
    const extracted = await callPython(ctx, { operation: 'extract', path: document, kind, output: join(ctx.workspace, 'extracted') });
    const media = new Map();
    for (const item of extracted.assets) {
      const asset = await putAsset(ctx, `media/${item.name}`, await readFile(join(ctx.workspace, 'extracted', item.name)), item.mediaType, `${path}#${item.locator}`);
      media.set(item.name, asset.id);
    }
    const ids = new Map();
    for (const item of extracted.nodes) {
      const { locator, kind: nodeKind, text, assetNames, parentLocator, ...rest } = item;
      const node = ctx.node(nodeKind, text, locator, { ...rest, assetIds: assetNames.map(name => media.get(name)) });
      ids.set(locator, node.id);
      if (parentLocator) node.parentId = ids.get(parentLocator);
    }
    ctx.source.warnings.push(...extracted.warnings);
    // Render the original, including the legacy original, rather than assuming the OOXML roundtrip is visually equivalent.
    await convert(join(ctx.workspace, `original.${ctx.kind}`), 'pdf', join(ctx.workspace, 'rendered'));
    const pdf = join(ctx.workspace, 'rendered', 'original.pdf');
    await putAsset(ctx, 'pages.pdf', await readFile(pdf), 'application/pdf', `${path}#rendered-pages`);
    const pages = await callPython(ctx, { operation: 'pdf-pages', path: pdf });
    if (pages.count < 1) throw inputError('DOCUMENT_RENDER_FAILED', 'Renderer produced no pages');
    if (kind === 'pptx' && pages.count !== ctx.source.nodes.filter(n => n.kind === 'page').length) throw inputError('DOCUMENT_RENDER_FAILED', 'Rendered slide count does not match logical slide count');
    await checkedProcess(ctx, config.pdftoppm, ['-png', '-r', '110', pdf, join(ctx.workspace, 'rendered', 'page')], { env });
    // pdftoppm pads the index to the total page-count digit width.
    for (let i = 1; i <= pages.count; i++) {
      const bytes = await readFile(join(ctx.workspace, 'rendered', `page-${String(i).padStart(String(pages.count).length, '0')}.png`));
      if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw inputError('DOCUMENT_RENDER_FAILED', `Invalid rendered PNG page ${i}`);
      const locator = kind === 'pptx' ? `slide:${i}` : `rendered-page:${i}`;
      const asset = await putAsset(ctx, `pages/page-${i}.png`, bytes, 'image/png', `${path}#${locator}`);
      const page = ctx.source.nodes.find(n => n.locator === locator) ?? ctx.node('page', `Rendered page ${i}`, locator);
      page.assetIds.push(asset.id);
    }
    ctx.warning('STATIC_PAGE_FALLBACK', 'document', 'Page assets are static raster/PDF appearance evidence from LibreOffice. Native animations, transitions, video playback, editability and exact native-application fidelity are not preserved or proven.');
    // Keep only registered evidence, not renderer caches or temporary converted copies.
    for (const dir of ['rendered', 'converted', 'extracted', 'font-cache', 'renderer-profile']) await rm(join(ctx.workspace, dir), { recursive: true, force: true });
    await rm(fontConfig);
    return await finishExtraction(ctx);
  } catch (error) {
    // Retain bounded diagnostic evidence for failed extraction without inserting an empty Source.
    await writeFile(join(ctx.workspace, 'failure.json'), JSON.stringify({ code: error.code, detail: error.message, diagnostics: ctx.diagnostics }, null, 2)).catch(() => {});
    error.evidence = join(ctx.workspace, 'failure.json');
    throw error;
  }
}
