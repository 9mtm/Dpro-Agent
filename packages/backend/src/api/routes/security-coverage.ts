import type {FastifyInstance} from 'fastify';
import type {Tool} from '../../tools/types.js';
import {authorizeActiveRole} from '../../auth/route-guards.js';
import {createAgentToolsRegistry} from '../../tools/index.js';
import {permissionCategory,PERMISSION_CATEGORIES} from '../../tools/agent-permissions.js';
import {approvalCategory} from '../../tools/approvals.js';
import {isToolExecClass,isToolObjectAllowedByExecPolicy} from '../../tools/exec-policy.js';
type Metadata=Pick<Tool,'name'|'mcp'|'execClass'|'requiresApproval'|'extensionId'|'selfOnly'>;
const clean=(value:string)=>value.slice(0,240).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'');
export function coverageView(tools:ReadonlyArray<Metadata>){
 return {scope:'workspace_catalogue' as const,tools:tools.slice(0,1500).map(tool=>{
  const category=permissionCategory(tool),approval=approvalCategory(tool);
  return {name:clean(tool.name),category:typeof category==='string'&&PERMISSION_CATEGORIES.includes(category)?category:null,
   independentApproval:typeof approval==='string',executionClass:isToolExecClass(tool),allowedByServer:isToolObjectAllowedByExecPolicy(tool),
   origin:tool.mcp?'mcp':tool.extensionId?'extension':'builtin',selfOnly:tool.selfOnly===true};
 }).sort((a,b)=>a.name.localeCompare(b.name)),limited:tools.length>1500,
 separatePaths:['coding_apps','terminal','workspace_scheduler']};
}
export async function securityCoverageRoutes(app:FastifyInstance,options:{registered?:()=>Promise<ReadonlyArray<Metadata>>}={}){
 app.get('/api/security/coverage',{config:{access:'owner'}},async(request,reply)=>{
  if(!authorizeActiveRole(request,reply,['owner']))return;
  if(Object.keys(request.query as object).length)return reply.code(400).send({code:'invalid_input'});
  try{
   const tools=options.registered?await options.registered():(await createAgentToolsRegistry({workspaceDir:process.cwd()})).listRegistered();
   return coverageView(tools);
  }catch{return reply.code(503).send({code:'coverage_unavailable'});}
 });
}
