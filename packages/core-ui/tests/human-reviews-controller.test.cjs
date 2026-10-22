require('./load.cjs');const {test}=require('node:test'),assert=require('node:assert/strict');
const {HumanReviewsController}=require('../src/human-reviews-controller.ts');
const id='12345678-1234-1234-1234-123456789012',requestId='12345678-1234-1234-1234-123456789013',reference={policyId:id,policyRevision:1,approvalId:requestId,paramsHash:'a'.repeat(64),requestHash:'b'.repeat(64),policyHash:'c'.repeat(64),decision:'approve'};
const policy={id,revision:1,name:'Rule',requiredVotes:2,expiresAt:1800000000000},item={reference,toolName:'fixture_tool',agentId:'agent',requestedAt:'2026-10-22T10:00:00Z'};
const success=request=>({status:200,body:request.path==='/api/reviewer-requests/policies'?{policies:[policy]}:request.path==='/api/reviewer-requests/'+id?{items:[item],nextCursor:null}:request.path.includes('?revision=')?{reference,params:{text:'Review me'},maskedFields:[],runScope:null}:{recorded:true,decision:request.body.decision,revision:1,idempotent:false}});
function fixture(t,handler=success){const calls=[],controller=new HumanReviewsController({request:async(r,s)=>{calls.push(r);return handler(r,s);}});t.after(()=>controller.cancel());return {controller,calls};}
async function open(controller){await controller.load();await controller.choosePolicy(id);await controller.open(controller.getSnapshot().items[0]);}
test('read selected exact request never proves or records; explicit record is only mutation and returns safe success',async t=>{
 const {controller,calls}=fixture(t);await open(controller);assert.ok(calls.every(r=>r.method==='GET'));assert.equal(controller.getSnapshot().detail.params.text,'Review me');assert.ok(Object.isFrozen(controller.getSnapshot().detail.reference));
 await controller.record({...reference,decision:'deny'},'d'.repeat(43));assert.equal(calls.length,4);assert.equal(calls[3].path,'/api/reviewer-votes/cast');assert.equal(calls[3].body.decision,'deny');assert.equal(controller.getSnapshot().notice,'recorded');assert.equal(controller.getSnapshot().items.length,0);assert.ok(!JSON.stringify(controller.getSnapshot()).includes('d'.repeat(43)));
});
test('changed/malformed references and missing proof cannot send a vote',async t=>{
 const {controller,calls}=fixture(t);await open(controller);const count=calls.length;
 await controller.record({...reference,paramsHash:'f'.repeat(64)},'d'.repeat(43));await controller.record(reference,'bad');await controller.record({...reference,userId:'other'},'d'.repeat(43));assert.equal(calls.length,count);assert.equal(controller.getSnapshot().phase,'ready');
});
test('duplicate record and navigation during submission cannot send a second mutation',async t=>{
 let finish;const {controller,calls}=fixture(t,r=>r.method==='POST'?new Promise(resolve=>{finish=resolve;}):success(r));await open(controller);const pending=controller.record(reference,'d'.repeat(43));await controller.record(reference,'d'.repeat(43));await controller.load();await controller.choosePolicy(id);assert.equal(calls.filter(r=>r.method==='POST').length,1);
 finish({status:200,body:{recorded:true,decision:'approve',revision:1,idempotent:false}});await pending;assert.equal(controller.getSnapshot().notice,'recorded');
});
test('cancelled delayed detail cannot repopulate or expose its parameters',async t=>{
 let finish,signal;const {controller}=fixture(t,(r,s)=>r.path.includes('?revision=')?(signal=s,new Promise(resolve=>{finish=resolve;})):success(r));await controller.load();await controller.choosePolicy(id);const pending=controller.open(controller.getSnapshot().items[0]);controller.cancel();assert.equal(signal.aborted,true);finish({status:200,body:{reference,params:{text:'late secret content'},maskedFields:[],runScope:null}});await pending;assert.equal(controller.getSnapshot().phase,'idle');assert.equal(controller.getSnapshot().detail,undefined);
});
test('unknown outcome locks current request and never automatically retries; known conflict remains distinct',async t=>{
 for(const response of [{status:503,body:{code:'review_unavailable'}},{status:409,body:{code:'review_conflict'}},{status:403,body:{code:'verification_refused'}}]){const {controller,calls}=fixture(t,r=>r.method==='POST'?response:success(r));await open(controller);await controller.record(reference,'d'.repeat(43));assert.equal(controller.getSnapshot().locked,true);assert.equal(controller.getSnapshot().notice,response.status===409?'conflict':response.status===403?'refused':'unknown');await controller.record(reference,'d'.repeat(43));assert.equal(calls.filter(r=>r.method==='POST').length,1);}
 const {controller,calls}=fixture(t,r=>r.method==='POST'?Promise.reject(Error('lost transport')):success(r));await open(controller);await controller.record(reference,'d'.repeat(43));assert.equal(controller.getSnapshot().notice,'unknown');assert.equal(calls.filter(r=>r.method==='POST').length,1);
});
test('durable readback locks recorded choice; stale approval permits only explicit same-choice renewal',async t=>{
 for(const status of ['current','verification_required']){const {controller,calls}=fixture(t,r=>{const response=success(r);if(r.path.includes('?revision='))response.body.ownVote={decision:'approve',revision:1,status};return response;});await open(controller);const count=calls.length;await controller.record({...reference,decision:'deny'},'d'.repeat(43));assert.equal(calls.length,count);await controller.record(reference,'d'.repeat(43));assert.equal(calls.length,status==='current'?count:count+1);}
});
test('missing account verification has a distinct recovery state without automatic retry',async t=>{const {controller,calls}=fixture(t,()=>({status:403,body:{code:'human_verification_required'}}));await controller.load();assert.equal(controller.getSnapshot().notice,'verification');assert.equal(calls.length,1);});
