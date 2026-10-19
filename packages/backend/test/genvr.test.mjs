import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dpro-genvr-'));process.env.AGENT_PLAYER_DATA_DIR=root;process.env.DATABASE_PATH=path.join(root,'agent-player.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
for(const id of ['studio-owner','studio-other'])db.prepare("INSERT INTO users(id,email,username,password_hash,role,status) VALUES(?,?,?,'fixture','owner','active')").run(id,id+'@example.invalid',id);
const {default:Fastify}=await import('fastify');const {registerAuthGate}=await import('../src/auth/auth-gate.ts');const {generateToken}=await import('../src/auth/jwt.ts');const {genvrRoutes}=await import('../src/api/routes/genvr.ts');
const app=Fastify();registerAuthGate(app);await app.register(genvrRoutes);await app.ready();const headers=id=>({authorization:'Bearer '+generateToken(id,1)});const owner=headers('studio-owner'),other=headers('studio-other'),project={format:'genvr-studio',version:1,id:'fictional-world',title:'Fictional garden',world:{items:[]},play:{devices:['computer']}};
test.after(async()=>{await app.close();closeDatabase();fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})});
test('private Studio projects persist without account creation and fail closed on stale writes',async()=>{
 const put=async(revision,p=project)=>app.inject({method:'PUT',url:'/api/genvr/projects/'+p.id,headers:owner,payload:{project:p,revision}});
 assert.equal((await app.inject({url:'/api/genvr/projects'})).statusCode,401);
 assert.deepEqual((await app.inject({url:'/api/genvr/projects',headers:owner})).json(),{projects:[]});
 const saved=await put(0);assert.equal(saved.statusCode,200);assert.equal(saved.json().revision,1);
 assert.equal((await app.inject({url:'/api/genvr/projects/'+project.id,headers:other})).statusCode,404);
 assert.deepEqual((await app.inject({url:'/api/genvr/projects',headers:other})).json().projects,[]);
 assert.equal((await put(0,{...project,title:'Stale window'})).statusCode,409);
 assert.deepEqual((await app.inject({url:'/api/genvr/projects/'+project.id,headers:owner})).json(),{project,revision:1,agents:[]});
 assert.equal((await put(1,{...project,title:'Saved update'})).json().revision,2);
 const row=db.prepare('SELECT document,revision FROM genvr_projects WHERE user_id=? AND id=?').get('studio-owner',project.id);assert.equal(JSON.parse(row.document).title,'Saved update');assert.equal(row.revision,2);
 assert.equal((await app.inject({method:'PUT',url:'/api/genvr/projects/bad',headers:owner,payload:{project,revision:0}})).statusCode,400);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM genvr_projects').get().n,1);
});

test('space membership and looks stay private and survive ordinary saves',async()=>{
 const roster=(await app.inject({url:'/api/genvr/agents',headers:owner})).json().agents;assert.ok(roster.length>0);const aid=roster[0].id;
 const save=async(agents,revision=0,pid='team-space',headers=owner)=>app.inject({method:'PUT',url:'/api/genvr/projects/'+pid,headers,payload:{project:{...project,id:pid},revision,...(agents===undefined?{}:{agents})}});
 assert.equal((await save([{id:aid,avatar:3}])).statusCode,200);
 assert.deepEqual((await app.inject({url:'/api/genvr/projects/team-space',headers:owner})).json().agents,[{id:aid,avatar:3}]);
 assert.equal((await save([{id:aid,avatar:7}],0)).statusCode,409);assert.equal((await save(undefined,1)).statusCode,200);
 assert.equal((await app.inject({url:'/api/genvr/projects',headers:owner})).json().projects.find(p=>p.id==='team-space').agentCount,1);
 for(const agents of [[{id:aid,avatar:9}],[{id:aid,avatar:1},{id:aid,avatar:2}],[{id:'not-an-agent',avatar:1}],[{id:aid,avatar:1,permissions:['all']}]])assert.equal((await save(agents,2)).statusCode,400);
 assert.equal((await save([{id:aid,avatar:5}],2)).statusCode,200);
 assert.equal((await app.inject({url:'/api/genvr/agents',headers:owner})).json().agents.find(a=>a.id===aid).avatar,5);
 assert.equal((await app.inject({url:'/api/genvr/agents',headers:other})).json().agents.find(a=>a.id===aid).avatar,null);
 assert.equal((await save([],0,'team-space',other)).statusCode,200);assert.deepEqual((await app.inject({url:'/api/genvr/projects/team-space',headers:other})).json().agents,[]);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM genvr_members WHERE user_id=?').get('studio-owner').n,1);
});
