import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {spawn} from 'node:child_process';
import Database from 'better-sqlite3';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'paper-dispatch-attempts-'));
Object.assign(process.env,{AGENT_PLAYER_DATA_DIR:root,DATABASE_PATH:path.join(root,'main.db'),JWT_SECRET:randomBytes(64).toString('hex'),ENCRYPTION_KEY:randomBytes(32).toString('hex')});delete process.env.AGENT_PLAYER_DB;
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const main=getDatabase();await main.initialize();const db=main.getDb();
const journal=await import('../src/services/trading-paper-dispatch-attempts.ts');
const now=Date.now();
function owner(){const id='dispatch-owner-'+randomUUID();db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'fixture','owner','active',1)").run(id,id+'@example.invalid',id);return id;}
function definition(ownerId,limits={}){return {version:1,mode:'paper',ownerId,botId:'bot',accountId:'account',policyId:'policy',policyRevision:1,appRevision:1,installationId:'installation',installationRevision:1,manifestDigest:'a'.repeat(64),policyHash:'b'.repeat(64),profileHash:'c'.repeat(64),quoteSource:'stored-paper-quote',strategy:{kind:'fixed-paper-order',version:1,symbol:'AAA',side:'buy',amount:100},limits:{expiresAt:now+60000,maxAttempts:3,cadenceMs:1000,...limits}};}
function provision(ownerId=owner(),limits={}){const input={definitionId:randomUUID(),definition:definition(ownerId,limits)},result=journal.provisionTrustedPaperDispatchDefinition(db,ownerId,input,now);assert.equal(result.ok,true);return {ownerId,input,result};}
const claim=(f,key='attempt',leaseMs=3000)=>({definitionId:f.input.definitionId,definitionDigest:f.result.definitionDigest,attemptKey:key,leaseMs});
const finish=(f,c,outcome='completed',key='attempt')=>({definitionId:f.input.definitionId,definitionDigest:f.result.definitionDigest,attemptKey:key,fenceToken:c.fenceToken,outcome});
const read=(f,at=now)=>journal.readPaperDispatchAttempts(db,f.ownerId,f.input.definitionId,at);
test.after(async()=>{closeDatabase();await fs.rm(root,{recursive:true,force:true});});
test('explicit initializer creates only the two journal tables and never initializes on operations',()=>{
 const id=owner(),input={definitionId:randomUUID(),definition:definition(id)},before=db.prepare('SELECT name FROM sqlite_master ORDER BY name').all();assert.equal(journal.provisionTrustedPaperDispatchDefinition(db,id,input,now).ok,false);assert.deepEqual(db.prepare('SELECT name FROM sqlite_master ORDER BY name').all(),before);
 journal.initializePaperDispatchAttempts(db);const after=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'paper_%' ORDER BY name").all();assert.deepEqual(after.map(r=>r.name),['paper_dispatch_attempts','paper_dispatch_definitions']);assert.equal(db.prepare('SELECT count(*) n FROM paper_dispatch_definitions').get().n,0);
});
test('immutable definition capture replays at its original creation time without extending expiry or resetting history',()=>{
 const f=provision(),created=read(f);assert.equal(created.runtimeConnected,false);assert.equal(created.journalOnly,true);assert.equal(created.attemptCount,0);assert.equal(created.createdAt,now);assert.equal(journal.provisionTrustedPaperDispatchDefinition(db,f.ownerId,f.input,now+31*86400000).replayed,true);assert.equal(read(f,now+31*86400000).expiresAt,now+60000);
 assert.equal(journal.provisionTrustedPaperDispatchDefinition(db,f.ownerId,{...f.input,definition:{...f.input.definition,limits:{...f.input.definition.limits,maxAttempts:4}}},now).ok,false);assert.equal(journal.provisionTrustedPaperDispatchDefinition(db,f.ownerId,{...f.input,definitionId:randomUUID()},now).ok,false);assert.equal(read(f).createdAt,now);
});
test('pending replay returns same fence; terminal replay exposes no fence and failed attempts consume cadence and budget',()=>{
 const f=provision(undefined,{maxAttempts:2}),request=claim(f),first=journal.claimPaperDispatchAttempt(db,f.ownerId,request,now);assert.equal(first.ok,true);assert.equal(first.status,'pending');assert.equal(first.replayed,false);assert.match(first.fenceToken,/^[A-Za-z0-9_-]{43}$/);
 const replay=journal.claimPaperDispatchAttempt(db,f.ownerId,request,now+1);assert.equal(replay.fenceToken,first.fenceToken);assert.equal(replay.replayed,true);assert.equal(read(f,now+1).attemptCount,1);assert.equal(journal.claimPaperDispatchAttempt(db,f.ownerId,claim(f,'other'),now+1).reason,'pending');
 const failed=journal.finishPaperDispatchAttempt(db,f.ownerId,finish(f,first,'failed'),now+100);assert.equal(failed.status,'failed');assert.equal(Object.hasOwn(failed,'fenceToken'),false);assert.equal(journal.finishPaperDispatchAttempt(db,f.ownerId,finish(f,first,'failed'),now+101).replayed,true);assert.equal(journal.finishPaperDispatchAttempt(db,f.ownerId,finish(f,first,'completed'),now+101).ok,false);
 const terminalReplay=journal.claimPaperDispatchAttempt(db,f.ownerId,request,now+200);assert.equal(terminalReplay.status,'failed');assert.equal(Object.hasOwn(terminalReplay,'fenceToken'),false);assert.equal(journal.claimPaperDispatchAttempt(db,f.ownerId,claim(f,'second'),now+999).reason,'cadence');const second=journal.claimPaperDispatchAttempt(db,f.ownerId,claim(f,'second'),now+1000);assert.equal(second.ok,true);assert.equal(journal.finishPaperDispatchAttempt(db,f.ownerId,finish(f,second,'failed','second'),now+1001).ok,true);assert.equal(journal.claimPaperDispatchAttempt(db,f.ownerId,claim(f,'third'),now+2000).reason,'limit');assert.equal(read(f,now+2000).attemptCount,2);
});
test('expired lease reconciliation is terminal unknown and permanently blocks NEW claims without handing out a fence',()=>{
 const f=provision(),request=claim(f,'attempt',1000),first=journal.claimPaperDispatchAttempt(db,f.ownerId,request,now);const before=read(f);assert.equal(before.attempts[0].status,'pending');
 assert.equal(journal.reconcileExpiredPaperDispatchAttempt(db,f.ownerId,{definitionId:f.input.definitionId,definitionDigest:f.result.definitionDigest,attemptKey:'attempt'},now+999).reason,'pending');
 const expiredRead=read(f,now+1000);assert.equal(expiredRead.attempts[0].status,'pending');assert.equal(expiredRead.attempts[0].leaseExpired,true);assert.equal(read(f).attempts[0].status,'pending');
 const reconciled=journal.reconcileExpiredPaperDispatchAttempt(db,f.ownerId,{definitionId:f.input.definitionId,definitionDigest:f.result.definitionDigest,attemptKey:'attempt'},now+1000);assert.equal(reconciled.status,'unknown');assert.equal(Object.hasOwn(reconciled,'fenceToken'),false);assert.equal(read(f,now+1000).blockedByUnknown,true);assert.equal(journal.finishPaperDispatchAttempt(db,f.ownerId,finish(f,first),now+1001).reason,'unknown');assert.equal(journal.claimPaperDispatchAttempt(db,f.ownerId,claim(f,'new'),now+2000).reason,'unknown');const replay=journal.claimPaperDispatchAttempt(db,f.ownerId,request,now+2000);assert.equal(replay.status,'unknown');assert.equal(Object.hasOwn(replay,'fenceToken'),false);
});
test('claim and finish lease-expiry transitions COMMIT unknown even while returning refusal',()=>{
 for(const operation of ['claim','finish']){const f=provision(),first=journal.claimPaperDispatchAttempt(db,f.ownerId,claim(f,'attempt',1000),now);const result=operation==='claim'?journal.claimPaperDispatchAttempt(db,f.ownerId,claim(f,'new'),now+1000):journal.finishPaperDispatchAttempt(db,f.ownerId,finish(f,first),now+1000);assert.equal(result.ok,false);assert.equal(result.reason,'unknown');assert.equal(read(f,now+1000).attempts[0].status,'unknown');assert.equal(read(f,now+1000).attemptCount,1);}
});
test('definition expiry caps pending lease; exact expired replay is historical and never creates another claim',()=>{
 const f=provision(undefined,{expiresAt:now+1500}),request=claim(f,'attempt',60000),first=journal.claimPaperDispatchAttempt(db,f.ownerId,request,now);assert.equal(first.leaseUntil,now+1500);const replay=journal.claimPaperDispatchAttempt(db,f.ownerId,request,now+1500);assert.equal(replay.status,'unknown');assert.equal(Object.hasOwn(replay,'fenceToken'),false);assert.equal(read(f,now+1500).attemptCount,1);const g=provision(undefined,{expiresAt:now+1000});assert.equal(journal.claimPaperDispatchAttempt(db,g.ownerId,claim(g),now+1000).reason,'limit');
});
test('intent mutation across lease/digest/definitions and wrong fencing token cannot acquire or finish another claim',()=>{
 const f=provision(),first=journal.claimPaperDispatchAttempt(db,f.ownerId,claim(f),now);assert.equal(journal.claimPaperDispatchAttempt(db,f.ownerId,claim(f,'attempt',4000),now+1).ok,false);assert.equal(journal.claimPaperDispatchAttempt(db,f.ownerId,{...claim(f),definitionDigest:'d'.repeat(64)},now+1).ok,false);assert.equal(journal.finishPaperDispatchAttempt(db,f.ownerId,{...finish(f,first),fenceToken:'x'.repeat(43)},now+1).ok,false);
 const input={definitionId:randomUUID(),definition:{...f.input.definition,botId:'other-bot'}},second=journal.provisionTrustedPaperDispatchDefinition(db,f.ownerId,input,now);assert.equal(second.ok,true);assert.equal(journal.claimPaperDispatchAttempt(db,f.ownerId,{definitionId:input.definitionId,definitionDigest:second.definitionDigest,attemptKey:'attempt',leaseMs:1000},now+1).ok,false);assert.equal(read(f,now+1).attemptCount,1);
});
test('future creation times and reversed claim/finish/read clocks fail closed without mutation',()=>{
 const f=provision();assert.equal(read(f,now-1).ok,false);assert.equal(journal.claimPaperDispatchAttempt(db,f.ownerId,claim(f),now-1).ok,false);const first=journal.claimPaperDispatchAttempt(db,f.ownerId,claim(f),now+1000);assert.equal(journal.finishPaperDispatchAttempt(db,f.ownerId,finish(f,first),now+999).ok,false);assert.equal(read(f,now+999).ok,false);assert.equal(journal.finishPaperDispatchAttempt(db,f.ownerId,finish(f,first),now+1100).ok,true);assert.equal(read(f,now+1099).ok,false);assert.equal(journal.claimPaperDispatchAttempt(db,f.ownerId,claim(f,'next'),now+1099).ok,false);assert.equal(read(f,now+1100).attemptCount,1);
});
test('reads are query-only, bounded and never disclose canonical input, fencing token or request hashes',()=>{
 const f=provision(),first=journal.claimPaperDispatchAttempt(db,f.ownerId,claim(f),now),before=db.prepare('SELECT total_changes() n').get().n;db.pragma('query_only=ON');try{const result=read(f);assert.equal(result.ok,true);const text=JSON.stringify(result);assert.equal(text.includes(first.fenceToken),false);assert.doesNotMatch(text,/canonical|request_hash|fence|policyHash|profileHash/);assert.equal(db.prepare('SELECT total_changes() n').get().n,before);}finally{db.pragma('query_only=OFF');}
});
test('exact schema guards reject TEMP shadows/unexpected trigger and corrupt counters/history without repair',()=>{
 const f=provision();db.exec('CREATE TEMP TABLE paper_dispatch_attempts(id TEXT)');try{assert.equal(read(f).ok,false);}finally{db.exec('DROP TABLE temp.paper_dispatch_attempts');}db.exec("CREATE TRIGGER unexpected_dispatch AFTER INSERT ON paper_dispatch_attempts BEGIN SELECT 1; END");try{assert.equal(journal.claimPaperDispatchAttempt(db,f.ownerId,claim(f),now).ok,false);}finally{db.exec('DROP TRIGGER unexpected_dispatch');}
 const first=journal.claimPaperDispatchAttempt(db,f.ownerId,claim(f),now);db.prepare('UPDATE paper_dispatch_definitions SET attempt_count=2 WHERE id=?').run(f.input.definitionId);assert.equal(read(f).ok,false);db.prepare('UPDATE paper_dispatch_definitions SET attempt_count=1 WHERE id=?').run(f.input.definitionId);db.prepare("UPDATE paper_dispatch_attempts SET event_hash='bad' WHERE id=?").run(first.attemptId);assert.equal(read(f).ok,false);assert.equal(journal.finishPaperDispatchAttempt(db,f.ownerId,finish(f,first),now+1).ok,false);
});
test('real SQL trigger abort after counter update and post-insert failure roll back every claim effect',()=>{
 const f=provision();for(const mode of ['trigger','after-insert']){
  const original=db.prepare;let injected=0;db.prepare=function(sql,...args){const statement=original.call(this,sql,...args);if(sql.startsWith('INSERT INTO main.paper_dispatch_attempts '))return {run(...values){injected++;if(mode==='trigger'){db.exec("CREATE TEMP TRIGGER owned_dispatch_abort BEFORE INSERT ON main.paper_dispatch_attempts BEGIN SELECT RAISE(ABORT,'owned fixture failure'); END");return statement.run(...values);}statement.run(...values);throw Error('Owned post-insert failure');}};return statement;};
  try{assert.equal(journal.claimPaperDispatchAttempt(db,f.ownerId,claim(f),now).ok,false);}finally{db.prepare=original;}
  assert.equal(injected,1);assert.equal(read(f).attemptCount,0);assert.equal(read(f).lastClaimAt,null);assert.deepEqual(read(f).attempts,[]);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_temp_master WHERE name='owned_dispatch_abort'").get().n,0);
 }
});
test('wrong current owner, raw foreign handles, caller transactions, PG and malformed data never write journals',()=>{
 const f=provision(),other=owner();assert.equal(journal.claimPaperDispatchAttempt(db,other,claim(f),now).ok,false);for(const patch of [{attemptKey:'key\n'},{definitionId:f.input.definitionId+'\n'},{leaseMs:999},{leaseMs:60001},{leaseMs:NaN},{maxAttempts:999}])assert.equal(journal.claimPaperDispatchAttempt(db,f.ownerId,{...claim(f),...patch},now).ok,false);
 let getters=0;const getter={...claim(f)};Object.defineProperty(getter,'leaseMs',{enumerable:true,get(){getters++;return 1000;}});assert.equal(journal.claimPaperDispatchAttempt(db,f.ownerId,getter,now).ok,false);assert.equal(getters,0);
 for(const foreign of [new Database(process.env.DATABASE_PATH),new Database(':memory:')])try{assert.equal(journal.claimPaperDispatchAttempt(foreign,f.ownerId,claim(f),now).ok,false);}finally{foreign.close();}
 db.transaction(()=>assert.equal(journal.claimPaperDispatchAttempt(db,f.ownerId,claim(f),now).ok,false)).immediate();process.env.AGENT_PLAYER_DB='postgres';try{assert.equal(read(f).ok,false);}finally{delete process.env.AGENT_PLAYER_DB;}
 db.prepare("UPDATE users SET role='user' WHERE id=?").run(f.ownerId);assert.equal(read(f).ok,false);db.prepare("UPDATE users SET role='owner' WHERE id=?").run(f.ownerId);assert.equal(read(f).attemptCount,0);
});
test('independent Worker claims serialize to one pending attempt; restart expiry preserves unknown barrier',async()=>{
 const f=provision(),module=new URL('../src/services/trading-paper-dispatch-attempts.ts',import.meta.url).pathname,dbModule=new URL('../src/db/database.ts',import.meta.url).pathname,backend=new URL('..',import.meta.url).pathname;
 const code=`import{createRequire}from'node:module';import{workerData as d,parentPort}from'node:worker_threads';const require=createRequire(d.backend+'/package.json');require('tsx/cjs');const{getDatabase,closeDatabase}=require(d.dbModule),m=require(d.module);try{parentPort.postMessage(m[d.operation](getDatabase().getDb(),d.ownerId,d.input,d.now));}finally{closeDatabase();}`;
 const run=(operation,input,at)=>new Promise((resolve,reject)=>{const worker=new Worker(code,{eval:true,type:'module',workerData:{backend,module,dbModule,ownerId:f.ownerId,operation,input,now:at}});worker.once('message',resolve);worker.once('error',reject);});
 const results=await Promise.all([run('claimPaperDispatchAttempt',claim(f,'one',1000),now),run('claimPaperDispatchAttempt',claim(f,'two',1000),now)]);assert.equal(results.filter(r=>r.ok).length,1);assert.equal(read(f).attemptCount,1);const saved=read(f).attempts[0];const restarted=await run('reconcileExpiredPaperDispatchAttempt',{definitionId:f.input.definitionId,definitionDigest:f.result.definitionDigest,attemptKey:saved.attemptKey},now+1000);assert.equal(restarted.status,'unknown');assert.equal((await run('claimPaperDispatchAttempt',claim(f,'third'),now+2000)).reason,'unknown');assert.equal(read(f,now+2000).attemptCount,1);
});

test('actual child SIGKILL after journal INSERT restores the claim budget and allows one fresh claim',async()=>{
 const f=provision(),request=claim(f,'crash',1000),before=read(f);
 const module=new URL('../src/services/trading-paper-dispatch-attempts.ts',import.meta.url).href;
 const databaseModule=new URL('../src/db/database.ts',import.meta.url).href;
 const script=`import{getDatabase}from${JSON.stringify(databaseModule)};import{claimPaperDispatchAttempt}from${JSON.stringify(module)};const db=getDatabase().getDb(),original=db.prepare;db.prepare=function(sql,...args){const statement=original.call(this,sql,...args);if(sql.startsWith('INSERT INTO main.paper_dispatch_attempts '))return{run(...values){statement.run(...values);process.kill(process.pid,'SIGKILL');}};return statement;};claimPaperDispatchAttempt(db,${JSON.stringify(f.ownerId)},${JSON.stringify(request)},${now});process.exit(2);`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:new URL('..',import.meta.url).pathname,stdio:'ignore'});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Owned crash fixture timed out'));},10000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',(code,signal)=>{clearTimeout(timer);try{assert.equal(signal,'SIGKILL');resolve();}catch(error){reject(error);}});});
 assert.deepEqual(read(f),before);const committed=journal.claimPaperDispatchAttempt(db,f.ownerId,request,now);assert.equal(committed.ok,true);assert.equal(committed.replayed,false);assert.equal(read(f).attemptCount,1);assert.equal(read(f).attempts.length,1);
});

test('trusted caller transaction helpers roll back definition writes and read historical state without repair',()=>{
 const ownerId=owner(),input={definitionId:randomUUID(),definition:definition(ownerId)};
 assert.throws(()=>journal.provisionTrustedPaperDispatchDefinitionInTransaction(db,ownerId,input,now));
 assert.throws(()=>journal.readTrustedPaperDispatchDefinitionInTransaction(db,ownerId,input.definitionId,now));
 assert.throws(()=>db.transaction(()=>{const saved=journal.provisionTrustedPaperDispatchDefinitionInTransaction(db,ownerId,input,now);assert.equal(saved.replayed,false);assert.equal(journal.readTrustedPaperDispatchDefinitionInTransaction(db,ownerId,input.definitionId,now).definition.ownerId,ownerId);throw Error('Owned outer write failure');}).immediate());
 assert.equal(db.prepare('SELECT count(*) n FROM paper_dispatch_definitions WHERE id=?').get(input.definitionId).n,0);
 assert.throws(()=>db.transaction(()=>journal.readTrustedPaperDispatchDefinitionInTransaction(db,ownerId,input.definitionId,now)).deferred());
 assert.equal(db.prepare('SELECT count(*) n FROM paper_dispatch_definitions WHERE id=?').get(input.definitionId).n,0);
 db.transaction(()=>assert.equal(journal.provisionTrustedPaperDispatchDefinitionInTransaction(db,ownerId,input,now).replayed,false)).immediate();
 const f={ownerId,input,result:db.transaction(()=>journal.readTrustedPaperDispatchDefinitionInTransaction(db,ownerId,input.definitionId,now)).deferred()};
 const first=journal.claimPaperDispatchAttempt(db,ownerId,claim(f),now);assert.equal(first.ok,true);const before=read(f,now+86400000);
 db.pragma('query_only=ON');try{db.transaction(()=>{const saved=journal.readTrustedPaperDispatchDefinitionInTransaction(db,ownerId,input.definitionId,now+86400000);assert.equal(saved.attemptCount,1);assert.equal(saved.createdAt,now);assert.equal(saved.definition.limits.expiresAt,now+60000);assert.equal(JSON.stringify(saved).includes(first.fenceToken),false);}).deferred();}finally{db.pragma('query_only=OFF');}
 assert.deepEqual(read(f,now+86400000),before);
});

test('trusted finish composition rolls back with outer effects and requires caller transaction',()=>{
 const f=provision(),first=journal.claimPaperDispatchAttempt(db,f.ownerId,claim(f),now),request=finish(f,first),before=read(f);
 assert.throws(()=>journal.finishPaperDispatchAttemptInTransaction(db,f.ownerId,request,now));
 assert.throws(()=>db.transaction(()=>{assert.equal(journal.finishPaperDispatchAttemptInTransaction(db,f.ownerId,request,now).status,'completed');throw Error('Owned outer effects failure');}).immediate(),/Owned outer effects failure/);
 assert.deepEqual(read(f),before);assert.equal(journal.finishPaperDispatchAttempt(db,f.ownerId,request,now).status,'completed');
});
test('canonical due derivation strictly bounds identity/hash/sequence and claims exact actual next sequence under the write lock',()=>{
 const f=provision(),consentId=randomUUID(),derive=n=>journal.derivePaperRuntimeDueAttemptKey(consentId,f.input.definitionId,f.result.definitionDigest,n);
 assert.match(derive(1),/^due:[a-f0-9]{64}$/);assert.equal(derive(1),derive(1));assert.notEqual(derive(1),derive(2));for(const args of [[consentId+'\n',f.input.definitionId,f.result.definitionDigest,1],[consentId,f.input.definitionId,'a'.repeat(63),1],[consentId,f.input.definitionId,f.result.definitionDigest,0],[consentId,f.input.definitionId,f.result.definitionDigest,1001]])assert.throws(()=>journal.derivePaperRuntimeDueAttemptKey(...args));
 assert.equal(journal.claimCanonicalPaperDispatchAttempt(db,f.ownerId,claim(f,derive(2)),consentId,now).ok,false);assert.equal(read(f).attemptCount,0);const first=journal.claimCanonicalPaperDispatchAttempt(db,f.ownerId,claim(f,derive(1)),consentId,now);assert.equal(first.ok,true);assert.equal(first.sequence,1);assert.equal(journal.claimCanonicalPaperDispatchAttempt(db,f.ownerId,claim(f,derive(1)),consentId,now).fenceToken,first.fenceToken);assert.equal(journal.finishPaperDispatchAttempt(db,f.ownerId,finish(f,first,'failed',derive(1)),now+1).ok,true);const second=journal.claimCanonicalPaperDispatchAttempt(db,f.ownerId,claim(f,derive(2)),consentId,now+1000);assert.equal(second.sequence,2);assert.equal(journal.claimCanonicalPaperDispatchAttempt(db,f.ownerId,claim(f,derive(1)),consentId,now+1001).replayed,true);assert.equal(read(f,now+1001).attemptCount,2);
});
test('canonical claim refuses any arbitrary persisted key while original raw journal API retains its trusted behavior',()=>{
 const f=provision(),consentId=randomUUID(),raw=journal.claimPaperDispatchAttempt(db,f.ownerId,claim(f,'raw'),now);assert.equal(raw.ok,true);assert.equal(journal.finishPaperDispatchAttempt(db,f.ownerId,finish(f,raw,'failed','raw'),now).ok,true);const canonical=journal.derivePaperRuntimeDueAttemptKey(consentId,f.input.definitionId,f.result.definitionDigest,2);assert.equal(journal.claimCanonicalPaperDispatchAttempt(db,f.ownerId,claim(f,canonical),consentId,now+1000).ok,false);assert.equal(read(f,now+1000).attemptCount,1);assert.equal(journal.claimPaperDispatchAttempt(db,f.ownerId,claim(f,'raw-next'),now+1000).ok,true);
});
