import { createHash } from 'node:crypto';
import { readFile, mkdir, realpath } from 'node:fs/promises';
import pathAPI, { extname, isAbsolute, resolve } from 'node:path';
import { canonicalHash } from '../core/model.mjs';
import { atomicWriteFile, readProject, saveProject } from '../core/store.mjs';

export const mediaError = (code, message) => Object.assign(new Error(message), { code });
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** One confinement predicate shared by production file reads and portable tests. */
export function confinedMediaRelativePath(root,actual,paths=pathAPI) {
  const rel=paths.relative(root,actual);
  if(rel==='..'||rel.startsWith('..'+paths.sep)||paths.isAbsolute(rel))return null;
  return rel.split(paths.sep).join('/');
}

/** Resolves existing project media, refusing traversal and symlinks outside the project. */
export async function projectMediaPath(root, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw mediaError('INVALID_ASSET_PATH', 'Expected a relative project media path');
  const base = await realpath(root), absolute = await realpath(resolve(root, path));
  if (confinedMediaRelativePath(base, absolute) === null) throw mediaError('INVALID_ASSET_PATH', 'Media escapes the project');
  return absolute;
}

/** Imports bytes immutably; provider generation and host orchestration remain external. */
export async function importAsset(root, { path, origin }) {
  if (!origin || !['source', 'host', 'provider'].includes(origin.kind) || !origin.reference?.trim() || !origin.version?.trim()) throw mediaError('INVALID_ASSET_ORIGIN', 'Asset requires source, version and provenance');
  const bytes = await readFile(path); if (!bytes.length) throw mediaError('OUTPUT_INVALID', 'Cannot import an empty asset');
  const hash = sha256(bytes), extension = extname(path).toLowerCase();
  const types = { '.wav':'audio/wav','.aiff':'audio/aiff','.aif':'audio/aiff','.mp3':'audio/mpeg','.m4a':'audio/mp4','.flac':'audio/flac','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.mp4':'video/mp4','.webm':'video/webm','.json':'application/json','.ttf':'font/ttf','.otf':'font/otf','.woff':'font/woff','.woff2':'font/woff2' };
  if (!types[extension]) throw mediaError('UNSUPPORTED_ASSET', 'Unsupported media extension');
  const asset = { id:`asset-${canonicalHash({hash,origin}).slice(0,24)}`,path:`assets/${hash}${extension}`,sha256:hash,mediaType:types[extension],origin };
  await mkdir(resolve(root,'assets'),{recursive:true}); await atomicWriteFile(resolve(root,asset.path),bytes);
  const project=await readProject(root),existing=project.assets.find(a=>a.id===asset.id);
  if (!existing) await saveProject(root,{...project,assets:[...project.assets,asset]},project.revision);
  return existing ?? asset;
}

export async function verifiedAssetPath(root, asset) {
  const path = await projectMediaPath(root,asset.path);
  if(sha256(await readFile(path))!==asset.sha256) throw mediaError('ASSET_HASH_MISMATCH',`Asset ${asset.id ?? asset.path} changed`);
  return path;
}
