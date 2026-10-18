import type { FastifyInstance } from 'fastify';
import { LocalMcpImport, LocalMcpError } from '../../mcp-client/local-import.js';
import { logAudit } from '../../services/audit-logger.js';
export async function mcpImportRoutes(app: FastifyInstance, options: {store?: LocalMcpImport} = {}) {
 const store=options.store??new LocalMcpImport();
 for(const action of ['scan','preview','import'] as const) app.post<{Body:Record<string,unknown>}>('/api/mcp-import/'+action,{config:{access:'owner'}},async(request,reply)=>{
  const user=request.authUser;if(!user)return reply.code(401).send({code:'unauthenticated'});if(user.role!=='owner')return reply.code(403).send({code:'forbidden'});
  const body=request.body;const keys=action==='scan'?[]:action==='preview'?['scanId','sourceId']:['scanId','sourceId','hash'];
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!==keys.sort().join(',')||keys.some(k=>typeof body[k]!=='string'||!(k==='hash'?/^[a-f0-9]{64}$/:/^[a-f0-9-]{36}$/).test(body[k] as string)))return reply.code(400).send({code:'invalid_input'});
  try {
   if(action==='scan')return await store.scan(user.id);
   if(action==='preview')return await store.preview(user.id,String(body.scanId),String(body.sourceId));
   const result=await store.import(user.id,String(body.scanId),String(body.sourceId),String(body.hash));
   logAudit({event_type:'mcp.server.change',event_category:'system',severity:'info',user_id:user.id,action:'mcp_server.import_disabled',success:true,resource_type:'mcp_server',resource_id:result.id,metadata:{duplicate:result.duplicate}});return result;
  }catch(error){if(error instanceof LocalMcpError)return reply.code(error.status).send({code:error.code});return reply.code(400).send({code:'import_unavailable'});}
 });
}
