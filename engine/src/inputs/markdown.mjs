import { readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { beginExtraction, putAsset, finishExtraction, digest, inputError } from './documents.mjs';

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const textOf = node => node.value ?? node.alt ?? node.children?.map(textOf).join(node.type === 'tableRow' ? '\t' : node.type === 'table' ? '\n' : '') ?? '';
const imageType = bytes => {
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return ['image/png', 'png'];
  if (bytes.subarray(0, 3).toString('hex') === 'ffd8ff') return ['image/jpeg', 'jpg'];
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return ['image/gif', 'gif'];
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return ['image/webp', 'webp'];
  throw new Error('Unsupported or invalid image signature (PNG/JPEG/GIF/WebP required)');
};

/** Extracts a locked remark AST. config.projectRoot owns copied originals and resolved image assets. */
export async function extractMarkdown(path, config = {}) {
  const ctx = await beginExtraction(path, config);
  if (ctx.cached) return ctx.cached;
  try {
    if (ctx.kind !== 'md') throw inputError('UNSUPPORTED_INPUT', 'extractMarkdown requires .md');
    const ast = parser.parse(ctx.bytes.toString('utf8'));
    await putAsset(ctx, 'markdown-ast.json', Buffer.from(JSON.stringify(ast)), 'application/json', `${path}#remark-ast`);
    const definitions = new Map();
    const collectDefinitions = node => {
      if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
      for (const child of node.children ?? []) collectDefinitions(child);
    };
    collectDefinitions(ast);
    const savedImages = new Map();
    const download = async url => {
      const response = await fetch(url, { signal: AbortSignal.timeout(config.imageTimeoutMs ?? 10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 20 * 1024 * 1024) throw new Error('Image exceeds 20 MiB'); chunks.push(chunk); }
      return Buffer.concat(chunks);
    };
    const walk = async (node, trail, parent) => {
      const start = node.position?.start;
      const locator = `md:${trail}:${start?.line ?? 1}:${start?.column ?? 1}`;
      const kind = ({ heading: 'heading', paragraph: 'paragraph', list: 'paragraph', listItem: 'paragraph', blockquote: 'paragraph', code: 'code', math: 'math', inlineMath: 'math', table: 'table', image: 'image', imageReference: 'image', link: 'link', linkReference: 'link', html: 'paragraph', thematicBreak: 'paragraph', footnoteDefinition: 'paragraph', footnoteReference: 'link' })[node.type];
      let current = parent;
      if (kind) {
        // Container nodes preserve AST ancestry without duplicating descendants' narration.
        const text = ['list', 'listItem', 'blockquote'].includes(node.type) ? '' : textOf(node);
        current = ctx.node(kind, text, locator, parent ? { parentId: parent.id } : {});
        if (node.type === 'html') ctx.warning('UNSUPPORTED_MARKDOWN_HTML', locator, 'Raw HTML is retained as source text and AST; it is not executed or rendered during ingestion.');
        if (kind === 'image') {
          const url = node.url ?? definitions.get(node.identifier)?.url;
          try {
            if (!url) throw new Error(`Undefined image reference: ${node.identifier}`);
            if (/^[a-z][a-z\d+.-]*:/i.test(url) && !/^https?:/i.test(url)) throw new Error('Only relative paths and HTTP(S) image URLs are supported');
            const reference = /^https?:/i.test(url) ? url : resolve(dirname(path), decodeURIComponent(url));
            let asset = savedImages.get(reference);
            if (!asset) {
              const bytes = /^https?:/i.test(url) ? await download(url) : await readFile(reference);
              if (bytes.length > 20 * 1024 * 1024) throw new Error('Image exceeds 20 MiB');
              const [mediaType, extension] = imageType(bytes);
              asset = await putAsset(ctx, `media/${digest(reference).slice(0, 20)}-${digest(bytes).slice(0, 20)}.${extension}`, bytes, mediaType, reference);
              savedImages.set(reference, asset);
            }
            current.assetIds.push(asset.id);
          } catch (error) { ctx.warning('IMAGE_FETCH_FAILED', locator, `${url ?? node.identifier}: ${error.message}`); }
        }
      }
      // Tables/code are represented as complete semantic units; inline math/images/links inside tables are still visited.
      for (const [i, child] of (node.children ?? []).entries()) await walk(child, `${trail}/${child.type}[${i}]`, current);
    };
    for (const [i, node] of ast.children.entries()) await walk(node, `${node.type}[${i}]`, undefined);
    return await finishExtraction(ctx);
  } catch (error) { await rm(ctx.workspace, { recursive: true, force: true }); throw error; }
}
