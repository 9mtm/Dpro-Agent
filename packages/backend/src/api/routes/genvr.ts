import { ensureGenvrMcp } from '../../mcp-client/genvr-local.js';
/** Private local Studio snapshots. Platform publication and account linking are separate. */
import type { FastifyInstance } from 'fastify';
import { actorOf } from '../../auth/auth-gate.js';
import { requireAccount, ScopeError } from '../../repositories/scope.js';
import { genvrMarketRoutes } from './genvr-market.js';
import { repositories } from '../../repositories/index.js';
import { q, sql, one, run, type Step } from '../../repositories/sql-steps.js';
const validTeam=(team:unknown):team is {id:string;avatar:number}[]=>Array.isArray(team)&&team.length<=200&&new Set(team.map(a=>a?.id)).size===team.length&&team.every(a=>object(a)&&Object.keys(a).sort().join(',')==='avatar,id'&&id(a.id)&&Number.isInteger(a.avatar)&&a.avatar>=0&&a.avatar<8);
const MAX=64*1024*1024;
const id=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value);
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export async function genvrRoutes(app:FastifyInstance,options:{marketFetch?:typeof fetch}={}){
 app.post('/api/genvr/mcp/bootstrap',{config:{access:'owner'}},async(request,reply)=>{if(!request.authUser||request.authUser.role!=='owner')return reply.code(403).send({code:'forbidden'});if(!request.body||typeof request.body!=='object'||Array.isArray(request.body)||Object.keys(request.body).length)return reply.code(400).send({code:'invalid_input'});return ensureGenvrMcp(request.authUser.id);});
 await genvrMarketRoutes(app,options.marketFetch);
 // No global SDK/account state: a project is always keyed by the active local user.
 if(q.dialect==='sqlite')await q.run('CREATE TABLE IF NOT EXISTS genvr_projects (user_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, document TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(user_id,id))');
 if(q.dialect==='sqlite'){await q.run('CREATE TABLE IF NOT EXISTS genvr_agent_looks (user_id TEXT NOT NULL, agent_id TEXT NOT NULL, avatar INTEGER NOT NULL, PRIMARY KEY(user_id,agent_id))');await q.run('CREATE TABLE IF NOT EXISTS genvr_members (user_id TEXT NOT NULL, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY(user_id,project_id,agent_id))');}
 const roster=async(request:any)=>{user(request);return (await repositories.agents.listConfigs(actorOf(request)!)).filter(a=>a.id!=='small-local-agent');};
 const team=async(owner:string,project:string)=>q.all('SELECT m.agent_id AS id,l.avatar FROM genvr_members m JOIN genvr_agent_looks l ON l.user_id=m.user_id AND l.agent_id=m.agent_id WHERE m.user_id=? AND m.project_id=? ORDER BY m.agent_id',owner,project);
 const user=(request:any)=>{const actor=requireAccount(actorOf(request));if(actor.kind!=='user'||!actor.userId)throw new ScopeError(403,'Forbidden');return actor.userId;};
 const error=(reply:any,e:unknown)=>reply.code(e instanceof ScopeError?e.status:e instanceof TypeError?400:e instanceof Error&&e.message==='conflict'?409:500).send({code:e instanceof ScopeError?e.code:e instanceof TypeError?'invalid_input':e instanceof Error&&e.message==='conflict'?'conflict':'unavailable'});
 app.get('/api/genvr/agents',async(request,reply)=>{try{const owner=user(request);if(q.dialect!=='sqlite')return reply.code(409).send({code:'unsupported_store'});const looks=await q.all<{agent_id:string;avatar:number}>('SELECT agent_id,avatar FROM genvr_agent_looks WHERE user_id=?',owner);return {agents:(await roster(request)).map(a=>({id:a.id,name:a.name,avatar:looks.find(l=>l.agent_id===a.id)?.avatar??null}))};}catch(e){return error(reply,e);}});
 app.get('/api/genvr/projects',async(request,reply)=>{try{const owner=user(request);if(q.dialect!=='sqlite')return reply.code(409).send({code:'unsupported_store'});return {projects:await q.all('SELECT p.id,p.title,(SELECT COUNT(*) FROM genvr_members m WHERE m.user_id=p.user_id AND m.project_id=p.id) AS agentCount FROM genvr_projects p WHERE p.user_id=? ORDER BY p.title,p.id LIMIT 1000',owner)};}catch(e){return error(reply,e);}});
 app.get<{Params:{id:string}}>('/api/genvr/projects/:id',async(request,reply)=>{try{const owner=user(request);if(!id(request.params.id))throw new TypeError();if(q.dialect!=='sqlite')return reply.code(409).send({code:'unsupported_store'});const row=await q.one<{document:string;revision:number}>('SELECT document,revision FROM genvr_projects WHERE user_id=? AND id=?',owner,request.params.id);return row?{project:JSON.parse(row.document),revision:row.revision,agents:await team(owner,request.params.id)}:reply.code(404).send({code:'not_found'});}catch(e){return error(reply,e);}});
 app.put<{Params:{id:string}}>('/api/genvr/projects/:id',{bodyLimit:MAX+65536},async(request,reply)=>{try{
  const owner=user(request),body=request.body;if(q.dialect!=='sqlite')return reply.code(409).send({code:'unsupported_store'});
  if(!id(request.params.id)||!object(body)||!['project,revision','agents,project,revision'].includes(Object.keys(body).sort().join(','))||!Number.isSafeInteger(body.revision)||body.revision<0||body.revision>=Number.MAX_SAFE_INTEGER)throw new TypeError();
  const p=body.project;if(!object(p)||p.id!==request.params.id||p.format!=='genvr-studio'||p.version!==1||typeof p.title!=='string'||!p.title.trim()||p.title.length>200||!object(p.world)||!object(p.play))throw new TypeError();
  if(body.agents!==undefined){if(!validTeam(body.agents))throw new TypeError();const available=new Set((await roster(request)).map(a=>a.id));if(!body.agents.every((a:any)=>available.has(a.id)))throw new TypeError();}
  const document=JSON.stringify(p);if(Buffer.byteLength(document)>MAX)throw new TypeError();
  const revision=await sql().tx(function*():Step<number>{
   const existing=yield* one<{revision:number}>('SELECT revision FROM genvr_projects WHERE user_id=? AND id=?',owner,p.id);
   if(!existing){const count=yield* one<{total:number}>('SELECT COUNT(*) AS total FROM genvr_projects WHERE user_id=?',owner);if((count?.total??0)>=1000)throw new TypeError();}
   if((existing?.revision??0)!==body.revision)throw Error('conflict');
   const next=body.revision+1;yield* run('INSERT INTO genvr_projects(user_id,id,title,document,revision) VALUES(?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET title=excluded.title,document=excluded.document,revision=excluded.revision',owner,p.id,p.title,document,next);if(body.agents!==undefined){yield* run('DELETE FROM genvr_members WHERE user_id=? AND project_id=?',owner,p.id);for(const agent of body.agents){yield* run('INSERT INTO genvr_agent_looks(user_id,agent_id,avatar) VALUES(?,?,?) ON CONFLICT(user_id,agent_id) DO UPDATE SET avatar=excluded.avatar',owner,agent.id,agent.avatar);yield* run('INSERT INTO genvr_members(user_id,project_id,agent_id) VALUES(?,?,?)',owner,p.id,agent.id);}}return next;
  });return {saved:true,revision};
 }catch(e){return error(reply,e);}});
}
