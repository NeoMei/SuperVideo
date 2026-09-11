import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { assertProject } from '../core/model.mjs';
import { readProject, withProjectLock, atomicWriteFile } from '../core/store.mjs';
import { inspectInput, extractDocument, inputError, digest } from './documents.mjs';
import { extractMarkdown } from './markdown.mjs';

/** Imports immutable source versions, merging once under the project lock. config.projectRoot is supplied from root. */
export async function ingestFiles(root, paths, config = {}) {
  if (!Array.isArray(paths) || !paths.every(p => typeof p === 'string' && p.length)) throw inputError('INVALID_REQUEST', 'paths must be an array of nonempty strings');
  return withProjectLock(root, async () => {
    const project = await readProject(root);
    const selected = [];
    let changed = false;
    for (const path of paths) {
      const { kind, hash } = await inspectInput(path);
      const existing = project.sources.find(s => s.kind === kind && s.hash === hash);
      if (existing) {
        await validateRegisteredAssets(root, existing, project.assets);
        selected.push(existing); continue;
      }
      const result = await (kind === 'md' ? extractMarkdown : extractDocument)(path, { ...config, projectRoot: root });
      project.sources.push(result.source);
      for (const asset of result.assets) if (!project.assets.some(a => a.id === asset.id)) project.assets.push(asset);
      selected.push(result.source); changed = true;
    }
    if (changed) {
      project.revision += 1;
      await atomicWriteFile(join(root, 'project.json'), `${JSON.stringify(assertProject(project), null, 2)}\n`);
    }
    return selected;
  });
}

async function validateRegisteredAssets(root, source, assets) {
  const referenced = new Set(source.nodes.flatMap(node => node.assetIds));
  // Originals, conversions and evidence belong to the source directory even
  // when no logical node references them; validate those as well as node assets.
  const ownedPrefix = `sources/${source.id}/`;
  for (const asset of assets.filter(a => a.path.startsWith(ownedPrefix) || referenced.has(a.id))) {
    try {
      if (digest(await readFile(join(root, asset.path))) !== asset.sha256) throw new Error('asset hash mismatch');
    } catch (error) {
      throw inputError('SOURCE_CACHE_INVALID', `${asset.path}: ${error.message}`);
    }
  }
}
