import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializePaperLedger,provisionPaperAccount,reservePaperOrder,stopPaperAccount,revokePaperPolicy} from '../src/services/trading-paper-ledger.ts';
import {initializePaperExecution,configurePaperExecution,recordPaperExecutionQuote,executePaperBuy} from '../src/services/trading-paper-execution.ts';
import {initializePaperSells,reservePaperSell,executePaperSell} from '../src/services/trading-paper-sells.ts';
import {readPaperRisk} from '../src/services/trading-paper-risk.ts';
const now=1800000000000;
function fixture(t,symbols=['AAA','BBB']){
 const root=mkdtempSync(join(tmpdir(),'paper-risk-')),db=new Database(join(root,'ledger.sqlite'));t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
 initializePaperLedger(db);initializePaperExecution(db);initializePaperSells(db);
 const policy={id:'policy',revision:1,appRevision:1,currency:'USD',ownerId:'owner',accountId:'account',enabled:true,mode:'paper',expiresAt:now+86400000*3,symbols,maxOrder:1000000,maxExposure:1000000,maxDailyLoss:10000,maxOrders:1000,cooldownMs:0,maxQuoteAgeMs:5000};
 provisionPaperAccount(db,{policy,cash:1000000,exposure:0});configurePaperExecution(db,{ownerId:'owner',accountId:'account',revision:1,feeBps:100,slippageBps:0,unitScale:1,currency:'USD'});
 const quote=(symbol,price=1000,revision=1,stamp=now)=>recordPaperExecutionQuote(db,{accountId:'account',symbol,priceMinor:price,quotedAt:stamp,revision,currency:'USD',unitScale:1});
 const buy=(symbol,key=symbol)=>{quote(symbol);const r=reservePaperOrder(db,'owner',{accountId:'account',policyId:'policy',policyRevision:1,appRevision:1,currency:'USD',symbol,side:'buy',notional:1010,idempotencyKey:key},()=>now);assert.equal(r.ok,true);assert.equal(executePaperBuy(db,'owner',{accountId:'account',reservationId:r.reservationId,executionKey:key},()=>now).ok,true);};
 const read=(at=now)=>readPaperRisk(db,'owner','account','policy',()=>at);
 return {db,policy,quote,buy,read};
}
test('losses include liquidation fees and profitable assets never offset losing assets',t=>{
 const f=fixture(t);f.buy('AAA');f.buy('BBB');f.quote('AAA',500,2);f.quote('BBB',2000,2);const risk=f.read();assert.equal(risk.ok,true);assert.equal(risk.markedExposure,2500);assert.equal(risk.netLiquidationValue,2475);assert.equal(risk.estimatedLiquidationFee,25);assert.equal(risk.unrealizedPnL,475);assert.equal(risk.positiveLiquidationLoss,505);assert.equal(risk.bookedDailyLoss,20);assert.equal(risk.conservativeLoss,525);assert.equal(risk.equity,1000455);assert.equal(risk.allowed,true);assert.equal(risk.minQuoteAt,now);assert.equal(risk.maxQuoteAt,now);
 f.db.prepare('UPDATE paper_policies SET policy_json=?').run(JSON.stringify({...f.policy,maxDailyLoss:525}));assert.equal(f.read().allowed,false);
});
test('integer bid and fee rounding and both exposure caps are conservative',t=>{
 const f=fixture(t);f.buy('AAA');configurePaperExecution(f.db,{ownerId:'owner',accountId:'account',revision:2,feeBps:1,slippageBps:1,unitScale:1,currency:'USD'});const risk=f.read();assert.equal(risk.markedExposure,999);assert.equal(risk.estimatedLiquidationFee,1);assert.equal(risk.positiveLiquidationLoss,2);
 f.db.prepare('UPDATE paper_policies SET policy_json=?').run(JSON.stringify({...f.policy,maxExposure:999}));assert.equal(f.read().allowed,false);
 f.db.prepare('UPDATE paper_policies SET policy_json=?').run(JSON.stringify({...f.policy,maxExposure:1500}));f.quote('AAA',2000,2);assert.equal(f.read().allowed,false);
});
test('current stop, revoke, identity, policy/profile corruption and untracked exposure refuse',t=>{
 for(const mutate of [f=>stopPaperAccount(f.db,'owner','account'),f=>revokePaperPolicy(f.db,'owner','account','policy'),f=>f.db.exec("UPDATE paper_execution_profiles SET owner_id='other'"),f=>f.db.exec('UPDATE paper_execution_profiles SET fee_bps=-1'),f=>f.db.exec('UPDATE paper_accounts SET exposure=exposure+1'),f=>f.db.exec('UPDATE paper_accounts SET app_revision=2'),f=>f.db.prepare('UPDATE paper_policies SET policy_json=?').run(JSON.stringify({...f.policy,expiresAt:now}))]){const f=fixture(t);f.buy('AAA');mutate(f);assert.equal(f.read().ok,false);}
 const f=fixture(t);assert.equal(readPaperRisk(f.db,'other','account','policy',()=>now).ok,false);assert.equal(readPaperRisk(f.db,'owner','account','wrong',()=>now).ok,false);assert.equal(f.read(NaN).ok,false);
});
test('every open quote is checked including holdings beyond the 100-position display window',t=>{
 const symbols=Array.from({length:101},(_,i)=>'S'+String(i).padStart(3,'0')),f=fixture(t,symbols);for(const symbol of symbols)f.buy(symbol);assert.equal(f.read().positionCount,101);
 for(const sql of ["UPDATE paper_execution_quotes SET quoted_at=quoted_at-5001 WHERE symbol='S100'","UPDATE paper_execution_quotes SET quoted_at=quoted_at+1 WHERE symbol='S100'","DELETE FROM paper_execution_quotes WHERE symbol='S100'"]){f.db.exec('SAVEPOINT quote_corruption');f.db.exec(sql);assert.equal(f.read().ok,false);f.db.exec('ROLLBACK TO quote_corruption');f.db.exec('RELEASE quote_corruption');}
 f.db.exec("DELETE FROM paper_quotes WHERE symbol='S100'");assert.equal(f.read().ok,false);
});
test('closed zero positions need no quotes; query-only risk assessment never mutates',t=>{
 const f=fixture(t);f.buy('AAA');const s=reservePaperSell(f.db,'owner',{accountId:'account',policyId:'policy',policyRevision:1,appRevision:1,currency:'USD',symbol:'AAA',quantityUnits:1,idempotencyKey:'sell'},()=>now);assert.equal(executePaperSell(f.db,'owner',{accountId:'account',reservationId:s.reservationId,executionKey:'sell'},()=>now).ok,true);f.db.exec('DELETE FROM paper_execution_quotes; DELETE FROM paper_quotes');const before=f.db.prepare('SELECT total_changes() n').get().n;f.db.pragma('query_only=ON');const risk=f.read();assert.equal(risk.ok,true);assert.equal(risk.positionCount,0);assert.equal(risk.bookedDailyLoss,20);assert.equal(risk.minQuoteAt,null);assert.equal(risk.maxQuoteAt,null);assert.equal(risk.netLiquidationValue,0);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
});
test('daily booked losses roll at UTC boundary without claiming an equity baseline',t=>{
 const f=fixture(t);f.buy('AAA');f.quote('AAA',500,2);const s=reservePaperSell(f.db,'owner',{accountId:'account',policyId:'policy',policyRevision:1,appRevision:1,currency:'USD',symbol:'AAA',quantityUnits:1,idempotencyKey:'loss'},()=>now);executePaperSell(f.db,'owner',{accountId:'account',reservationId:s.reservationId,executionKey:'loss'},()=>now);assert.equal(f.read().bookedDailyLoss,515);const tomorrow=Math.floor(now/86400000)*86400000+86400000;assert.equal(f.read(tomorrow).bookedDailyLoss,0);
});
test('unsafe quote/equity arithmetic and corrupt history fail closed',t=>{
 const f=fixture(t);f.buy('AAA');f.buy('AAA','second');f.quote('AAA',Number.MAX_SAFE_INTEGER,2);assert.equal(f.read().ok,false);
 const g=fixture(t);g.buy('AAA');g.db.prepare('UPDATE paper_accounts SET cash=?').run(Number.MAX_SAFE_INTEGER);assert.equal(g.read().ok,false);
 const h=fixture(t);h.buy('AAA');h.db.exec('UPDATE paper_fills SET total_minor=1');assert.equal(h.read().ok,false);
});

test('pending buy reservations count toward both caps, missing adjuncts refuse without initialization',t=>{
 const f=fixture(t);f.buy('AAA');const r=reservePaperOrder(f.db,'owner',{accountId:'account',policyId:'policy',policyRevision:1,appRevision:1,currency:'USD',symbol:'AAA',side:'buy',notional:1010,idempotencyKey:'pending'},()=>now);assert.equal(r.ok,true);assert.equal(f.read().pendingBuyExposure,1010);f.db.prepare('UPDATE paper_policies SET policy_json=?').run(JSON.stringify({...f.policy,maxExposure:2009}));assert.equal(f.read().allowed,false);
 const g=fixture(t);g.db.exec('DROP TABLE paper_sell_fills');const before=g.db.prepare('SELECT count(*) n FROM sqlite_master').get().n;assert.equal(g.read().ok,false);assert.equal(g.db.prepare('SELECT count(*) n FROM sqlite_master').get().n,before);
});

test('policy-excluded holdings remain fully valued and require fresh quotes',t=>{
 const f=fixture(t);f.buy('AAA');f.buy('BBB');f.db.prepare('UPDATE paper_policies SET policy_json=?').run(JSON.stringify({...f.policy,symbols:['AAA']}));
 const risk=f.read();assert.equal(risk.ok,true);assert.equal(risk.positionCount,2);assert.equal(risk.bookExposure,2000);assert.equal(risk.markedExposure,2000);assert.equal(risk.positiveLiquidationLoss,20);
 f.db.exec("UPDATE paper_execution_quotes SET quoted_at=quoted_at-5001 WHERE symbol='BBB'; UPDATE paper_quotes SET quote_at=quote_at-5001 WHERE symbol='BBB'");assert.equal(f.read().ok,false);
 f.quote('BBB',1000,2);assert.equal(f.read().positionCount,2);f.db.exec("DELETE FROM paper_execution_quotes WHERE symbol='BBB'");assert.equal(f.read().ok,false);
});

test('clock rollback behind buy or sell cancellation refuses released reservations',t=>{
 for(const side of ['buy','sell']){
 const f=fixture(t);f.buy('AAA');
 if(side==='buy'){const r=reservePaperOrder(f.db,'owner',{accountId:'account',policyId:'policy',policyRevision:1,appRevision:1,currency:'USD',symbol:'AAA',side:'buy',notional:1010,idempotencyKey:'future-cancel'},()=>now);assert.equal(r.ok,true);f.db.prepare("UPDATE paper_reservations SET status='cancelled',cancelled_at=? WHERE reservation_id=?").run(now+1,r.reservationId);}
 else{const r=reservePaperSell(f.db,'owner',{accountId:'account',policyId:'policy',policyRevision:1,appRevision:1,currency:'USD',symbol:'AAA',quantityUnits:1,idempotencyKey:'future-cancel'},()=>now);assert.equal(r.ok,true);f.db.prepare("UPDATE paper_sell_reservations SET status='cancelled',cancelled_at=? WHERE id=?").run(now+1,r.reservationId);}
 assert.equal(f.read().ok,false,side);assert.equal(f.read(now+1).ok,true,side);
 }
});
