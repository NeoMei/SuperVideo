import {assertModePlan} from './readiness.mjs';
import {readFile} from 'node:fs/promises';
import {assertProject,canonicalHash} from './model.mjs';
import {readProject,saveProject} from './store.mjs';
import {isCurrent,approvalSettings} from './approvals.mjs';
import {invalidateJobs} from './jobs.mjs';
import {projectMediaPath,sha256,mediaError} from '../providers/assets.mjs';
import {assertRenderProject} from '../render/schema.mjs';

async function refresh(p,root){let changed=false;const ids=new Set((p.settings.components??[]).flatMap(d=>d.files.map(f=>f.assetId)));for(const asset of p.assets.filter(a=>ids.has(a.id))){if(asset.origin.kind!=='host')throw mediaError('COMPONENT_REVIEW_REQUIRED','Component source is not host authored');const hash=sha256(await readFile(await projectMediaPath(root,asset.path)));if(hash!==asset.sha256){asset.sha256=hash;changed=true;}}return changed;}
export async function refreshComponentSources(root){const p=await readProject(root);if(!await refresh(p,root))return p;p.approvals=p.approvals.filter(a=>isCurrent(p,a));await invalidateJobs(root,p);return saveProject(root,p,p.revision);}

/** A bounded scene edit, never JSON Patch or executable host source. */
export async function revise(root,request,expectedRevision){
 if(!request||Object.keys(request).some(k=>!['sceneId','field','value'].includes(k))||!['sentences','visual','cues'].includes(request.field))throw mediaError('INVALID_REVISION_REQUEST','Use sceneId with sentences, visual or cues');
 canonicalHash(request); // Reject functions, undefined, prototypes and non-JSON values.
 const p=await readProject(root);if(p.revision!==expectedRevision)throw mediaError('REVISION_CONFLICT','Project revision changed');
 const scene=p.scenes.find(s=>s.id===request.sceneId);if(!scene)throw mediaError('INVALID_REVISION_REQUEST','Unknown scene');
 if(request.field==='sentences'&&(!Array.isArray(request.value)||request.value.some(s=>Object.keys(s).some(k=>!['id','text','voiceId','audioRate','eventId'].includes(k)))))throw mediaError('INVALID_REVISION_REQUEST','Unknown sentence fields');
 scene[request.field]=structuredClone(request.value);assertProject(p);await refresh(p,root);
 // A stale source review is allowed to be saved, but cannot render or approve.
 try{assertRenderProject(p);for(const s of p.scenes)approvalSettings(p,'script',[s.id]);}catch(error){if(error.code!=='COMPONENT_REVIEW_REQUIRED')throw error;}
 assertModePlan(p,{draft:true});
 p.approvals=p.approvals.filter(a=>isCurrent(p,a));const invalidatedJobIds=await invalidateJobs(root,p);
 return {project:await saveProject(root,p,expectedRevision),invalidatedJobIds};
}
