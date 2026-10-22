import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dpro-coverage-'));
process.env.AGENT_PLAYER_DATA_DIR=root;process.env.DATABASE_PATH=path.join(root,'test.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');delete process.env.AGENT_EXEC_TOOLS;
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
for(const [id,role] of [['coverage-owner','owner'],['coverage-member','user'],['coverage-admin','admin']])db.prepare("INSERT INTO users(id,email,username,password_hash,role,status) VALUES(?,?,?,'fixture',?,'active')").run(id,id+'@example.invalid',id,role);
const {default:Fastify}=await import('fastify'),{registerAuthGate}=await import('../src/auth/auth-gate.ts'),{generateToken}=await import('../src/auth/jwt.ts'),{securityCoverageRoutes,coverageView}=await import('../src/api/routes/security-coverage.ts');
const fixture=[{name:'web_fetch',description:'fixture-secret',input_schema:{token:'private'}},{name:'unmapped_fixture',requiresApproval:true},{name:'execute_code',execClass:true},{name:'mcp__fixture__read',mcp:{serverId:'private-id',serverName:'fixture',toolName:'read',qualifiedName:'mcp:fixture:read'}}];
let reads=0;const app=Fastify();registerAuthGate(app);await app.register(securityCoverageRoutes,{registered:async()=>{reads++;return fixture;}});await app.ready();
const call=(user,suffix='',method='GET')=>app.inject({method,url:'/api/security/coverage'+suffix,headers:user?{authorization:'Bearer '+generateToken(user,1)}:{}});
test.after(async()=>{await app.close();closeDatabase();fs.rmSync(root,{recursive:true,force:true});});
test('coverage is exact owner-only metadata and cannot mutate policies or reveal configuration',async()=>{
 assert.equal((await call(null)).statusCode,401);for(const user of ['coverage-member','coverage-admin'])assert.equal((await call(user)).statusCode,403);assert.equal(reads,0);
 const before=db.prepare('SELECT * FROM agent_permissions ORDER BY agent_id').all();
 assert.equal((await call('coverage-owner','?agentId=other')).statusCode,400);assert.equal(reads,0);
 assert.equal((await call('coverage-owner','','POST')).statusCode,404);
 const r=await call('coverage-owner');assert.equal(r.statusCode,200,r.body);assert.equal(reads,1);const body=r.json();
 assert.equal(body.scope,'workspace_catalogue');assert.equal(body.tools.find(t=>t.name==='web_fetch').category,'network');
 assert.equal(body.tools.find(t=>t.name==='unmapped_fixture').category,null);assert.equal(body.tools.find(t=>t.name==='unmapped_fixture').independentApproval,true);
 assert.equal(body.tools.find(t=>t.name==='execute_code').allowedByServer,false);assert.equal(body.tools.find(t=>t.name==='mcp__fixture__read').origin,'mcp');
 for(const secret of ['fixture-secret','private-id','input_schema','token'])assert.ok(!r.body.includes(secret));
 assert.deepEqual(db.prepare('SELECT * FROM agent_permissions ORDER BY agent_id').all(),before);
});
test('unknown classification never becomes an allowed category; inventory is bounded',()=>{
 const view=coverageView([{name:'constructor'},...Array.from({length:1600},(_,i)=>({name:'fixture_'+i}))]);
 assert.equal(view.limited,true);assert.equal(view.tools.length,1500);assert.equal(view.tools.find(t=>t.name==='constructor').category,null);
});

test('production inventory reads registry metadata without network requests or tool execution',async()=>{
 const realFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Network forbidden in coverage test');};
 const live=Fastify();registerAuthGate(live);await live.register(securityCoverageRoutes);await live.ready();
 try{const r=await live.inject({url:'/api/security/coverage',headers:{authorization:'Bearer '+generateToken('coverage-owner',1)}});assert.equal(r.statusCode,200,r.body);assert.ok(r.json().tools.length>0);assert.equal(calls,0);}
 finally{globalThis.fetch=realFetch;await live.close();}
});
