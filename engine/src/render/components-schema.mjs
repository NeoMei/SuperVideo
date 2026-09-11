import {canonicalHash} from '../core/model.mjs';
export const componentError=(detail)=>Object.assign(new Error(detail),{code:'COMPONENT_REVIEW_REQUIRED'});
export function componentDigest(project,descriptor){return canonicalHash({id:descriptor.id,entry:descriptor.entry,model:descriptor.model,checks:descriptor.checks,files:descriptor.files.map(f=>({path:f.path,asset:project.assets.find(a=>a.id===f.assetId)}))});}
export function componentSettings(project,scope=project.scenes.map(s=>s.id)){
 const ids=new Set(project.scenes.filter(s=>scope.includes(s.id)).map(s=>s.visual.component));
 const all=project.settings.components??[];
 if(!Array.isArray(all)||all.some(d=>!d||typeof d!=='object'||Array.isArray(d))||new Set(all.map(d=>d.id)).size!==all.length)throw componentError('Components must have unique IDs');
 return all.filter(d=>ids.has(d.id)).map(d=>{
  if(typeof d.id!=='string'||['text','steps','comparison','__proto__','constructor','prototype'].includes(d.id)||Object.keys(d).some(k=>!['id','entry','model','files','checks','review'].includes(k))||!/^[-\w]+$/.test(d.id)||!Array.isArray(d.files)||!d.files.length||d.files.length>20||!Array.isArray(d.checks)||!d.checks.length||d.checks.some(c=>!/^[$A-Z_a-z][$\w]*$/.test(c)))throw componentError('Invalid component descriptor');
  if(d.files.some(f=>!f||typeof f!=='object'||Array.isArray(f))||new Set(d.files.map(f=>f.path)).size!==d.files.length)throw componentError('Duplicate component file');
  for(const f of d.files){const a=project.assets.find(a=>a.id===f.assetId);if(Object.keys(f).some(k=>!['path','assetId'].includes(k))||!/^[-\w/]+\.(mjs|tsx)$/.test(f.path)||f.path.split('/').some(p=>!p||p==='..')||!a||a.origin.kind!=='host')throw componentError('Component files must be registered host-authored relative source assets');}
  if(!d.files.some(f=>f.path===d.entry)||!d.files.some(f=>f.path===d.model)||!d.entry.endsWith('.tsx')||!d.model.endsWith('.mjs'))throw componentError('Entry/model must resolve to registered TSX/MJS');
  if(!d.review||Object.keys(d.review).some(k=>!['digest','evidence'].includes(k))||typeof d.review.evidence!=='string'||!d.review.evidence.trim()||d.review.digest!==componentDigest(project,d))throw componentError('Host review must bind every current source hash');
  return structuredClone(d);
 });
}
