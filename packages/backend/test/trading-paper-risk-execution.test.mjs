import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Worker} from 'node:worker_threads';
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
test('new buy and sell execute atomically with one clock sample and replay is historical',t=>{
 const f=fixture(t),r=f.reserve();let calls=0;const b=f.run(r,'buy-fill','buy',()=>{calls++;return now;});assert.equal(b.ok,true);assert.equal(b.replayed,false);assert.equal(calls,1);
 const s=reservePaperSell(f.db,'owner',{accountId:'account',policyId:'policy',policyRevision:1,appRevision:1,currency:'USD',symbol:'AAA',quantityUnits:1,idempotencyKey:'sell'},()=>now);const sale=f.run(s,'sell-fill','sell');assert.equal(sale.ok,true);assert.equal(sale.replayed,false);const before=f.state();stopPaperAccount(f.db,'owner','account');const stopped=f.state();assert.equal(f.run(s,'sell-fill','sell').replayed,true);assert.deepEqual(f.state(),stopped);assert.equal(before.account[0].cash,9980);
});
test('pre-risk rejection and post-fill strict loss boundary leave every persisted value unchanged',t=>{
 const f=fixture(t,{maxDailyLoss:20}),r=f.reserve(),before=f.state();assert.equal(f.run(r).ok,false);assert.deepEqual(f.state(),before);assert.equal(f.db.prepare('SELECT count(*) n FROM paper_fills').get().n,0);
 const g=fixture(t),a=g.reserve();stopPaperAccount(g.db,'owner','account');const stopped=g.state();assert.equal(g.run(a).ok,false);assert.deepEqual(g.state(),stopped);
});
test('post-fill slippage losses and changed marked exposure roll back trigger effects too',t=>{
 const f=fixture(t,{maxDailyLoss:25});configurePaperExecution(f.db,{ownerId:'owner',accountId:'account',revision:2,feeBps:100,slippageBps:100,unitScale:1,currency:'USD'});recordPaperExecutionQuote(f.db,{accountId:'account',symbol:'AAA',priceMinor:990,quotedAt:now,revision:2,currency:'USD',unitScale:1});const r=f.reserve();assert.equal(r.ok,true);const before=f.state();assert.equal(f.run(r).ok,false);assert.deepEqual(f.state(),before);
 const g=fixture(t,{maxExposure:1500}),s=g.reserve();g.db.exec("CREATE TABLE side_effect(value INTEGER); CREATE TRIGGER widen_mark AFTER INSERT ON paper_fills BEGIN INSERT INTO side_effect VALUES(1); UPDATE paper_execution_quotes SET price_minor=2000; END");const snapshot=g.state();assert.equal(g.run(s).ok,false);assert.deepEqual(g.state(),snapshot);assert.equal(g.db.prepare('SELECT count(*) n FROM side_effect').get().n,0);assert.equal(g.db.prepare('SELECT price_minor FROM paper_execution_quotes').get().price_minor,1000);
});
test('identity validation, wrong owner, stale/future quotes and revocation refuse',t=>{
 const f=fixture(t),r=f.reserve();for(const input of [null,[],{side:'buy',accountId:'account',reservationId:r.reservationId,executionKey:'x',price:1},{side:'live',accountId:'account',reservationId:r.reservationId,executionKey:'x'}])assert.equal(executeRiskCheckedPaperOrder(f.db,'owner',input,()=>now).ok,false);assert.equal(executeRiskCheckedPaperOrder(f.db,'other',{side:'buy',accountId:'account',reservationId:r.reservationId,executionKey:'x'},()=>now).ok,false);
 for(const stamp of [now-5001,now+1]){f.db.prepare('UPDATE paper_execution_quotes SET quoted_at=?').run(stamp);f.db.prepare('UPDATE paper_quotes SET quote_at=?').run(stamp);assert.equal(f.run(r).ok,false);}const g=fixture(t),s=g.reserve();revokePaperPolicy(g.db,'owner','account','policy');assert.equal(g.run(s).ok,false);
});
test('restart replay survives stop/quote changes but different key and cross-side collisions refuse',t=>{
 const f=fixture(t),r=f.reserve();assert.equal(f.run(r).ok,true);f.db.close();const db=new Database(f.file);try{stopPaperAccount(db,'owner','account');db.exec('UPDATE paper_execution_quotes SET price_minor=2');const before=db.prepare('SELECT * FROM paper_accounts').all();const input={side:'buy',accountId:'account',reservationId:r.reservationId,executionKey:'fill'};assert.equal(executeRiskCheckedPaperOrder(db,'owner',input,()=>now).replayed,true);assert.equal(executeRiskCheckedPaperOrder(db,'owner',{...input,executionKey:'new'},()=>now).ok,false);assert.equal(executeRiskCheckedPaperOrder(db,'owner',{...input,side:'sell'},()=>now).ok,false);assert.deepEqual(db.prepare('SELECT * FROM paper_accounts').all(),before);}finally{db.close();}
});
test('failed SQLite settlement trigger is sanitized and fully rolled back',t=>{
 const f=fixture(t),r=f.reserve(),before=f.state();f.db.exec("CREATE TRIGGER fail_fill AFTER INSERT ON paper_fills BEGIN SELECT RAISE(ABORT,'private trigger detail'); END");const result=f.run(r);assert.deepEqual(result,{ok:false,reason:'unavailable'});assert.deepEqual(f.state(),before);
});
test('independent SQLite workers serialize same-reservation different-key execution',async t=>{
 const f=fixture(t),r=f.reserve(),module=new URL('../src/services/trading-paper-risk-execution.ts',import.meta.url).pathname,root=new URL('..',import.meta.url).pathname;
 const code=`import{createRequire}from'node:module';import{parentPort,workerData as d}from'node:worker_threads';const require=createRequire(d.root+'/package.json');require('tsx/cjs');const Database=require('better-sqlite3'),{executeRiskCheckedPaperOrder}=require(d.module),db=new Database(d.file,{timeout:5000});try{parentPort.postMessage(executeRiskCheckedPaperOrder(db,'owner',d.input,()=>d.now));}finally{db.close();}`;
 const run=key=>new Promise((resolve,reject)=>{const w=new Worker(code,{eval:true,type:'module',workerData:{root,module,file:f.file,now,input:{side:'buy',accountId:'account',reservationId:r.reservationId,executionKey:key}}});w.once('message',resolve);w.once('error',reject);});const outcomes=await Promise.all([run('one'),run('two')]);assert.equal(outcomes.filter(r=>r.ok).length,1);assert.equal(f.db.prepare('SELECT count(*) n FROM paper_fills').get().n,1);assert.equal(f.db.prepare('SELECT cash FROM paper_accounts').get().cash,8990);
});

test('sell fee rounding can breach post-settlement strict cap and rolls back inventory status and fill',t=>{
 const f=fixture(t,{maxDailyLoss:3});configurePaperExecution(f.db,{ownerId:'owner',accountId:'account',revision:2,feeBps:1,slippageBps:0,unitScale:1,currency:'USD'});recordPaperExecutionQuote(f.db,{accountId:'account',symbol:'AAA',priceMinor:1,quotedAt:now,revision:2,currency:'USD',unitScale:1});
 const b=reservePaperOrder(f.db,'owner',{accountId:'account',policyId:'policy',policyRevision:1,appRevision:1,currency:'USD',symbol:'AAA',side:'buy',notional:4,idempotencyKey:'tiny'},()=>now);assert.equal(f.run(b,'tiny').ok,true);
 const s=reservePaperSell(f.db,'owner',{accountId:'account',policyId:'policy',policyRevision:1,appRevision:1,currency:'USD',symbol:'AAA',quantityUnits:1,idempotencyKey:'tiny-sell'},()=>now);assert.equal(s.ok,true);const before=f.state();assert.equal(f.run(s,'tiny-sell','sell').ok,false);assert.deepEqual(f.state(),before);assert.equal(f.db.prepare('SELECT count(*) n FROM paper_sell_fills').get().n,0);
});
test('accessor authority and existing caller transactions refuse without effects',t=>{
 const f=fixture(t),r=f.reserve(),before=f.state();let calls=0;const input={side:'buy',accountId:'account',reservationId:r.reservationId,get executionKey(){calls++;return 'getter';}};assert.equal(executeRiskCheckedPaperOrder(f.db,'owner',input,()=>now).ok,false);assert.equal(calls,0);f.db.transaction(()=>{assert.equal(f.run(r).ok,false);assert.deepEqual(f.state(),before);}).deferred();
});
