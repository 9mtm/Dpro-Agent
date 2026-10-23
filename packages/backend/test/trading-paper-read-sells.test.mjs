import test from 'node:test';import assert from 'node:assert/strict';import Database from 'better-sqlite3';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {Worker} from 'node:worker_threads';
import {initializePaperLedger,provisionPaperAccount,reservePaperOrder,readPaperAccount,stopPaperAccount,revokePaperPolicy} from '../src/services/trading-paper-ledger.ts';
import {initializePaperExecution,configurePaperExecution,recordPaperExecutionQuote,executePaperBuy} from '../src/services/trading-paper-execution.ts';
import {initializePaperSells,reservePaperSell,cancelPaperSell,executePaperSell} from '../src/services/trading-paper-sells.ts';
const now=1800000000000;
const policy={id:'bot',revision:1,appRevision:1,currency:'USD',ownerId:'owner',accountId:'account',enabled:true,mode:'paper',expiresAt:now+60000,symbols:['ABC'],maxOrder:10000,maxExposure:20000,maxDailyLoss:10000,maxOrders:10,cooldownMs:0,maxQuoteAgeMs:5000};
const buy={accountId:'account',policyId:'bot',policyRevision:1,appRevision:1,currency:'USD',symbol:'ABC',side:'buy',notional:5000,idempotencyKey:'buy'};
const sell=(key='sell',quantityUnits=2)=>({accountId:'account',policyId:'bot',policyRevision:1,appRevision:1,currency:'USD',symbol:'ABC',quantityUnits,idempotencyKey:key});
const req=(id,key='execute')=>({accountId:'account',reservationId:id,executionKey:key});
function fixture(t){const root=mkdtempSync(join(tmpdir(),'paper-sells-')),file=join(root,'ledger.sqlite'),db=new Database(file);t.after(()=>{if(db.open)db.close();rmSync(root,{recursive:true,force:true});});initializePaperLedger(db);initializePaperExecution(db);initializePaperSells(db);provisionPaperAccount(db,{policy,cash:10000,exposure:0});configurePaperExecution(db,{ownerId:'owner',accountId:'account',revision:1,feeBps:100,slippageBps:0,unitScale:1,currency:'USD'});recordPaperExecutionQuote(db,{accountId:'account',symbol:'ABC',priceMinor:1000,quotedAt:now,revision:1,currency:'USD',unitScale:1});const r=reservePaperOrder(db,'owner',buy,()=>now);assert.equal(executePaperBuy(db,'owner',req(r.reservationId,'buy'),()=>now).ok,true);return {db,file};}

test('v1 stays unchanged until sell history; pending, cancelled, partial, full and rebuy project exact v2 totals',t=>{
 const {db}=fixture(t);assert.equal(readPaperAccount(db,'owner','account').execution.version,1);
 const pending=reservePaperSell(db,'owner',sell('pending',1),()=>now);let view=readPaperAccount(db,'owner','account');assert.equal(view.ok,true);assert.equal(view.execution.version,2);assert.equal(view.sellHistory.reservedUnits,1);assert.equal(view.pendingCount,0);
 cancelPaperSell(db,'owner','account',pending.reservationId,()=>now);view=readPaperAccount(db,'owner','account');assert.equal(view.sellHistory.reservations[0].status,'cancelled');assert.equal(view.sellHistory.reservedUnits,0);
 const partial=reservePaperSell(db,'owner',sell('partial',2),()=>now);executePaperSell(db,'owner',req(partial.reservationId,'partial'),()=>now);view=readPaperAccount(db,'owner','account');assert.equal(view.ok,true);assert.equal(view.execution.buyGrossTotal,4000);assert.equal(view.execution.sellGrossTotal,2000);assert.equal(view.execution.buyFeeTotal,40);assert.equal(view.execution.sellFeeTotal,20);assert.equal(view.execution.realizedPnLTotal,-20);assert.equal(view.execution.positionCost,2000);assert.equal(view.execution.fills.filter(f=>f.side==='sell')[0].netMinor,1980);
 const full=reservePaperSell(db,'owner',sell('full',2),()=>now);executePaperSell(db,'owner',req(full.reservationId,'full'),()=>now);view=readPaperAccount(db,'owner','account');assert.equal(view.execution.positionCount,0);assert.deepEqual(view.execution.positions,[]);assert.equal(view.execution.positionCost,0);
 const b=reservePaperOrder(db,'owner',{...buy,notional:2000,idempotencyKey:'rebuy'},()=>now);executePaperBuy(db,'owner',req(b.reservationId,'rebuy'),()=>now);view=readPaperAccount(db,'owner','account');assert.equal(view.ok,true);assert.equal(view.execution.positionCost,1000);assert.equal(view.execution.positions[0].quantityUnits,1);assert.equal(readPaperAccount(db,'other','account').ok,false);
});
test('negative and positive realized PnL preserve unsigned market losses and fee totals',t=>{
 for(const price of [500,2000]){const {db}=fixture(t);recordPaperExecutionQuote(db,{accountId:'account',symbol:'ABC',priceMinor:price,quotedAt:now,revision:2,currency:'USD',unitScale:1});const r=reservePaperSell(db,'owner',sell(),()=>now);const fill=executePaperSell(db,'owner',req(r.reservationId),()=>now);assert.equal(fill.ok,true);const view=readPaperAccount(db,'owner','account');assert.equal(view.ok,true);assert.equal(view.execution.realizedPnLTotal,price*2-Math.ceil(price*2/100)-2000);assert.equal(view.execution.marketLossTotal,Math.max(2000-price*2,0));assert.equal(view.execution.feeTotal,40+Math.ceil(price*2/100));}
});
test('all historical canonical snapshots and receipts fail closed when corrupted',t=>{
 for(const sql of ["UPDATE paper_reservation_intents SET canonical_json='{}'",'UPDATE paper_fills SET total_minor=1',"UPDATE paper_sell_reservations SET intent_json='{}'",'UPDATE paper_sell_fills SET removed_cost_minor=1999,realized_pnl_minor=net_minor-1999',"UPDATE paper_sell_fills SET execution_key='buy'",'UPDATE paper_positions SET cost_minor=1999','DELETE FROM paper_sell_reservations']){const {db}=fixture(t);const r=reservePaperSell(db,'owner',sell(),()=>now);executePaperSell(db,'owner',req(r.reservationId),()=>now);db.exec(sql);assert.equal(readPaperAccount(db,'owner','account').ok,false,sql);}
});
test('bounded sell history validates corruption outside the visible window and GET does not write',t=>{
 const {db}=fixture(t);db.prepare('UPDATE paper_policies SET policy_json=?').run(JSON.stringify({...policy,maxOrders:1000}));
 for(let i=0;i<205;i++){const r=reservePaperSell(db,'owner',sell('history-'+i,1),()=>now+i);assert.equal(r.ok,true);cancelPaperSell(db,'owner','account',r.reservationId,()=>now+i);}
 const before=db.prepare('SELECT total_changes() n').get().n;const view=readPaperAccount(db,'owner','account');assert.equal(view.ok,true);assert.equal(view.sellHistory.reservationCount,205);assert.equal(view.sellHistory.reservations.length,200);assert.equal(view.sellHistory.pendingCount,0);assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
 db.prepare("UPDATE paper_sell_reservations SET intent_json='{}' WHERE idempotency_key='history-0'").run();assert.equal(readPaperAccount(db,'owner','account').ok,false);
});
test('combined fill window is bounded and full historical buy integrity is checked outside it',t=>{
 const {db}=fixture(t);db.prepare('UPDATE paper_policies SET policy_json=?').run(JSON.stringify({...policy,maxOrders:1000}));
 for(let i=0;i<103;i++){
  const b=reservePaperOrder(db,'owner',{...buy,notional:1010,idempotencyKey:'cycle-buy-'+i},()=>now+i);assert.equal(b.ok,true);assert.equal(executePaperBuy(db,'owner',req(b.reservationId,'cycle-buy-'+i),()=>now+i).ok,true);
  const s=reservePaperSell(db,'owner',sell('cycle-sell-'+i,1),()=>now+i);assert.equal(s.ok,true);assert.equal(executePaperSell(db,'owner',req(s.reservationId,'cycle-sell-'+i),()=>now+i).ok,true);
 }
 const view=readPaperAccount(db,'owner','account');assert.equal(view.ok,true);assert.equal(view.execution.fillCount,207);assert.equal(view.execution.fills.length,200);assert.equal(view.execution.buyFillCount,104);assert.equal(view.execution.sellFillCount,103);assert.equal(view.execution.positions[0].quantityUnits,4);
 const sorted=[...view.execution.fills].sort((a,b)=>a.createdAt-b.createdAt||(a.id<b.id?-1:a.id>b.id?1:0));assert.deepEqual(view.execution.fills,sorted);
 db.prepare("UPDATE paper_reservation_intents SET profile_hash='bad' WHERE reservation_id=(SELECT reservation_id FROM paper_reservations WHERE idempotency_key='buy')").run();assert.equal(readPaperAccount(db,'owner','account').ok,false);
});
