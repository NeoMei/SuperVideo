import {validateBookPlan} from '../modes/book.mjs';
import {assertWebsiteBindings} from '../modes/website.mjs';
/** Validate the full declared mode before projecting sample scenes. Generic
 * storage remains readable; unconfigured book drafts may be saved, not approved. */
export function assertModePlan(project,{draft=false}={}) {
 assertWebsiteBindings(project);
 if(project.mode==='book'&&!(draft&&project.settings.book===undefined)) {
  const result=validateBookPlan(project);
  if(result.status!=='succeeded')throw Object.assign(new Error(result.error.detail),{code:result.error.code});
 }
}
