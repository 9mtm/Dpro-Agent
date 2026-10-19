import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
const root=mkdtempSync(join(tmpdir(),'dpro-memory-pages-'));mkdirSync(join(root,'data'));
process.env.AGENT_PLAYER_DATA_DIR=join(root,'data');process.env.DATABASE_PATH=join(root,'data','agent-player.db');
process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
const {getMemoryStorage}=await import('../src/memory/storage.ts');await getMemoryStorage().initialize();
for(const id of ['page-owner','page-other','page-big'])db.prepare("INSERT INTO users(id,email,username,password_hash,role,status) VALUES(?,?,?,'fixture-hash','owner','active')").run(id,id+'@example.invalid',id);
const insert=db.prepare("INSERT INTO memories(id,user_id,type,content,embedding,created_at,drawer_kind) VALUES(?,?,'fact',?,?,?,'owner')");
const id=n=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
const vector=JSON.stringify(Array(1024).fill(0.125));
db.transaction(()=>{for(let n=1;n<=5003;n++)insert.run(id(n),'page-owner','Fictional memory '+n,vector,'2026-01-01T00:00:00.000Z');insert.run(id(9000),'page-other','Foreign private memory',vector,'2026-01-01T00:00:00.000Z');for(let n=10000;n<10003;n++)insert.run(id(n),'page-big','\u0001'.repeat(50000),vector,'2026-01-01T00:00:00.000Z')});
const vectorHash=()=>createHash('sha256').update(JSON.stringify(db.prepare('SELECT id,embedding FROM memories ORDER BY id').all())).digest('hex');
const {default:Fastify}=await import('fastify');const {registerAuthGate}=await import('../src/auth/auth-gate.ts');const {generateToken}=await import('../src/auth/jwt.ts');const {memoryRoutes}=await import('../src/api/routes/memory.ts');
const app=Fastify();registerAuthGate(app);await app.register(memoryRoutes);await app.ready();
const call=(url,who='page-owner')=>app.inject({method:'GET',url,headers:{authorization:'Bearer '+generateToken(who,1)}});
test.after(async()=>{await app.close();closeDatabase();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})});
test('over 5000 memories arrive once each without vectors; concurrent imports wait for refresh',async()=>{
 const before=vectorHash(),seen=new Set();let cursor=null,pages=0,initial=true;
 do{const r=await call('/api/memory/page'+(cursor?'?cursor='+cursor:''));assert.equal(r.statusCode,200);assert.ok(Buffer.byteLength(r.body)<600*1024);const b=r.json();assert.equal(b.total,5003);assert.ok(b.memories.length<=100);assert.ok(!r.body.includes('embedding'));assert.ok(!r.body.includes('userId'));assert.ok(!r.body.includes('Foreign private'));
 for(const m of b.memories){assert.ok(!seen.has(m.id));seen.add(m.id)}cursor=b.nextCursor;pages++;
 if(initial){initial=false;insert.run(id(8000),'page-owner','New concurrent import',vector,'2026-01-02T00:00:00.000Z')}
 }while(cursor);
 assert.equal(seen.size,5003);assert.ok(pages>50);assert.ok(!seen.has(id(8000)));assert.equal((await call('/api/memory/page')).json().total,5004);
 db.prepare('DELETE FROM memories WHERE id=?').run(id(8000));assert.equal(vectorHash(),before,'display never changes vectors');
});
test('maximum-length escaped content respects encoded byte budget without omissions',async()=>{let cursor=null,count=0;do{const r=await call('/api/memory/page'+(cursor?'?cursor='+cursor:''),'page-big');assert.equal(r.statusCode,200);assert.ok(Buffer.byteLength(r.body)<600*1024);const b=r.json();count+=b.memories.length;for(const m of b.memories)assert.equal(m.content.length,50000);cursor=b.nextCursor}while(cursor);assert.equal(count,3)});
test('cursor stays user-scoped and malformed cursors fail closed',async()=>{const cursor=(await call('/api/memory/page')).json().nextCursor;const other=await call('/api/memory/page?cursor='+cursor,'page-other');assert.equal(other.statusCode,200);assert.equal(other.json().memories.length,0);assert.equal((await call('/api/memory/page','page-other')).json().memories[0].id,id(9000));for(const url of ['/api/memory/page?cursor=abc','/api/memory/page?cursor=','/api/memory/page?cursor[]=x','/api/memory/page?limit=9999'])assert.equal((await call(url)).statusCode,400);assert.equal((await app.inject({method:'GET',url:'/api/memory/page'})).statusCode,401)});
test('compatibility list omits vectors without changing stored embeddings',async()=>{const before=vectorHash();const r=await call('/api/memory','page-other');assert.equal(r.statusCode,200);assert.ok(!r.body.includes('embedding'));assert.equal(vectorHash(),before)});

test('display pagination is unavailable to agent runs and channel services',async()=>{const {memoryRepository}=await import('../src/repositories/memory.ts');for(const actor of [{kind:'agent',userId:'page-owner',agentId:'fictional-agent',drawers:[]},{kind:'service',service:'fictional-channel'}])assert.throws(()=>memoryRepository.displayPage(actor),e=>e.status===403)});
