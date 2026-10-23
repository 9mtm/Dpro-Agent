require('./load.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict');
const {TradingPaperController}=require('../src/trading-paper-controller.ts');
const availability={appId:'trading',version:'1.0.0',mode:'paper',state:'ready',readAccounts:true,executeOrders:false};
const account=id=>({ok:true,accountId:id,mode:'paper',currency:'USD',cash:100,availableCash:100,exposure:0,pendingExposure:0,totalExposure:0,pendingCount:0,appRevision:1,reservationCount:0,appEnabled:true,stopped:false,policies:[],reservations:[]});
function fixture(request,role='owner'){
 let state={epoch:1,phase:'authenticated',user:{id:'owner',role}},calls=[];const listeners=new Set();
 const c=new TradingPaperController({request:async(r,signal)=>{calls.push(r);return request(r,signal);},getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}});
 return {c,calls,signout(){state={epoch:2,phase:'signed-out'};listeners.forEach(fn=>fn());}};
}
test('availability precedes selected account and projection is immutable, read only',async()=>{
 const f=fixture(async r=>({status:200,body:r.path.endsWith('availability')?availability:{...account('paper:one'),token:'private'}}));
 await f.c.select('paper:one');assert.equal(f.c.getSnapshot().phase,'ready');assert.equal(f.calls[1].path,'/api/trading-paper/accounts/paper%3Aone');assert.ok(f.calls.every(r=>r.method==='GET'&&r.body===undefined));assert.equal(JSON.stringify(f.c.getSnapshot()).includes('private'),false);assert.ok(Object.isFrozen(f.c.getSnapshot().account.policies));f.c.close();
});
test('demo, malformed, denied and non-owner reads never fetch account details',async()=>{
 for(const body of [{...availability,state:'demo_only',readAccounts:false},{...availability,executeOrders:true}]){const f=fixture(async()=>({status:200,body}));await f.c.select('one');assert.equal(f.c.getSnapshot().phase,'unavailable');assert.equal(f.calls.length,1);}
 const denied=fixture(async()=>({status:403,body:{secret:'private'}}));await denied.c.select('one');assert.equal(denied.calls.length,1);assert.equal(denied.c.getSnapshot().account,null);
 const member=fixture(async()=>{throw Error('unexpected');},'user');await member.c.select('one');assert.equal(member.calls.length,0);assert.equal(member.c.getSnapshot().phase,'closed');
});
test('new selection supersedes delayed response and signout clears data permanently',async()=>{
 let release;const wait=new Promise(r=>release=r);let n=0;
 const f=fixture(async r=>{if(r.path.endsWith('availability')){if(++n===1)await wait;return {status:200,body:availability};}return {status:200,body:account('two')};});
 const first=f.c.select('one');await f.c.select('two');release();await first;assert.equal(f.c.getSnapshot().accountId,'two');assert.equal(f.calls.filter(r=>r.path.endsWith('/one')).length,0);
 f.signout();assert.equal(f.c.getSnapshot().account,null);assert.equal(f.c.getSnapshot().phase,'closed');await f.c.select('two');assert.equal(f.c.getSnapshot().phase,'closed');
});
test('signout during detail and malformed account cannot publish cached balances',async()=>{
 let release,started;const wait=new Promise(r=>release=r),ready=new Promise(r=>started=r);
 const f=fixture(async r=>{if(r.path.endsWith('availability'))return {status:200,body:availability};started();await wait;return {status:200,body:account('one')};});
 const pending=f.c.select('one');await ready;f.signout();release();await pending;assert.equal(f.c.getSnapshot().phase,'closed');assert.equal(f.c.getSnapshot().account,null);
 const bad=fixture(async r=>({status:200,body:r.path.endsWith('availability')?availability:account('other')}));await bad.c.select('one');assert.equal(bad.c.getSnapshot().phase,'unavailable');assert.equal(bad.c.getSnapshot().account,null);
});
test('invalid identifiers never reach transport; disabled installation permits history only',async()=>{
 const invalid=fixture(async()=>{throw Error('unexpected');});for(const id of ['../one','\ud800','',null])await invalid.c.select(id);assert.equal(invalid.calls.length,0);assert.equal(invalid.c.getSnapshot().phase,'unavailable');
 const f=fixture(async r=>({status:200,body:r.path.endsWith('availability')?{...availability,state:'disabled'}:account('one')}));await f.c.select('one');assert.equal(f.c.getSnapshot().phase,'ready');assert.equal(f.c.getSnapshot().availability.executeOrders,false);assert.equal(f.c.getSnapshot().availability.state,'disabled');
});
test('discovery exposes immutable descriptors without auto-selection and rejects absent selection',async()=>{
 const f=fixture(async r=>({status:200,body:r.path.endsWith('availability')?availability:r.path==='/api/trading-paper/accounts'?{mode:'paper',accounts:[{accountId:'one',currency:'USD',appEnabled:true,stopped:false}],hasMore:false}:account('one')}));
 await f.c.load();assert.equal(f.c.getSnapshot().phase,'ready');assert.equal(f.c.getSnapshot().account,null);assert.equal(f.c.getSnapshot().accountId,null);assert.ok(Object.isFrozen(f.c.getSnapshot().accounts[0]));const before=f.calls.length;await f.c.select('other');assert.equal(f.calls.length,before);await f.c.select('one');assert.equal(f.c.getSnapshot().accountId,'one');f.signout();assert.equal(f.c.getSnapshot().accounts,null);
});
test('discovery distinguishes empty and truncated lists and refuses unprovisioned reads',async()=>{
 for(const size of [0,100]){const f=fixture(async r=>({status:200,body:r.path.endsWith('availability')?availability:{mode:'paper',accounts:Array.from({length:size},(_,i)=>({accountId:'a'+i,currency:'USD',appEnabled:true,stopped:false})),hasMore:size===100}}));await f.c.load();assert.equal(f.c.getSnapshot().accounts.length,size);assert.equal(f.c.getSnapshot().hasMore,size===100);assert.equal(f.c.getSnapshot().accountId,null);}
 const f=fixture(async()=>({status:200,body:{...availability,state:'not_provisioned',readAccounts:false}}));await f.c.load();assert.equal(f.calls.length,1);assert.equal(f.c.getSnapshot().phase,'unavailable');assert.equal(f.c.getSnapshot().accounts,null);
});
test('delayed discovery cannot overwrite a newer load or expose accounts after logout',async()=>{
 let release,started;const wait=new Promise(r=>release=r),ready=new Promise(r=>started=r);let count=0;
 const f=fixture(async r=>{if(r.path.endsWith('availability'))return {status:200,body:availability};const first=++count===1;if(first){started();await wait;}return {status:200,body:{mode:'paper',accounts:first?[{accountId:'stale',currency:'USD',appEnabled:true,stopped:false}]:[],hasMore:false}};});const old=f.c.load();await ready;await f.c.load();release();await old;assert.equal(f.c.getSnapshot().phase,'ready');assert.deepEqual(f.c.getSnapshot().accounts,[]);f.signout();assert.equal(f.c.getSnapshot().accounts,null);await f.c.load();assert.equal(f.c.getSnapshot().phase,'closed');
});

test('logout during discovery rejects late private account list',async()=>{
 let release,started;const wait=new Promise(r=>release=r),ready=new Promise(r=>started=r);
 const f=fixture(async r=>{if(r.path.endsWith('availability'))return {status:200,body:availability};started();await wait;return {status:200,body:{mode:'paper',accounts:[{accountId:'private',currency:'USD',appEnabled:true,stopped:false}],hasMore:false}};});const pending=f.c.load();await ready;f.signout();release();await pending;assert.equal(f.c.getSnapshot().phase,'closed');assert.equal(f.c.getSnapshot().accounts,null);
});
test('mixed sell history is deeply frozen and erased on session end',async()=>{const account=require('./fixtures/trading-paper-mixed.cjs')();const f=fixture(async r=>({status:200,body:r.path.endsWith('availability')?availability:account}));await f.c.select('account');const a=f.c.getSnapshot().account;assert.equal(a.execution.version,2);for(const v of [a.sellHistory,a.sellHistory.reservations,a.sellHistory.reservations[0],a.execution.fills[1]])assert.ok(Object.isFrozen(v));f.signout();assert.equal(f.c.getSnapshot().account,null);});
