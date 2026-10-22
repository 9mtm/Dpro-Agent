import type {FastifyInstance} from 'fastify';
import {actorOf} from '../../auth/auth-gate.js';
import {requireAdmin,ScopeError} from '../../repositories/scope.js';
import {AgentNameInputError,AgentNameTakenError} from '../../services/agent-names.js';
import {PermissionsInputError} from '../../tools/agent-permissions.js';
import {SpecialtyTemplates,TemplateError} from '../../services/specialty-templates.js';
export async function specialtyTemplateRoutes(app:FastifyInstance,options:{store?:SpecialtyTemplates}={}){
 const store=options.store??new SpecialtyTemplates();await store.initialize();
 const owner=(request:any)=>{const actor=requireAdmin(actorOf(request));if(actor.kind!=='user'||actor.role!=='owner'||!actor.userId)throw new ScopeError(403,'Forbidden');return actor.userId;};
 const fail=(reply:any,e:unknown)=>reply.code(e instanceof ScopeError?e.status:e instanceof TemplateError?e.status:e instanceof AgentNameTakenError?409:e instanceof AgentNameInputError||e instanceof PermissionsInputError?400:503).send({code:e instanceof ScopeError?'forbidden':e instanceof TemplateError?e.code:e instanceof AgentNameTakenError?'name_taken':e instanceof AgentNameInputError?'invalid_input':e instanceof PermissionsInputError?e.code:'template_unavailable'});
 app.get('/api/specialty-templates',async(request,reply)=>{try{owner(request);return {templates:await store.list()};}catch(e){return fail(reply,e);}});
 app.get<{Params:{agentId:string}}>('/api/specialty-templates/assigned/:agentId',async(request,reply)=>{try{owner(request);return await store.assigned(request.params.agentId);}catch(e){return fail(reply,e);}});
 app.get('/api/specialty-templates/catalogue',async(request,reply)=>{try{owner(request);return await store.catalogue();}catch(e){return fail(reply,e);}});
 app.get<{Params:{id:string}}>('/api/specialty-templates/:id/agents',async(request,reply)=>{try{owner(request);return await store.agents(request.params.id);}catch(e){return fail(reply,e);}});
 app.post<{Params:{id:string}}>('/api/specialty-templates/:id/preview',{bodyLimit:100000},async(request,reply)=>{try{owner(request);return await store.impact(request.params.id,request.body);}catch(e){return fail(reply,e);}});
 app.get<{Params:{id:string}}>('/api/specialty-templates/:id/impact',async(request,reply)=>{try{owner(request);return await store.impact(request.params.id);}catch(e){return fail(reply,e);}});
 app.post<{Params:{id:string}}>('/api/specialty-templates/:id/assign',{bodyLimit:150000},async(request,reply)=>{try{return await store.assign(owner(request),request.params.id,request.body);}catch(e){return fail(reply,e);}});
 app.post<{Params:{id:string}}>('/api/specialty-templates/:id/agents',{bodyLimit:2048},async(request,reply)=>{try{return await store.link(owner(request),request.params.id,request.body);}catch(e){return fail(reply,e);}});
 app.get<{Params:{id:string}}>('/api/specialty-templates/:id',async(request,reply)=>{try{owner(request);return await store.read(request.params.id);}catch(e){return fail(reply,e);}});
 app.put<{Params:{id:string}}>('/api/specialty-templates/:id',{bodyLimit:100000},async(request,reply)=>{try{owner(request);return await store.save(request.params.id,request.body);}catch(e){return fail(reply,e);}});
 app.post('/api/specialty-templates/hire',{bodyLimit:2048},async(request,reply)=>{try{return await store.hire(owner(request),request.body);}catch(e){return fail(reply,e);}});
}
