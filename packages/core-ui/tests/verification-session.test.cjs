require('./load.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const {SessionClient}=require('../src/session.ts');const {AuthBoundary}=require('../src/AuthBoundary.tsx');
const user={id:'fiction-owner',email:'fiction@example.invalid',username:'Fiction',role:'owner'};
const challenge=method=>({verificationRequired:true,challenge:'a'.repeat(43),nonce:'b'.repeat(43),expiresAt:Date.now()+300000,verificationMethod:method});
function fixture(handler){
 const calls=[];const wire=async request=>{calls.push(request);return handler(request,calls.length);};
 const client=new SessionClient({live:wire,mock:wire});client.selectMode('mock');
 return {client,calls};
}
test('challenge leaves no authenticated access and snapshots omit proof and password',async()=>{
 const f=fixture(()=>({status:200,body:challenge('totp')}));await f.client.login(user.email,'private-password');
 assert.equal(f.client.getSnapshot().phase,'verifying');assert.equal(f.calls.length,1);
 assert.deepEqual(Object.keys(f.client.getSnapshot().verification).sort(),['expiresAt','method']);
 assert.doesNotMatch(JSON.stringify(f.client.getSnapshot()),/private-password|aaaaaaaa|bbbbbbbb/);
 await assert.rejects(f.client.request({method:'GET',path:'/api/auth/me'}));
 const html=renderToStaticMarkup(React.createElement(AuthBoundary,{client:f.client,initialPage:'account'},'fiction'));
 assert.match(html,/Verify your sign-in/);assert.match(html,/one-time-code/);assert.doesNotMatch(html,/aaaaaaaa|bbbbbbbb|private-password/);
 f.client.cancel();assert.equal(f.client.getSnapshot().phase,'signed-out');await f.client.completeVerification('private-password','012345');assert.equal(f.calls.length,1);
});
test('explicit proof completion alone follows normal login/me and stores only terminal session',async()=>{
 const f=fixture(request=>request.path.endsWith('/me')?{status:200,body:{user}}:request.body.verification?{status:200,body:{user,token:'fiction-session',deviceToken:'d'.repeat(43)}}:{status:200,body:challenge('totp')});
 await f.client.login(user.email,'first-password');await f.client.completeVerification('fresh-password','012345');
 assert.equal(f.client.getSnapshot().phase,'authenticated');assert.equal(f.calls.length,3);
 assert.equal(f.calls[1].body.password,'fresh-password');assert.equal(f.calls[1].body.verification.code,'012345');
 assert.equal(f.calls[2].headers.Authorization,'Bearer fiction-session');
 assert.doesNotMatch(JSON.stringify(f.client.getSnapshot()),/fresh-password|012345|fiction-session/);
});
test('recovery explicitly switches challenge purpose and returns to sign-in without me',async()=>{
 const f=fixture(request=>({status:200,body:request.body.verification?{recovered:true,requiresSignIn:true}:challenge(request.body.recovery?'recovery':'totp')}));
 await f.client.login(user.email,'first-password');await f.client.startRecovery('fresh-password');
 assert.equal(f.client.getSnapshot().verification.method,'recovery');assert.equal(f.calls[1].body.recovery,true);
 const html=renderToStaticMarkup(React.createElement(AuthBoundary,{client:f.client,initialPage:'account'},'fiction'));
 assert.match(html,/signs out every device/);assert.match(html,/Reset authenticator/);
 await f.client.completeVerification('fresh-password','c'.repeat(32));
 assert.equal(f.client.getSnapshot().phase,'signed-out');assert.equal(f.client.getSnapshot().notice,'recovered');assert.equal(f.calls.length,3);
});
test('cancelled completion cannot authenticate after a delayed transport response',async()=>{
 let finish;
 const f=fixture(request=>request.body.verification?new Promise(resolve=>{finish=resolve;}):{status:200,body:challenge('totp')});
 await f.client.login(user.email,'first-password');const pending=f.client.completeVerification('fresh-password','012345');
 f.client.cancel();finish({status:200,body:{user,token:'fiction-session',deviceToken:'d'.repeat(43)}});await pending;
 assert.equal(f.client.getSnapshot().phase,'signed-out');assert.equal(f.calls.length,2);
});
test('mode changes and expired challenges prevent proof submission',async()=>{
 const f=fixture(()=>({status:200,body:{...challenge('totp'),expiresAt:Date.now()-1}}));await f.client.login(user.email,'first-password');assert.equal(f.client.getSnapshot().phase,'signed-out');assert.equal(f.client.getSnapshot().notice,'unavailable');
 const g=fixture(()=>({status:200,body:challenge('totp')}));await g.client.login(user.email,'first-password');g.client.selectMode('live');await g.client.completeVerification('fresh-password','012345');assert.equal(g.calls.length,1);
});
test('expired pending step sends no proof and recovery mode never accepts a terminal JWT',async()=>{
 const f=fixture(()=>({status:200,body:challenge('totp')}));await f.client.login(user.email,'first-password');
 const original=Date.now;
 try{Date.now=()=>f.client.getSnapshot().verification.expiresAt+1;await f.client.completeVerification('fresh-password','012345');}finally{Date.now=original;}
 assert.equal(f.calls.length,1);assert.equal(f.client.getSnapshot().notice,'expired');
 const g=fixture(request=>({status:200,body:request.body.recovery?{user,token:'forbidden-recovery-session',deviceToken:'d'.repeat(43)}:challenge('totp')}));
 await g.client.login(user.email,'first-password');await g.client.startRecovery('fresh-password');
 assert.equal(g.client.getSnapshot().phase,'signed-out');assert.equal(g.client.getSnapshot().notice,'unavailable');assert.equal(g.calls.length,2);
});
