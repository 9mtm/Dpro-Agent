import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Worker} from 'node:worker_threads';
import {spawn} from 'node:child_process';
import {initializePaperLedger,provisionPaperAccount,reservePaperOrder,stopPaperAccount,revokePaperPolicy} from '../src/services/trading-paper-ledger.ts';
import {initializePaperExecution,configurePaperExecution,recordPaperExecutionQuote} from '../src/services/trading-paper-execution.ts';
import {initializePaperSells,reservePaperSell} from '../src/services/trading-paper-sells.ts';
import {executeRiskCheckedPaperOrder} from '../src/services/trading-paper-risk-execution.ts';
const now=1800000000000;
function fixture(t,overrides={}){
 const root=mkdtempSync(join(tmpdir(),'paper-risk-execute-')),file=join(root,'ledger.sqlite'),db=new Database(file);t.after(()=>{if(db.open)db.close();rmSync(root,{recursive:true,force:true});});
 initializePaperLedger(db);initializePaperExecution(db);initializePaperSells(db);const policy={id:'policy',revision:1,appRevision:1,currency:'USD',ownerId:'owner',accountId:'account',enabled:true,mode:'paper',expiresAt:now+60000,symbols:['AAA'],maxOrder:10000,maxExposure:10000,maxDailyLoss:1000,maxOrders:100,cooldownMs:0,maxQuoteAgeMs:5000,...overrides};provisionPaperAccount(db,{policy,cash:10000,exposure:0});configurePaperExecution(db,{ownerId:'owner',accountId:'account',revision:1,feeBps:100,slippageBps:0,unitScale:1,currency:'USD'});recordPaperExecutionQuote(db,{accountId:'account',symbol:'AAA',priceMinor:1000,quotedAt:now,revision:1,currency:'USD',unitScale:1});
 const reserve=(key='buy')=>reservePaperOrder(db,'owner',{accountId:'account',policyId:'policy',policyRevision:1,appRevision:1,currency:'USD',symbol:'AAA',side:'buy',notional:1010,idempotencyKey:key},()=>now);
 const run=(reservation,executionKey='fill',side='buy',clock=()=>now)=>executeRiskCheckedPaperOrder(db,'owner',{side,accountId:'account',reservationId:reservation.reservationId,executionKey},clock);
 const state=()=>({account:db.prepare('SELECT * FROM paper_accounts').all(),positions:db.prepare('SELECT * FROM paper_positions').all(),buy:db.prepare('SELECT * FROM paper_fills').all(),sell:db.prepare('SELECT * FROM paper_sell_fills').all(),reservations:db.prepare('SELECT * FROM paper_reservations').all(),sellReservations:db.prepare('SELECT * FROM paper_sell_reservations').all()});
 return {db,file,policy,reserve,run,state};
}

import {initializePaperBots,provisionPaperBot,stopPaperBot,revokePaperBot,runPaperBotTick} from '../src/services/trading-paper-bots.ts';

function botFixture(t,options={}){
 const f=fixture(t,options.policy??{});initializePaperBots(f.db);const config={botId:'bot',ownerId:'owner',accountId:'account',policyId:'policy',policyRevision:1,appRevision:1,expiresAt:now+30000,maxSuccessfulTicks:10,cooldownMs:0,...options.bot};assert.equal(provisionPaperBot(f.db,config,()=>now).ok,true);
 const tick=(r,key='tick',side='buy',at=now)=>runPaperBotTick(f.db,'owner',{botId:'bot',tickKey:key,side,reservationId:r.reservationId},()=>at);
 const snapshot=()=>({ledger:f.state(),bots:f.db.prepare('SELECT * FROM paper_bots').all(),ticks:f.db.prepare('SELECT * FROM paper_bot_ticks').all()});return {...f,config,tick,snapshot};
}
test('durable tick executes once and historical replay survives restart, stop, expiry and changed quotes',t=>{
 const f=botFixture(t),r=f.reserve(),first=f.tick(r);assert.equal(first.ok,true);assert.equal(first.replayed,false);assert.equal(f.db.prepare('SELECT successful_ticks FROM paper_bots').get().successful_ticks,1);f.db.close();const db=new Database(f.file);try{stopPaperBot(db,'owner','bot');stopPaperAccount(db,'owner','account');db.exec('UPDATE paper_execution_quotes SET price_minor=2');const before=db.prepare('SELECT * FROM paper_accounts').all();const replay=runPaperBotTick(db,'owner',{botId:'bot',tickKey:'tick',side:'buy',reservationId:r.reservationId},()=>now+70000);assert.equal(replay.ok,true);assert.equal(replay.replayed,true);assert.deepEqual(db.prepare('SELECT * FROM paper_accounts').all(),before);assert.equal(db.prepare('SELECT count(*) n FROM paper_bot_ticks').get().n,1);}finally{db.close();}
});
test('stopped revoked expired and changed revision bots cannot create effects',t=>{
 for(const mutate of [f=>stopPaperBot(f.db,'owner','bot'),f=>revokePaperBot(f.db,'owner','bot'),f=>revokePaperPolicy(f.db,'owner','account','policy'),f=>f.db.exec('UPDATE paper_accounts SET app_revision=2'),f=>f.db.exec('UPDATE paper_policies SET revision=2')]){const f=botFixture(t),r=f.reserve();mutate(f);const before=f.snapshot();assert.equal(f.tick(r).ok,false);assert.deepEqual(f.snapshot(),before);}
 const f=botFixture(t),r=f.reserve();assert.equal(f.tick(r,'expired','buy',f.config.expiresAt).ok,false);
});
test('successful tick cap and cooldown include durable prior ticks',t=>{
 const f=botFixture(t,{bot:{maxSuccessfulTicks:1}}),r=f.reserve();assert.equal(f.tick(r).ok,true);const next=f.reserve('next'),before=f.snapshot();assert.equal(f.tick(next,'next').ok,false);assert.deepEqual(f.snapshot(),before);
 const g=botFixture(t,{bot:{cooldownMs:1000}}),a=g.reserve();assert.equal(g.tick(a).ok,true);const b=g.reserve('next');assert.equal(g.tick(b,'next','buy',now+999).ok,false);assert.equal(g.tick(b,'next','buy',now+1000).ok,true);
});
test('wrong owner cross-policy reservations and changed same-key intent refuse',t=>{
 const f=botFixture(t),r=f.reserve();assert.equal(runPaperBotTick(f.db,'other',{botId:'bot',tickKey:'tick',side:'buy',reservationId:r.reservationId},()=>now).ok,false);assert.equal(f.tick(r).ok,true);const b=f.reserve('next');assert.equal(f.tick(b).ok,false);assert.equal(f.tick(r,'tick','sell').ok,false);
 const g=botFixture(t),a=g.reserve();g.db.prepare("UPDATE paper_reservations SET policy_id='other' WHERE reservation_id=?").run(a.reservationId);assert.equal(g.tick(a).ok,false);
});
test('raw prefilled reservation cannot be adopted by a new bot tick',t=>{
 const f=botFixture(t),r=f.reserve();assert.equal(f.run(r,'raw').ok,true);const before=f.snapshot();assert.equal(f.tick(r).ok,false);assert.deepEqual(f.snapshot(),before);
});
test('post-risk denial and bot receipt failure roll back all fill and counter changes',t=>{
 const f=botFixture(t,{policy:{maxDailyLoss:20}}),r=f.reserve(),before=f.snapshot();assert.equal(f.tick(r).ok,false);assert.deepEqual(f.snapshot(),before);
 const g=botFixture(t),b=g.reserve();g.db.exec("CREATE TRIGGER refuse_tick AFTER INSERT ON paper_bot_ticks BEGIN SELECT RAISE(ABORT,'private detail'); END");const snapshot=g.snapshot();assert.deepEqual(g.tick(b),{ok:false,reason:'unavailable'});assert.deepEqual(g.snapshot(),snapshot);
});
test('canonical request receipt and counter corruption fail closed for replay and new ticks',t=>{
 for(const sql of ["UPDATE paper_bot_ticks SET request_json='{}'","UPDATE paper_bot_ticks SET receipt_json='{}'","UPDATE paper_bot_ticks SET receipt_hash='bad'",'UPDATE paper_bots SET successful_ticks=0','UPDATE paper_bots SET last_success_at=last_success_at+1',"UPDATE paper_bot_ticks SET policy_id='other'",'UPDATE paper_fills SET total_minor=1']){const f=botFixture(t),r=f.reserve();assert.equal(f.tick(r).ok,true);f.db.exec(sql);const before=f.snapshot();assert.equal(f.tick(r).ok,false,sql);const b=f.reserve('next');if(b.ok)assert.equal(f.tick(b,'next').ok,false,sql);assert.deepEqual(f.snapshot().bots,before.bots);assert.deepEqual(f.snapshot().ticks,before.ticks);}
});
test('trusted provisioning is bounded immutable and not an owner authorization implementation',t=>{
 const f=botFixture(t);assert.equal(provisionPaperBot(f.db,f.config,()=>now).ok,false);for(const changed of [{maxSuccessfulTicks:0},{maxSuccessfulTicks:1001},{maxSuccessfulTicks:1.5},{expiresAt:now+60001},{ownerId:'other'},{policyRevision:2},{appRevision:2}])assert.equal(provisionPaperBot(f.db,{...f.config,botId:'invalid',...changed},()=>now).ok,false);assert.equal(stopPaperBot(f.db,'other','bot').ok,false);assert.equal(revokePaperBot(f.db,'owner','bot').ok,true);assert.equal(stopPaperBot(f.db,'owner','bot').ok,false);
});
test('separate SQLite workers cannot exceed a one-success bot cap',async t=>{
 const f=botFixture(t,{bot:{maxSuccessfulTicks:1}}),a=f.reserve('one'),b=f.reserve('two'),module=new URL('../src/services/trading-paper-bots.ts',import.meta.url).pathname,root=new URL('..',import.meta.url).pathname;
 const code=`import{createRequire}from'node:module';import{parentPort,workerData as d}from'node:worker_threads';const require=createRequire(d.root+'/package.json');require('tsx/cjs');const Database=require('better-sqlite3'),{runPaperBotTick}=require(d.module),db=new Database(d.file,{timeout:5000});try{parentPort.postMessage(runPaperBotTick(db,'owner',d.input,()=>d.now));}finally{db.close();}`;
 const run=(r,key)=>new Promise((resolve,reject)=>{const w=new Worker(code,{eval:true,type:'module',workerData:{root,module,file:f.file,now,input:{botId:'bot',tickKey:key,side:'buy',reservationId:r.reservationId}}});w.once('message',resolve);w.once('error',reject);});const outcomes=await Promise.all([run(a,'one'),run(b,'two')]);assert.equal(outcomes.filter(x=>x.ok).length,1);assert.equal(f.db.prepare('SELECT count(*) n FROM paper_fills').get().n,1);assert.equal(f.db.prepare('SELECT successful_ticks FROM paper_bots').get().successful_ticks,1);
});

test('actual child SIGKILL after fill and tick insert recovers the entire uncommitted transaction',async t=>{
 const f=botFixture(t),r=f.reserve(),before=f.snapshot(),module=new URL('../src/services/trading-paper-bots.ts',import.meta.url).href;
 f.db.exec('CREATE TRIGGER crash_tick AFTER INSERT ON paper_bot_ticks BEGIN SELECT crash_now(); END');
 const script=`import Database from 'better-sqlite3';import{runPaperBotTick}from${JSON.stringify(module)};const db=new Database(${JSON.stringify(f.file)});db.function('crash_now',()=>{process.kill(process.pid,'SIGKILL');});runPaperBotTick(db,'owner',${JSON.stringify({botId:'bot',tickKey:'crash',side:'buy',reservationId:r.reservationId})},()=>${now});process.exit(2);`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:new URL('..',import.meta.url).pathname,stdio:'ignore'});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('owned crash fixture timed out'));},5000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',(code,signal)=>{clearTimeout(timer);try{assert.equal(signal,'SIGKILL');resolve();}catch(error){reject(error);}});});
 f.db.close();const db=new Database(f.file);try{assert.deepEqual(db.prepare('SELECT * FROM paper_accounts').all(),before.ledger.account);assert.deepEqual(db.prepare('SELECT * FROM paper_positions').all(),before.ledger.positions);assert.deepEqual(db.prepare('SELECT * FROM paper_reservations').all(),before.ledger.reservations);assert.deepEqual(db.prepare('SELECT * FROM paper_bots').all(),before.bots);assert.equal(db.prepare('SELECT count(*) n FROM paper_bot_ticks').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM paper_fills').get().n,0);db.exec('DROP TRIGGER crash_tick');const result=runPaperBotTick(db,'owner',{botId:'bot',tickKey:'crash',side:'buy',reservationId:r.reservationId},()=>now);assert.equal(result.ok,true);assert.equal(db.prepare('SELECT successful_ticks FROM paper_bots').get().successful_ticks,1);assert.equal(db.prepare('SELECT count(*) n FROM paper_fills').get().n,1);}finally{db.close();}
});
test('sell ticks use server-derived keys and normalized inputs survive caller clock mutation',t=>{
 const f=botFixture(t),r=f.reserve();const request={botId:'bot',tickKey:'buy',side:'buy',reservationId:r.reservationId};let calls=0;const buy=runPaperBotTick(f.db,'owner',request,()=>{calls++;request.reservationId='changed';return now;});assert.equal(buy.ok,true);assert.equal(calls,1);const sell=reservePaperSell(f.db,'owner',{accountId:'account',policyId:'policy',policyRevision:1,appRevision:1,currency:'USD',symbol:'AAA',quantityUnits:1,idempotencyKey:'sell'},()=>now);assert.equal(f.tick(sell,'sell','sell').ok,true);assert.equal(f.tick(sell,'sell','sell').replayed,true);assert.equal(f.db.prepare('SELECT successful_ticks FROM paper_bots').get().successful_ticks,2);
});

test('altering tick and last-success clocks together cannot forge original fill time or cooldown history',t=>{
 const f=botFixture(t),r=f.reserve();assert.equal(f.tick(r).ok,true);f.db.exec('UPDATE paper_bot_ticks SET created_at=created_at+1; UPDATE paper_bots SET last_success_at=last_success_at+1');assert.equal(f.tick(r,'tick','buy',now+1).ok,false);
 const g=botFixture(t),a=g.reserve();assert.equal(g.tick(a,'first').ok,true);const b=g.reserve('second');assert.equal(g.tick(b,'second').ok,true);g.db.exec('UPDATE paper_bots SET cooldown_ms=1');assert.equal(g.tick(b,'second').ok,false);
 const h=botFixture(t),c=h.reserve();assert.equal(h.tick(c).ok,true);h.db.prepare('UPDATE paper_bots SET expires_at=?').run(now);assert.equal(h.tick(c).ok,false);
});

test('read-only bot history inspection validates original tick receipts without acquiring execution authority',async t=>{
 const {inspectPaperBotHistory}=await import('../src/services/trading-paper-bots.ts');
 const f=botFixture(t),r=f.reserve();assert.equal(f.tick(r).ok,true);const before=f.snapshot();f.db.pragma('query_only=ON');
 try{assert.deepEqual(inspectPaperBotHistory(f.db,'owner','bot',now),{ok:true,successfulTicks:1,lastSuccessAt:now,status:'active'});f.db.transaction(()=>assert.equal(inspectPaperBotHistory(f.db,'owner','bot',now).ok,true)).deferred();assert.equal(inspectPaperBotHistory(f.db,'other','bot',now).ok,false);}finally{f.db.pragma('query_only=OFF');}
 assert.deepEqual(f.snapshot(),before);f.db.prepare("UPDATE paper_bot_ticks SET receipt_hash='bad'").run();assert.equal(inspectPaperBotHistory(f.db,'owner','bot',now).ok,false);
});

test('trusted tick composition rolls back outer failures and distinguishes refusal from SQL errors',async t=>{
 const {runPaperBotTickInTransaction,isPaperBotTickRefusal}=await import('../src/services/trading-paper-bots.ts');
 const f=botFixture(t),r=f.reserve(),input={botId:'bot',tickKey:'composed',side:'buy',reservationId:r.reservationId},before=f.snapshot();
 assert.throws(()=>runPaperBotTickInTransaction(f.db,'owner',input,now),isPaperBotTickRefusal);
 assert.throws(()=>f.db.transaction(()=>{assert.equal(runPaperBotTickInTransaction(f.db,'owner',input,now).ok,true);throw Error('Owned outer failure');}).immediate(),/Owned outer failure/);
 assert.deepEqual(f.snapshot(),before);
 assert.throws(()=>f.db.transaction(()=>runPaperBotTickInTransaction(f.db,'other',input,now)).immediate(),isPaperBotTickRefusal);
 f.db.exec("CREATE TRIGGER refuse_composed_tick AFTER INSERT ON paper_bot_ticks BEGIN SELECT RAISE(ABORT,'owned SQL failure'); END");
 assert.throws(()=>f.db.transaction(()=>runPaperBotTickInTransaction(f.db,'owner',input,now)).immediate(),error=>!isPaperBotTickRefusal(error));assert.deepEqual(f.snapshot(),before);
});
