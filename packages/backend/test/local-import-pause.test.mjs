import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomBytes} from 'node:crypto';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dpro-import-pause-'));
process.env.AGENT_PLAYER_DATA_DIR=path.join(root,'data');process.env.DATABASE_PATH=path.join(root,'data','agent-player.db');
process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
const {getMemoryStorage}=await import('../src/memory/storage.ts');await getMemoryStorage().initialize();
db.prepare("INSERT INTO users(id,email,username,password_hash,role,status) VALUES('pause-owner','pause@example.invalid','pause','fixture','owner','active')").run();
const docs=path.join(root,'project');fs.mkdirSync(docs);
for(const [name,text] of [['CLAUDE.md','Release approvals require two maintainers.'],['AGENTS.md','Invoices must use euros.'],['HANDOFF.md','Ship packages on Fridays.']])fs.writeFileSync(path.join(docs,name),text);
const {scanProjectDocuments}=await import('../src/memory/import/project-documents.ts');
const ids=(await scanProjectDocuments('pause-owner',[docs])).documents.map(d=>d.id);assert.equal(ids.length,3);
const L=await import('../src/memory/import/local-import.ts');let R;
test.after(async()=>{await L.stopLocalImports();await R?.stopLocalImports();closeDatabase();fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})});
test('pause drains inference, survives fresh worker startup and resumes the same checkpoint without replay',async()=>{
 let calls=0,entered;const second=new Promise(r=>entered=r);
 const job=await L.startImport('pause-owner',ids,{home:root,extract:async(_,ctx)=>{
  calls++;if(calls===2){entered();await new Promise((resolve,reject)=>ctx.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}return [];
 }});
 await second;assert.equal((await L.getJob('pause-owner',job.id)).done,1);
 assert.equal(await L.pauseImport('other-owner',job.id),undefined);
 const held=await L.pauseImport('pause-owner',job.id);assert.equal(held.status,'paused');assert.equal(held.done,1);assert.equal(held.errors,0);
 const disk=JSON.parse(fs.readFileSync(path.join(root,'data/local-import-jobs',job.id+'.json')));assert.equal(disk.status,'paused');assert.equal(disk.cursor,1);
 R=await import('../src/memory/import/local-import.ts?pause-restart');
 await R.resumePendingImports({home:root,extract:async()=>{throw Error('Startup must not resume a paused job')}});
 const again=await R.startImport('pause-owner',ids,{home:root,automatic:true,extract:async()=>{throw Error('Automatic admission must not resume a paused job')}});
 assert.equal(again.id,job.id);assert.equal(again.status,'paused');assert.equal(again.done,1);
 let remaining=0;await R.resumeImport('pause-owner',job.id,{home:root,extract:async()=>{remaining++;return []}});
 for(let i=0;i<200;i++){const j=await R.getJob('pause-owner',job.id);if(j.status==='done')break;await new Promise(r=>setTimeout(r,10));}
 const done=await R.getJob('pause-owner',job.id);assert.equal(done.id,job.id);assert.equal(done.status,'done');assert.equal(done.done,3);assert.equal(remaining,2);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM local_agent_imports WHERE user_id=?').get('pause-owner').n,3);
 assert.equal((await R.pauseImport('pause-owner',job.id)).status,'done');
});
test('pause HTTP route rejects guests, members and another owner before changing any job',async()=>{
 const {default:Fastify}=await import('fastify');const {registerAuthGate}=await import('../src/auth/auth-gate.ts');const {memoryImportRoutes}=await import('../src/api/routes/memory-import.ts');const {generateToken}=await import('../src/auth/jwt.ts');
 db.prepare("INSERT INTO users(id,email,username,password_hash,role,status) VALUES('pause-other','other@example.invalid','other','fixture','owner','active')").run();
 db.prepare("INSERT INTO users(id,email,username,password_hash,role,status) VALUES('pause-member','member@example.invalid','member','fixture','user','active')").run();
 const app=Fastify();registerAuthGate(app);await app.register(memoryImportRoutes);await app.ready();
 try {
 const job=await R.latestImportJob('pause-owner');const url='/api/memory/import/local/jobs/'+job.id+'/pause';
 assert.equal((await app.inject({method:'POST',url})).statusCode,401);
 const call=who=>app.inject({method:'POST',url,headers:{authorization:'Bearer '+generateToken(who,1)}});
 assert.equal((await call('pause-member')).statusCode,403);assert.equal((await call('pause-other')).statusCode,404);
 const owner=await call('pause-owner');assert.equal(owner.statusCode,202);assert.equal(owner.json().job.status,'done');
 }finally{await app.close();}
});
