require('./load.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict');
const {ApprovalVerificationController}=require('../src/approval-verification-controller.ts');
const id='12345678-1234-1234-1234-123456789012',paramsHash='a'.repeat(64),challenge='b'.repeat(43),receipt='c'.repeat(43);
function fixture(t,handler){const calls=[];const controller=new ApprovalVerificationController({request:async(request,signal)=>{calls.push(request);return handler(request,signal);}},id,paramsHash);t.after(()=>controller.cancel());return {controller,calls};}
const success=request=>({status:200,body:request.path.endsWith('/complete')?{receipt,expiresAt:Date.now()+120000}:{challenge,expiresAt:Date.now()+300000}});
test('verification issues no execution and receipt leaves private memory once after explicit decision',async t=>{
 const {controller,calls}=fixture(t,success);
 await controller.verify('012345');assert.equal(calls.length,0);assert.equal(controller.takeReceipt(),undefined);
 await controller.start();assert.equal(controller.getSnapshot().phase,'code');
 await controller.verify('012345');assert.equal(controller.getSnapshot().phase,'verified');assert.equal(calls.length,2);
 assert.doesNotMatch(JSON.stringify(controller.getSnapshot()),new RegExp(challenge+'|'+receipt+'|012345'));
 assert.deepEqual(calls[0].body,{paramsHash});assert.deepEqual(calls[1].body,{paramsHash,challenge,code:'012345'});
 assert.ok(calls.every(r=>!r.path.endsWith('/approve')));
 assert.equal(controller.takeReceipt(),receipt);assert.equal(controller.takeReceipt(),undefined);assert.equal(controller.getSnapshot().phase,'spent');
});
test('refused code allows explicit retry only, malformed code and simultaneous submit do not send',async t=>{
 let finish;
 const {controller,calls}=fixture(t,r=>r.path.endsWith('/complete')?new Promise(resolve=>{finish=resolve;}):success(r));
 await controller.start();await controller.verify('123');assert.equal(calls.length,1);
 const pending=controller.verify('012345');await controller.verify('012345');assert.equal(calls.length,2);
 finish({status:403,body:{code:'verification_refused'}});await pending;
 assert.equal(controller.getSnapshot().notice,'refused');assert.equal(controller.getSnapshot().phase,'code');assert.equal(controller.takeReceipt(),undefined);assert.equal(calls.length,2);
});
test('cancel aborts late challenge or receipt and neither can repopulate private proof',async t=>{
 for(const stage of ['challenge','receipt']){
  let finish,signal;
  const {controller}=fixture(t,(r,s)=>{if(stage==='receipt'&&!r.path.endsWith('/complete'))return success(r);signal=s;return new Promise(resolve=>{finish=resolve;});});
  if(stage==='receipt')await controller.start();const pending=stage==='receipt'?controller.verify('012345'):controller.start();controller.cancel();assert.equal(signal.aborted,true);
  finish({status:200,body:stage==='receipt'?{receipt,expiresAt:Date.now()+120000}:{challenge,expiresAt:Date.now()+300000}});await pending;
  assert.equal(controller.getSnapshot().phase,'closed');assert.equal(controller.takeReceipt(),undefined);
 }
});
test('challenge expiry aborts pending verification and late proof is ignored',async t=>{
 let finish,signal;
 const {controller,calls}=fixture(t,(r,s)=>r.path.endsWith('/complete')?(signal=s,new Promise(resolve=>{finish=resolve;})):{status:200,body:{challenge,expiresAt:Date.now()+25}});
 await controller.start();const pending=controller.verify('012345');await new Promise(resolve=>setTimeout(resolve,45));assert.equal(signal.aborted,true);assert.equal(controller.getSnapshot().notice,'expired');
 finish({status:200,body:{receipt,expiresAt:Date.now()+120000}});await pending;assert.equal(controller.takeReceipt(),undefined);assert.equal(calls.length,2);
});
test('receipt expiry removes final decision and cannot execute or retry automatically',async t=>{
 const {controller,calls}=fixture(t,r=>r.path.endsWith('/complete')?{status:200,body:{receipt,expiresAt:Date.now()+20}}:success(r));
 await controller.start();await controller.verify('012345');await new Promise(resolve=>setTimeout(resolve,40));assert.equal(controller.takeReceipt(),undefined);assert.equal(controller.getSnapshot().notice,'expired');assert.equal(calls.length,2);
});
test('unknown, rate limited and malformed responses fail closed without automatic resend',async t=>{
 for(const result of [{status:429,body:{code:'rate_limited'}},{status:409,body:{code:'verification_refused'}},{status:200,body:{receipt,expiresAt:Date.now()+120000,token:'forbidden'}},Error('disconnect')]){
  const {controller,calls}=fixture(t,r=>{if(!r.path.endsWith('/complete'))return success(r);if(result instanceof Error)throw result;return result;});
  await controller.start();await controller.verify('012345');assert.equal(controller.getSnapshot().phase,'unavailable');assert.equal(controller.takeReceipt(),undefined);await controller.verify('012345');assert.equal(calls.length,2);
 }
});
