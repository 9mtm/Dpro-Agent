require('./load.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict');
const {VerificationController}=require('../src/verification-controller.ts');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const {VerificationSettings}=require('../src/VerificationSettings.tsx');const {SessionClient}=require('../src/session.ts');
const P='/api/auth/verification';
function fixture(t,handler){const calls=[];const controller=new VerificationController({request:async(request,signal)=>{calls.push(request);return handler(request,signal);}});t.after(()=>controller.cancel());return {controller,calls};}
test('setup is read first, uses fresh credentials per operation and clears key on cancel',async t=>{
 const {controller,calls}=fixture(t,request=>({status:200,body:request.method==='GET'?{enabled:false}:request.path.endsWith('/enroll')?{secret:'A'.repeat(32),expiresAt:Date.now()+300000}:{requiresSignIn:true}}));
 await controller.act('enroll','private-password');assert.equal(calls.length,0);
 await controller.load();await controller.act('enroll','first-password');assert.equal(controller.getSnapshot().setup.secret,'A'.repeat(32));assert.doesNotMatch(JSON.stringify(controller.getSnapshot()),/first-password/);
 await controller.act('confirm','fresh-password','012345');assert.deepEqual(calls[2].body,{password:'fresh-password',code:'012345'});assert.equal(controller.getSnapshot().setup,undefined);
 controller.cancel();assert.equal(controller.getSnapshot().setup,undefined);
});
test('bad proof preserves setup for deliberate retry; unknown outcome clears secret and requires status read',async t=>{
 let mode='setup';
 const {controller,calls}=fixture(t,request=>request.method==='GET'?{status:200,body:{enabled:false}}:request.path.endsWith('/enroll')?{status:200,body:{secret:'A'.repeat(32),expiresAt:Date.now()+300000}}:mode==='setup'?{status:403,body:{code:'verification_refused'}}:Promise.reject(Error('fixture disconnect')));
 await controller.load();await controller.act('enroll','private-password');await controller.act('confirm','private-password','012345');assert.equal(controller.getSnapshot().notice,'refused');assert.ok(controller.getSnapshot().setup);
 mode='unknown';await controller.act('confirm','private-password','012345');assert.equal(controller.getSnapshot().phase,'unavailable');assert.equal(controller.getSnapshot().setup,undefined);
 const before=calls.length;await controller.act('confirm','private-password','012345');assert.equal(calls.length,before);
});
test('cancelled late setup and expiry cannot repopulate a hidden key',async t=>{
 let finish;
 const f=fixture(t,request=>request.method==='GET'?{status:200,body:{enabled:false}}:new Promise(resolve=>{finish=resolve;}));
 await f.controller.load();const pending=f.controller.act('enroll','private-password');f.controller.cancel();finish({status:200,body:{secret:'A'.repeat(32),expiresAt:Date.now()+300000}});await pending;assert.equal(f.controller.getSnapshot().setup,undefined);
 const g=fixture(t,request=>({status:200,body:request.method==='GET'?{enabled:false}:{secret:'B'.repeat(32),expiresAt:Date.now()+20}}));await g.controller.load();await g.controller.act('enroll','private-password');await new Promise(resolve=>setTimeout(resolve,35));assert.equal(g.controller.getSnapshot().setup,undefined);assert.equal(g.controller.getSnapshot().notice,'expired');
});
test('active factor exposes disable only and settings entry makes no request before open',async t=>{
 const {controller,calls}=fixture(t,request=>({status:200,body:request.method==='GET'?{enabled:true}:{requiresSignIn:true}}));await controller.load();await controller.act('enroll','private-password');assert.equal(calls.length,1);await controller.act('disable','fresh-password','012345');assert.equal(calls[1].path,P+'/disable');
 const client=new SessionClient();const html=renderToStaticMarkup(React.createElement(VerificationSettings,{client}));assert.match(html,/Manage verification/);assert.doesNotMatch(html,/<dialog|Setup key/);
});
