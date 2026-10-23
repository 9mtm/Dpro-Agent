import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import Database from 'better-sqlite3';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'paper-account-setup-'));
Object.assign(process.env,{AGENT_PLAYER_DATA_DIR:root,DATABASE_PATH:path.join(root,'main.db'),JWT_SECRET:randomBytes(64).toString('hex'),ENCRYPTION_KEY:randomBytes(32).toString('hex')});delete process.env.AGENT_PLAYER_DB;
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const main=getDatabase();await main.initialize();const db=main.getDb();
const setup=await import('../src/services/trading-paper-account-setup.ts'),registry=await import('../src/services/trading-paper-installation.ts'),ledger=await import('../src/services/trading-paper-ledger.ts'),execution=await import('../src/services/trading-paper-execution.ts');
const {enrollInstallOwner,reviewedInstall}=await import('./fixtures/reviewed-paper-install.mjs');
const now=Date.now();
async function owner(install=true,caps=['paper.account.read']){
 const userId='setup-'+randomUUID();db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'fixture','owner','active',1)").run(userId,userId+'@example.invalid',userId);
 const f=await enrollInstallOwner(userId,now-60000);if(install)await reviewedInstall(db,f,{now:now-30000,capabilities:caps});return f;
}
function input(f,patch={}){const installation=registry.readPaperInstallation(db,f.context.userId,()=>now);return {idempotencyKey:'create-'+randomUUID(),accountId:'account-'+randomUUID(),policyId:'policy-'+randomUUID(),installationId:installation.installationId,expectedInstallationRevision:1,manifestDigest:registry.BUNDLED_PAPER_INSTALLATION.manifestDigest,currency:'USD',initialCashMinor:10000,policy:{expiresAt:now+86400000,symbols:['BBB','AAA'],maxOrder:1000,maxExposure:10000,maxDailyLoss:1000,maxOrders:100,cooldownMs:0,maxQuoteAgeMs:5000},execution:{feeBps:100,slippageBps:0},...patch};}
const provision=(f,p,at=now)=>setup.provisionTrustedPaperAccount(db,f.context.userId,p,()=>at);
const snapshot=accountId=>({account:db.prepare('SELECT * FROM paper_accounts WHERE account_id=?').get(accountId),policies:db.prepare('SELECT * FROM paper_policies WHERE account_id=?').all(accountId),profile:db.prepare('SELECT * FROM paper_execution_profiles WHERE account_id=?').get(accountId),fills:db.prepare('SELECT * FROM paper_fills WHERE account_id=?').all(accountId),positions:db.prepare('SELECT * FROM paper_positions WHERE account_id=?').all(accountId),reservations:db.prepare('SELECT * FROM paper_reservations WHERE account_id=?').all(accountId)});
test.after(async()=>{closeDatabase();await fs.rm(root,{recursive:true,force:true});});
test('explicit journal initializer creates no business schema or account and refuses foreign/caller transactions',()=>{
 const before=db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='paper_accounts'").get().n;setup.initializePaperAccountSetup(db);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='paper_accounts'").get().n,before);assert.equal(db.prepare('SELECT count(*) n FROM paper_account_setups').get().n,0);
 const other=new Database(':memory:');try{assert.throws(()=>setup.initializePaperAccountSetup(other));assert.equal(other.prepare('SELECT count(*) n FROM sqlite_master').get().n,0);}finally{other.close();}
 db.transaction(()=>assert.throws(()=>setup.initializePaperAccountSetup(db))).immediate();
});
test('actual reviewed installation creates account policy and profile once with conservative fixed bindings',async()=>{
 const f=await owner(),p=input(f),first=provision(f,p);assert.equal(first.ok,true);assert.equal(first.replayed,false);assert.equal(first.result.runtimeConnected,false);assert.equal(first.result.appRevision,1);const rows=snapshot(p.accountId);assert.equal(rows.account.cash,10000);assert.equal(rows.account.exposure,0);assert.equal(rows.account.app_revision,1);assert.equal(rows.account.stopped,0);assert.equal(rows.profile.unit_scale,1);assert.equal(rows.profile.revision,1);const policy=JSON.parse(rows.policies[0].policy_json);assert.deepEqual(policy.symbols,['AAA','BBB']);assert.equal(policy.ownerId,f.context.userId);assert.equal(policy.appRevision,1);assert.equal(policy.revision,1);assert.equal(rows.fills.length,0);assert.equal(db.prepare('SELECT count(*) n FROM paper_bots WHERE account_id=?').get(p.accountId).n,0);
 assert.equal(provision(f,p).replayed,true);assert.equal(db.prepare('SELECT count(*) n FROM paper_account_setups WHERE owner_id=?').get(f.context.userId).n,1);assert.equal(provision(f,{...p,initialCashMinor:9999}).ok,false);assert.equal(provision(f,{...p,idempotencyKey:'another'}).ok,false);assert.deepEqual(snapshot(p.accountId),rows);
});
test('third insert and actual journal write faults roll back every account/profile/policy effect',async()=>{
 const f=await owner();for(const prefix of ['INSERT INTO main.paper_execution_profiles','INSERT INTO main.paper_account_setups']){
  const p=input(f),original=db.prepare;let injected=0;db.prepare=function(sql,...args){const statement=original.call(this,sql,...args);if(sql.startsWith(prefix))return {run(...values){statement.run(...values);injected++;throw Error('Owned fixture failure after real write');}};return statement;};
  try{assert.equal(provision(f,p).ok,false);}finally{db.prepare=original;}
  assert.equal(injected,1);assert.equal(snapshot(p.accountId).account,undefined);assert.equal(snapshot(p.accountId).profile,undefined);assert.deepEqual(snapshot(p.accountId).policies,[]);assert.equal(db.prepare('SELECT count(*) n FROM paper_account_setups WHERE account_id=?').get(p.accountId).n,0);
 }
});
test('historical retry after real fill policy stop and reviewed disable preserves all cash and history',async()=>{
 const f=await owner(),p=input(f);assert.equal(provision(f,p).ok,true);execution.recordPaperExecutionQuote(db,{accountId:p.accountId,symbol:'AAA',priceMinor:100,quotedAt:now,revision:1,currency:'USD',unitScale:1});const r=ledger.reservePaperOrder(db,f.context.userId,{accountId:p.accountId,policyId:p.policyId,policyRevision:1,appRevision:1,currency:'USD',symbol:'AAA',side:'buy',notional:1000,idempotencyKey:'buy'},()=>now);assert.equal(r.ok,true);assert.equal(execution.executePaperBuy(db,f.context.userId,{accountId:p.accountId,reservationId:r.reservationId,executionKey:'fill'},()=>now).ok,true);assert.equal(ledger.revokePaperPolicy(db,f.context.userId,p.accountId,p.policyId),true);ledger.stopPaperAccount(db,f.context.userId,p.accountId);
 const afterFill=snapshot(p.accountId);assert.equal(afterFill.account.cash,9091);assert.equal(provision(f,p,now+1).replayed,true);assert.deepEqual(snapshot(p.accountId),afterFill);
 await reviewedInstall(db,f,{now,action:'disable',expectedRevision:1});const disabled=snapshot(p.accountId);assert.equal(disabled.account.app_revision,2);assert.equal(provision(f,p,now+1).replayed,true);assert.deepEqual(snapshot(p.accountId),disabled);assert.equal(provision(f,input(f),now+1).ok,false);
});
test('wrong owner inactive/system role missing consent foreign handles and caller transactions refuse',async()=>{
 const f=await owner(),p=input(f),g=await owner();assert.equal(provision(f,p).ok,true);assert.equal(provision(g,p).ok,false);
 for(const sql of ["UPDATE users SET role='user' WHERE id=?","UPDATE users SET status='inactive' WHERE id=?","UPDATE users SET email_verified=0 WHERE id=?"]){db.prepare(sql).run(f.context.userId);assert.equal(provision(f,p).ok,false);db.prepare("UPDATE users SET role='owner',status='active',email_verified=1 WHERE id=?").run(f.context.userId);}
 for(const foreign of [new Database(process.env.DATABASE_PATH),new Database(':memory:')])try{assert.equal(setup.provisionTrustedPaperAccount(foreign,f.context.userId,p,()=>now).ok,false);}finally{foreign.close();}
 assert.equal(setup.provisionTrustedPaperAccount(db,'mock-user',p,()=>now).ok,false);db.transaction(()=>assert.equal(provision(f,p).ok,false)).immediate();assert.throws(()=>setup.provisionTrustedPaperAccountInTransaction(db,f.context.userId,p,now));
 const noConsent=await owner(false),raw=registry.provisionTrustedPaperInstallation(db,noConsent.context.userId,{action:'install',expectedRevision:0,idempotencyKey:'trusted-only',manifestDigest:registry.BUNDLED_PAPER_INSTALLATION.manifestDigest,capabilities:['paper.account.read']},()=>now);assert.equal(raw.ok,true);assert.equal(provision(noConsent,input(noConsent)).ok,false);
 process.env.AGENT_PLAYER_DB='postgres';try{assert.equal(provision(f,p).ok,false);}finally{delete process.env.AGENT_PLAYER_DB;}
});
test('strict bounded primitives and accessor-free captured arrays reject malformed setup',async()=>{
 const f=await owner(),p=input(f);for(const patch of [{initialCashMinor:0},{initialCashMinor:1e12+1},{initialCashMinor:NaN},{accountId:p.accountId+'\n'},{idempotencyKey:'x\r'},{expectedInstallationRevision:2},{currency:'USD\n'},{exposure:0},{ownerId:f.context.userId},{execution:{feeBps:10001,slippageBps:0}},{policy:{...p.policy,maxOrder:10001}},{policy:{...p.policy,maxOrders:10001}},{policy:{...p.policy,cooldownMs:86400001}},{policy:{...p.policy,maxQuoteAgeMs:300001}},{policy:{...p.policy,symbols:['AAA','AAA']}},{policy:{...p.policy,symbols:['AAA\n']}},{policy:{...p.policy,expiresAt:now+30*86400000+1}},{policy:{...p.policy,expiresAt:now}},{policy:{...p.policy,symbols:Array.from({length:101},(_,i)=>'S'+i)}}])assert.equal(provision(f,{...p,...patch}).ok,false);
 let calls=0;const getter={...p};Object.defineProperty(getter,'policy',{enumerable:true,get(){calls++;return p.policy;}});assert.equal(provision(f,getter).ok,false);const symbols=['AAA'];Object.defineProperty(symbols,0,{get(){calls++;return 'AAA';}});assert.equal(provision(f,{...p,policy:{...p.policy,symbols}}).ok,false);assert.equal(calls,0);assert.equal(db.prepare('SELECT count(*) n FROM paper_accounts WHERE account_id=?').get(p.accountId).n,0);
});
test('schema shadow trigger journal corruption and orphan state cannot acquire account authority',async()=>{
 const f=await owner(),p=input(f);db.exec('CREATE TEMP TABLE paper_account_setups(id TEXT)');try{assert.equal(provision(f,p).ok,false);}finally{db.exec('DROP TABLE temp.paper_account_setups');}
 db.exec("CREATE TRIGGER unexpected_setup AFTER INSERT ON paper_account_setups BEGIN SELECT 1; END");try{assert.equal(provision(f,p).ok,false);}finally{db.exec('DROP TRIGGER unexpected_setup');}
 db.prepare('INSERT INTO paper_quotes VALUES(?,?,?)').run(p.accountId,'AAA',now);assert.equal(provision(f,p).ok,false);db.prepare('DELETE FROM paper_quotes WHERE account_id=?').run(p.accountId);assert.equal(provision(f,p).ok,true);
 db.prepare("UPDATE paper_account_setups SET event_hash='bad' WHERE account_id=?").run(p.accountId);const before=snapshot(p.accountId);assert.equal(provision(f,p).ok,false);assert.deepEqual(snapshot(p.accountId),before);
 const q=input(f);db.exec('CREATE TEMP TABLE paper_positions(account_id TEXT)');try{assert.equal(provision(f,q).ok,false);}finally{db.exec('DROP TABLE temp.paper_positions');}
});
test('detached canonical intents and policy-bound rows cannot be adopted by a new account',async()=>{
 const f=await owner(),p=input(f);db.prepare('INSERT INTO paper_reservation_intents VALUES(?,?,?,?,?,?)').run('detached-'+randomUUID(),JSON.stringify({accountId:p.accountId,policyId:p.policyId}),null,null,null,null);assert.equal(provision(f,p).ok,false);assert.equal(snapshot(p.accountId).account,undefined);
 const q=input(f);db.prepare('INSERT INTO paper_reservations(reservation_id,account_id,policy_id,idempotency_key,intent_hash,notional,created_at,status,cancelled_at) VALUES(?,?,?,?,?,?,?,?,?)').run('detached-'+randomUUID(),'foreign-account',q.policyId,'key','a'.repeat(64),1,now,'cancelled',now);assert.equal(provision(f,q).ok,false);
});
test('actual zero-net buy/sell roundtrip history refuses reseeding after owned fixture authority rows are removed',async()=>{
 const f=await owner(),p=input(f),ownerId=f.context.userId;
 ledger.provisionPaperAccount(db,{policy:{id:p.policyId,revision:1,appRevision:1,currency:p.currency,ownerId,accountId:p.accountId,enabled:true,mode:'paper',...p.policy},cash:p.initialCashMinor,exposure:0});
 execution.configurePaperExecution(db,{ownerId,accountId:p.accountId,revision:1,feeBps:0,slippageBps:0,unitScale:1,currency:'USD'});execution.recordPaperExecutionQuote(db,{accountId:p.accountId,symbol:'AAA',priceMinor:100,quotedAt:now,revision:1,currency:'USD',unitScale:1});
 const r=ledger.reservePaperOrder(db,ownerId,{accountId:p.accountId,policyId:p.policyId,policyRevision:1,appRevision:1,currency:'USD',symbol:'AAA',side:'buy',notional:1000,idempotencyKey:'roundtrip-buy'},()=>now);assert.equal(r.ok,true);assert.equal(execution.executePaperBuy(db,ownerId,{accountId:p.accountId,reservationId:r.reservationId,executionKey:'roundtrip-buy'},()=>now).ok,true);
 const sells=await import('../src/services/trading-paper-sells.ts'),sold=sells.reservePaperSell(db,ownerId,{accountId:p.accountId,policyId:p.policyId,policyRevision:1,appRevision:1,currency:'USD',symbol:'AAA',quantityUnits:10,idempotencyKey:'roundtrip-sell'},()=>now);assert.equal(sold.ok,true);assert.equal(sells.executePaperSell(db,ownerId,{accountId:p.accountId,reservationId:sold.reservationId,executionKey:'roundtrip-sell'},()=>now).ok,true);
 assert.equal(snapshot(p.accountId).account.cash,p.initialCashMinor);assert.equal(snapshot(p.accountId).account.exposure,0);
 // Deliberately orphan only this owned temporary fixture's zero-net history.
 for(const table of ['paper_accounts','paper_policies','paper_execution_profiles','paper_quotes','paper_execution_quotes','paper_positions'])db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(p.accountId);
 assert.equal(provision(f,p).ok,false);assert.equal(snapshot(p.accountId).account,undefined);assert.equal(db.prepare('SELECT count(*) n FROM paper_fills WHERE account_id=?').get(p.accountId).n,1);assert.equal(db.prepare('SELECT count(*) n FROM paper_sell_fills WHERE account_id=?').get(p.accountId).n,1);
});
test('corrupted fill or balance history refuses historical acknowledgment without repair',async()=>{
 const f=await owner(),p=input(f);assert.equal(provision(f,p).ok,true);db.prepare('UPDATE paper_accounts SET cash=cash+1 WHERE account_id=?').run(p.accountId);assert.equal(provision(f,p).ok,false);assert.equal(db.prepare('SELECT cash FROM paper_accounts WHERE account_id=?').get(p.accountId).cash,10001);
});
test('trusted same-handle composition rolls back when its outer caller fails',async()=>{
 const f=await owner(),p=input(f);assert.throws(()=>db.transaction(()=>{const r=setup.provisionTrustedPaperAccountInTransaction(db,f.context.userId,p,now);assert.equal(r.ok,true);throw Error('Owned outer failure');}).immediate());assert.equal(snapshot(p.accountId).account,undefined);
});
test('independent Worker connections create once and restart readback never resets cash',async()=>{
 const f=await owner(),p=input(f),module=new URL('../src/services/trading-paper-account-setup.ts',import.meta.url).pathname,dbModule=new URL('../src/db/database.ts',import.meta.url).pathname,backend=new URL('..',import.meta.url).pathname;
 const code=`import{createRequire}from'node:module';import{workerData as d,parentPort}from'node:worker_threads';const require=createRequire(d.backend+'/package.json');require('tsx/cjs');const{getDatabase,closeDatabase}=require(d.dbModule),{provisionTrustedPaperAccount}=require(d.module);try{parentPort.postMessage(provisionTrustedPaperAccount(getDatabase().getDb(),d.ownerId,d.input,()=>d.now));}finally{closeDatabase();}`;
 const run=()=>new Promise((resolve,reject)=>{const w=new Worker(code,{eval:true,type:'module',workerData:{backend,module,dbModule,ownerId:f.context.userId,input:p,now}});w.once('message',resolve);w.once('error',reject);});
 const results=await Promise.all([run(),run()]);assert.equal(results.filter(r=>r.ok).length,2);assert.equal(results.filter(r=>r.replayed===false).length,1);assert.equal(db.prepare('SELECT count(*) n FROM paper_account_setups WHERE account_id=?').get(p.accountId).n,1);const before=snapshot(p.accountId);const restarted=await run();assert.equal(restarted.replayed,true);assert.deepEqual(snapshot(p.accountId),before);
});
