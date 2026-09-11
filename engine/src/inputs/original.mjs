import {readFile} from 'node:fs/promises';
import {projectMediaPath,sha256,mediaError} from '../providers/assets.mjs';
/** Resolve only a local SHA-bound original. Legacy conventional archives can be
 * recognized by exact bytes; never substitute an original host file for a missing archive. */
export async function resolveSourceOriginal(root,source) {
 if(!['pptx','ppt','docx','doc','md'].includes(source.kind))throw mediaError('SOURCE_UNAVAILABLE','Only local document originals can be archived');
 const candidates=source.archive?[source.archive]:[
  {path:`sources/${source.id}/original.${source.kind}`,sha256:source.hash},
  {path:`sources/originals/${source.hash}.${source.kind}`,sha256:source.hash},
 ];
 for(const archive of candidates){
  if(archive.sha256!==source.hash)throw mediaError('ASSET_HASH_MISMATCH','Source archive descriptor differs from the imported version');
  let path,bytes;
  try{path=await projectMediaPath(root,archive.path);bytes=await readFile(path);}
  catch(error){if(error.code==='ENOENT'&&!source.archive)continue;if(error.code==='ENOENT')throw mediaError('SOURCE_UNAVAILABLE',`Missing source archive ${archive.path}; restore these exact imported bytes`);throw error;}
  if(sha256(bytes)!==source.hash)throw mediaError('ASSET_HASH_MISMATCH','Archived original source version changed');
  return {path,bytes,archive:{...archive}};
 }
 throw mediaError('SOURCE_UNAVAILABLE','No hash-bound original archive is available. Restore the original archive or explicitly re-ingest the reviewed source version; the host provenance path is not a fallback');
}
