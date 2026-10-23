import test from 'node:test';
import assert from 'node:assert/strict';
import {capturePaperDispatchDefinition as capture} from '../src/services/trading-paper-dispatch-contract.ts';
const now=1800000000000;
const fresh=()=>({version:1,mode:'paper',ownerId:'owner',botId:'bot',accountId:'account',policyId:'policy',policyRevision:1,appRevision:1,installationId:'install',installationRevision:1,manifestDigest:'a'.repeat(64),policyHash:'b'.repeat(64),profileHash:'c'.repeat(64),quoteSource:'stored-paper-quote',strategy:{kind:'fixed-paper-order',version:1,symbol:'BTC:USD',side:'buy',amount:1010},limits:{expiresAt:now+60000,maxAttempts:10,cadenceMs:1000}});
test('immutable detached capture with canonical key ordering',()=>{
 const input=fresh(),a=capture(input,now);assert.ok(a);assert.equal(capture(Object.fromEntries(Object.entries(fresh()).reverse()),now).digest,a.digest);
 input.strategy.amount=999;input.limits.maxAttempts=100;input.ownerId='other';assert.equal(a.definition.strategy.amount,1010);assert.equal(a.definition.limits.maxAttempts,10);assert.equal(a.definition.ownerId,'owner');
 for(const value of [a,a.definition,a.definition.strategy,a.definition.limits])assert.equal(Object.isFrozen(value),true);
 assert.throws(()=>{a.definition.strategy.side='sell';},TypeError);
});
test('every target, strategy and attempt budget field is hash bound',()=>{
 const first=capture(fresh(),now).digest;
 for(const [key,value] of Object.entries({ownerId:'other',botId:'other',accountId:'other',policyId:'other',policyRevision:2,appRevision:2,installationId:'other',installationRevision:2,manifestDigest:'d'.repeat(64),policyHash:'d'.repeat(64),profileHash:'d'.repeat(64)}))assert.notEqual(capture({...fresh(),[key]:value},now).digest,first,key);
 for(const [group,changes] of [['strategy',[{symbol:'ETH:USD'},{side:'sell'},{amount:1011}]],['limits',[{expiresAt:now+60001},{maxAttempts:11},{cadenceMs:1001}]]])for(const change of changes){const input=fresh();Object.assign(input[group],change);assert.notEqual(capture(input,now).digest,first);}
});
test('live, provider, code and unbounded or malformed attempt definitions refuse',()=>{
 for(const patch of [{mode:'live'},{version:2},{quoteSource:'public-api'},{provider:'claude'},{runtime:()=>{}},{timer:true},{ownerId:'bad id'},{ownerId:'owner\n'},{ownerId:'owner\r'},{manifestDigest:'a'.repeat(64)+'\n'},{policyHash:'b'.repeat(64)+'\r'},{manifestDigest:'A'.repeat(64)},{installationRevision:0}])assert.equal(capture({...fresh(),...patch},now),null);
 for(const patch of [{kind:'model'},{version:2},{amount:0},{amount:1.5},{amount:NaN},{amount:'1010'},{amount:1e12+1},{side:'short'},{symbol:' AAA'},{symbol:'a'.repeat(129)},{symbol:'BTC/USD'},{symbol:'AAA\n'},{symbol:'AAA\r'},{code:'return buy'}]){const input=fresh();Object.assign(input.strategy,patch);assert.equal(capture(input,now),null);}
 for(const patch of [{expiresAt:now},{expiresAt:now+2592000001},{maxAttempts:0},{maxAttempts:1001},{maxAttempts:1.5},{cadenceMs:999},{cadenceMs:86400001},{retryForever:true}]){const input=fresh();Object.assign(input.limits,patch);assert.equal(capture(input,now),null);}
 for(const clock of [0,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER])assert.equal(capture(fresh(),clock),null);
});
test('getters, inherited fields, hidden symbols and throwing proxies fail closed',()=>{
 let reads=0;for(const path of ['root','strategy','limits']){const input=fresh(),target=path==='root'?input:input[path],key=path==='root'?'ownerId':path==='strategy'?'amount':'maxAttempts';Object.defineProperty(target,key,{get(){reads++;throw Error('must not execute');},enumerable:true});assert.equal(capture(input,now),null);}assert.equal(reads,0);
 assert.equal(capture(Object.create(fresh()),now),null);const input=fresh();input.strategy[Symbol('hidden')]=true;assert.equal(capture(input,now),null);assert.equal(capture(new Proxy({}, {ownKeys(){throw Error('trap');}}),now),null);
});
