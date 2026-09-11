import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalHash, assertProject } from '../core/model.mjs';
import { readProject, withProjectLock, atomicWriteFile } from '../core/store.mjs';

const sensitiveSelector = 'input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"],input[autocomplete="one-time-code"],input[name*="token" i],input[id*="token" i],input[name*="secret" i],input[id*="secret" i],[data-private]';
export const websiteError = (code, detail) => Object.assign(new Error(detail), { code });
export const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex');

export function websiteOptions(config = {}) {
  const options = config.website ?? {};
  const allowed = ['timeoutMs', 'maxDurationMs', 'maxBytes', 'login', 'storageStatePath'];
  if (!options || typeof options !== 'object' || Object.keys(options).some(k => !allowed.includes(k))) throw websiteError('INVALID_REQUEST', 'Unknown website configuration');
  const result = { timeoutMs: 10_000, maxDurationMs: 120_000, maxBytes: 128 * 1024 * 1024, ...options };
  for (const [key, max] of [['timeoutMs', 60_000], ['maxDurationMs', 600_000], ['maxBytes', 1024 * 1024 * 1024]]) {
    if (!Number.isInteger(result[key]) || result[key] < 1 || result[key] > max) throw websiteError('INVALID_REQUEST', `Invalid ${key}`);
  }
  if (result.login) validateCondition(result.login);
  return result;
}
export function validateCondition(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).some(k => !['role', 'name', 'text'].includes(k)) || !['role', 'name'].every(k => typeof value[k] === 'string' && value[k].length > 0) || (value.text !== undefined && typeof value.text !== 'string')) throw websiteError('INVALID_REQUEST', 'Expected a role/name accessibility condition');
}
export function conditionLocator(page, condition) {
  let locator = page.getByRole(condition.role, { name: condition.name, exact: true });
  if (condition.text !== undefined) locator = locator.filter({ hasText: condition.text });
  return locator;
}
export async function conditionMatches(page, condition) {
  const locator = conditionLocator(page, condition);
  return await locator.count() === 1 && await locator.isVisible();
}
export async function waitCondition(page, condition) {
  await conditionLocator(page, condition).waitFor({ state: 'visible' });
}

export async function openWebsiteBrowser(root, viewport, config = {}) {
  const options = websiteOptions(config);
  let storageState;
  if (options.storageStatePath) {
    const [projectPath, statePath] = await Promise.all([realpath(root), realpath(options.storageStatePath)]);
    const rel = relative(projectPath, statePath);
    if (!rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(rel)) throw websiteError('UNSAFE_AUTH_STATE', 'Authentication state must live outside the exportable project');
    storageState = statePath;
  }
  const module = config.playwrightModule ? pathToFileURL(join(resolve(config.playwrightModule), 'index.mjs')).href : 'playwright-core';
  const { chromium } = await import(module);
  const browser = await chromium.launch({ executablePath: config.browserExecutable, headless: true, timeout: 30_000 });
  try {
    const context = await browser.newContext({ viewport, storageState, serviceWorkers: 'block' });
    context.setDefaultTimeout(options.timeoutMs); context.setDefaultNavigationTimeout(options.timeoutMs);
    const readyBinding = `__supervideoMaskReady_${randomUUID().replaceAll('-', '')}`;
    await context.exposeBinding(readyBinding, async ({ page, frame }, documentId) => {
      try {
        await maskClosedShadowHosts(page);
        // An old document's asynchronous scan must never reveal its successor.
        await frame.evaluate(id => {
          const barrier = document.getElementById('supervideo-document-barrier');
          if (barrier?.dataset.documentId === id) barrier.remove();
        }, documentId);
      } catch { /* Navigation/detach or masking failure: the affected document stays opaque. */ }
    });
    await context.addInitScript(({ selector, readyBinding }) => {
      const documentId = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
      let revealed = false;
      const installBarrier = () => {
        if (!document.documentElement || revealed || document.getElementById('supervideo-document-barrier')) return;
        const barrier = document.createElement('style'); barrier.id = 'supervideo-document-barrier';
        barrier.dataset.documentId = documentId; barrier.textContent = 'html{opacity:0!important}';
        document.documentElement.appendChild(barrier);
      };
      // Runs in every main/subframe document before site scripts or its first paint.
      new MutationObserver(installBarrier).observe(document, { childList: true }); installBarrier();
      document.addEventListener('DOMContentLoaded', async () => {
        // Stop enforcing the creation barrier before release so its removal cannot reinstall it.
        revealed = true;
        await globalThis[readyBinding](documentId);
      }, { once: true });
      // Styles must live inside each shadow root; document CSS cannot cross that boundary.
      const watched = new WeakSet();
      const install = root => {
        const parent = root === document ? document.documentElement : root;
        if (!parent) return;
        if (!root.querySelector('#supervideo-private-mask')) {
          const style = document.createElement('style'); style.id = 'supervideo-private-mask';
          style.textContent = `${selector}{visibility:hidden!important}`; parent.appendChild(style);
        }
        root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) watch(el.shadowRoot); });
      };
      const watch = root => {
        if (watched.has(root)) return; watched.add(root);
        new MutationObserver(() => install(root)).observe(root, { childList: true, subtree: true }); install(root);
      };
      const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function(options) {
        const root = attach.call(this, options);
        if (options.mode === 'closed') this.style.setProperty('visibility', 'hidden', 'important');
        watch(root); return root;
      };
      watch(document);
    }, { selector: sensitiveSelector, readyBinding });
    return { browser, context, page: await context.newPage(), options };
  } catch (error) { await browser.close(); throw error; }
}

/** CDP can identify closed declarative roots; their host is hidden before any capture. */
export async function maskClosedShadowHosts(page) {
  const sessions = [await page.context().newCDPSession(page)];
  try {
    for (const frame of page.frames().filter(f => f !== page.mainFrame())) {
      try { sessions.push(await page.context().newCDPSession(frame)); } catch { /* Same-process frames are included in the main target DOM tree. */ }
    }
    for (const cdp of sessions) {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const walk = async node => {
      if (node.shadowRoots?.some(shadow => shadow.shadowRootType === 'closed')) {
        const { object } = await cdp.send('DOM.resolveNode', { nodeId: node.nodeId });
        try { await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function(){this.style.setProperty("visibility","hidden","important")}' }); }
        finally { await cdp.send('Runtime.releaseObject', { objectId: object.objectId }); }
      }
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : [])]) await walk(child);
    };
    await walk(root);
    }
  } finally { await Promise.all(sessions.map(cdp => cdp.detach().catch(() => {}))); }
}

/** Captures a reduced DOM as data: scripts, attributes and form values are deliberately excluded. */
export async function pageEvidence(page, root, base) {
  // Offscreen cross-origin frames may starve RAF; readiness is a DOM barrier, not an animation.
  await Promise.all(page.frames().map(frame => frame.waitForFunction(() => document.documentElement && !document.getElementById('supervideo-document-barrier'), null, { polling: 100 })));
  await maskClosedShadowHosts(page);
  await mkdir(join(root, base), { recursive: true });
  const screenshot = `${base}/page.png`; const dom = `${base}/dom.json`;
  await page.screenshot({ path: join(root, screenshot), mask: [page.locator(sensitiveSelector)] });
  const content = await page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script,style,input,textarea,select,[data-private]').forEach(node => node.remove());
    return { title: document.title, text: clone.textContent.replace(/\s+/g, ' ').trim() };
  });
  await atomicWriteFile(join(root, dom), JSON.stringify(content, null, 2));
  return { screenshot, dom, content };
}

export async function websiteAssets(root, paths, reference) {
  return Promise.all([...new Set(paths)].map(async path => {
    const sha256 = bytesHash(await readFile(join(root, path)));
    const mediaType = path.endsWith('.png') ? 'image/png' : path.endsWith('.mp4') ? 'video/mp4' : 'application/json';
    return { id: `website-${canonicalHash({ path, sha256 })}`, path, sha256, mediaType, origin: { kind: 'source', reference, version: '1' } };
  }));
}
/** Acquires and registers an immutable URL source, never interpreting page text as instructions. */
export async function inspectWebsite(root, { url, viewport }, config = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { throw websiteError('INVALID_REQUEST', 'Invalid website URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || [...parsed.searchParams.keys()].some(k => /token|secret|password|credential|api.?key/i.test(k)) || parsed.hash) throw websiteError('INVALID_REQUEST', 'Website URL must not contain credentials or fragments');
  if (!viewport || !['width', 'height'].every(k => Number.isInteger(viewport[k]) && viewport[k] >= 100 && viewport[k] <= 4096)) throw websiteError('INVALID_REQUEST', 'Invalid website viewport');
  const session = await openWebsiteBrowser(root, viewport, config);
  try {
    await session.page.goto(parsed.href, { waitUntil: 'domcontentloaded' });
    const text = await session.page.locator('body').innerText();
    const hash = canonicalHash({ url: parsed.href, viewport, text });
    const id = `url-${hash}`;
    return await withProjectLock(root, async () => {
      const project = await readProject(root); const existing = project.sources.find(s => s.id === id);
      if (existing) return existing;
      const evidence = await pageEvidence(session.page, root, `sources/${id}`);
      const manifestPath = `sources/${id}/website.json`;
      await atomicWriteFile(join(root, manifestPath), JSON.stringify({ url: parsed.href, viewport, capture: evidence }, null, 2));
      const assets = await websiteAssets(root, [evidence.screenshot, evidence.dom, manifestPath], id);
      const source = { id, kind: 'url', original: parsed.href, hash, nodes: [{ id: `${id}-page`, kind: 'page', text: evidence.content.text, order: 0, locator: parsed.href, assetIds: assets.map(a => a.id) }], warnings: [] };
      project.sources.push(source); project.assets.push(...assets); project.revision++;
      await atomicWriteFile(join(root, 'project.json'), JSON.stringify(assertProject(project), null, 2));
      return source;
    });
  } finally { await session.context.close().finally(() => session.browser.close()); }
}
