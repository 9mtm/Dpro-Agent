import type {ToolExecutionContext} from '../types.js';
import type {DrawerRef} from '../../memory/drawers.js';
import {loadRunPermissions,loadRunPermissionsSync} from '../agent-permissions.js';
type Context=Pick<ToolExecutionContext,'agentId'|'delegatedFrom'|'accessOwnerId'|'userId'|'memoryDrawers'>;
function projectDrawers(context:Context,allowed:Map<string,boolean>):DrawerRef[]|undefined{
 const drawers=context.memoryDrawers;if(!drawers)return;
 const primary=drawers.find(d=>d.kind==='project')?.key;
 return drawers.filter(d=>d.kind!=='project'||!!d.key&&allowed.get(d.key)===true).map(d=>d.kind==='project'&&d.key!==primary?{...d,readOnly:true}:d);
}
/** Recheck each project, including approval replay; one project's permission never opens its siblings. */
export async function narrowProjectMemory(context:Context):Promise<DrawerRef[]|undefined>{
 if(!context.agentId||!context.memoryDrawers)return context.memoryDrawers;
 const allowed=new Map<string,boolean>();
 for(const project of new Set(context.memoryDrawers.filter(d=>d.kind==='project'&&d.key).map(d=>d.key!))){
  try{allowed.set(project,(await loadRunPermissions(context.agentId,context.delegatedFrom??[],{userId:context.accessOwnerId??context.userId??null,project})).memoryRead.includes('project'));}catch{allowed.set(project,false);}
 }
 return projectDrawers(context,allowed);
}
export function narrowProjectMemorySync(context:Context):DrawerRef[]|undefined{
 if(!context.agentId||!context.memoryDrawers)return context.memoryDrawers;
 const allowed=new Map<string,boolean>();
 for(const project of new Set(context.memoryDrawers.filter(d=>d.kind==='project'&&d.key).map(d=>d.key!))){
  try{allowed.set(project,loadRunPermissionsSync(context.agentId,context.delegatedFrom??[],{userId:context.accessOwnerId??context.userId??null,project}).memoryRead.includes('project'));}catch{allowed.set(project,false);}
 }
 return projectDrawers(context,allowed);
}
