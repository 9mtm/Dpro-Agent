import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'agent-memory-api-'));process.env.AGENT_PLAYER_DATA_DIR=join(dir,'data');process.env.DATABASE_PATH=join(dir,'auth.db');mkdirSync(process.env.AGENT_PLAYER_DATA_DIR,{mode:0o700});process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();for(const [id,role]of [['memory-owner','owner'],['memory-member','user']])db.prepare("INSERT INTO users(id,email,username,password_hash,role,status) VALUES(?,?,?,'fixture',?,'active')").run(id,id+'@example.invalid',id,role);
const {default:Fastify}=await import('fastify'),{registerAuthGate}=await import('../src/auth/auth-gate.ts'),{generateToken}=await import('../src/auth/jwt.ts'),{agentFilesRoutes}=await import('../src/api/routes/agent-files.ts');const app=Fastify();registerAuthGate(app);await app.register(agentFilesRoutes);await app.ready();test.after(async()=>{await app.close();closeDatabase();});
const request=(method,body,id='memory-owner',suffix='')=>app.inject({method,url:'/api/agents/fixture-agent/memory'+suffix,headers:id?{authorization:'Bearer '+generateToken(id,1)}:{},...(body===undefined?{}:{payload:body})});
test('memory read/write/append are actual human owner only and cannot use blind writes',async()=>{
 for(const [method,body,suffix]of [['GET',undefined,''],['PUT',{content:'unsafe'},''],['POST',{content:'unsafe'},'/append']]){assert.equal((await request(method,body,null,suffix)).statusCode,401);assert.equal((await request(method,body,'memory-member',suffix)).statusCode,403);}assert.equal((await request('PUT',{content:'blind'})).statusCode,409);assert.equal((await request('POST',{content:'blind'},'memory-owner','/append')).statusCode,409);
});
test('owner snapshot hash binds sanitized atomic update and stale retries cannot overwrite',async()=>{
 const initial=await request('GET');assert.equal(initial.statusCode,200,initial.body);assert.match(initial.headers['cache-control'],/no-store/);assert.equal(initial.json().hash,null);
 const result=await request('PUT',{content:'Owner preference is concise.',expectedHash:null});assert.equal(result.statusCode,200,result.body);assert.match(result.json().hash,/^[a-f0-9]{64}$/);assert.equal((await request('PUT',{content:'stale',expectedHash:null})).statusCode,409);assert.equal((await request('GET')).json().content,'Owner preference is concise.');
 const secret='sk-proj-'+'a'.repeat(60),clean=await request('PUT',{content:secret,expectedHash:result.json().hash});assert.equal(clean.statusCode,200,clean.body);assert.ok(!clean.body.includes(secret));assert.match(clean.json().content,/REDACTED/);
 assert.equal((await request('PUT',{content:'x'.repeat(32769),expectedHash:clean.json().hash})).statusCode,400);
});

test('aggregate files endpoint cannot bypass owner-only memory reads',async()=>{
 const r=await app.inject({url:'/api/agents/fixture-agent/files',headers:{authorization:'Bearer '+generateToken('memory-member',1)}});assert.equal(r.statusCode,403);
});

test('default-memory initialization is owner-only too',async()=>{const r=await app.inject({method:'POST',url:'/api/agents/fixture-agent/initialize',headers:{authorization:'Bearer '+generateToken('memory-member',1)}});assert.equal(r.statusCode,403);});
