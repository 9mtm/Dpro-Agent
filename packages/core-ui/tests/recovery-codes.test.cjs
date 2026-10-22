require('./load.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const {SessionClient}=require('../src/session.ts'),{AuthBoundary}=require('../src/AuthBoundary.tsx');
const P='/api/auth/verification';
const user={id:'fixture',email:'fixture@example.invalid',username:'Fiction',role:'user'};
const codes=Array.from({length:8},(_,i)=>i.toString(16).padStart(32,'0'));
async function fixture(){
 const calls=[];const wire=async request=>{calls.push(request);return {status:200,body:request.path.endsWith('/login')?{user,token:'fiction-session',deviceToken:'d'.repeat(43)}:request.path.endsWith('/confirm')?{requiresSignIn:true,recoveryCodes:codes}:{user}};};
 const client=new SessionClient({mock:wire});client.selectMode('mock');await client.login(user.email,'fiction-password');return {client,calls};
}
test('activation immediately clears private access and confines codes to blocking memory-only acknowledgment',async()=>{
 const {client,calls}=await fixture();
 const result=await client.request({method:'POST',path:P+'/confirm',body:{password:'fiction-password',code:'012345'}});
 assert.deepEqual(result.body,{requiresSignIn:true});assert.equal(client.getSnapshot().phase,'recovery-codes');
 assert.doesNotMatch(JSON.stringify(client.getSnapshot()),/00000000|fiction-session|fiction-password/);
 assert.deepEqual(client.recoveryCodes(),codes);assert.ok(Object.isFrozen(client.recoveryCodes()));
 const count=calls.length;await assert.rejects(client.request({method:'GET',path:'/api/auth/me'}));await client.login(user.email,'fiction-password');assert.equal(calls.length,count);
 const html=renderToStaticMarkup(React.createElement(AuthBoundary,{client,initialPage:'home'},'fiction'));
 assert.match(html,/Save your recovery codes/);assert.match(html,/inert=""/);assert.match(html,/I have saved these codes/);assert.match(html,/disabled=""[^>]*>Continue to sign in/);
 assert.doesNotMatch(html,/Back to welcome/);
 client.finishRecoveryCodes();assert.equal(client.getSnapshot().phase,'signed-out');assert.equal(client.getSnapshot().setup,'login');assert.deepEqual(client.recoveryCodes(),[]);
});
test('cancel wipes codes, and late lifecycle replies cannot repopulate a cancelled epoch',async()=>{
 const f=await fixture();await f.client.request({method:'POST',path:P+'/confirm',body:{password:'fiction-password',code:'012345'}});f.client.cancel();assert.deepEqual(f.client.recoveryCodes(),[]);
 let finish;
 const wire=async request=>request.path.endsWith('/confirm')?new Promise(resolve=>{finish=resolve;}):{status:200,body:request.path.endsWith('/login')?{user,token:'fiction-session',deviceToken:'d'.repeat(43)}:{user}};
 const client=new SessionClient({mock:wire});client.selectMode('mock');await client.login(user.email,'fiction-password');
 const pending=client.request({method:'POST',path:P+'/confirm',body:{password:'fiction-password',code:'012345'}});client.cancel();finish({status:200,body:{requiresSignIn:true,recoveryCodes:codes}});
 await assert.rejects(pending);assert.equal(client.getSnapshot().phase,'signed-out');assert.deepEqual(client.recoveryCodes(),[]);
});
test('acknowledgment returns directly to sign-in rather than the public welcome page',async()=>{
 const {client}=await fixture();await client.request({method:'POST',path:P+'/confirm',body:{password:'fiction-password',code:'012345'}});client.finishRecoveryCodes();
 const html=renderToStaticMarkup(React.createElement(AuthBoundary,{client,initialPage:'home'},'fiction'));
 assert.match(html,/auth-password/);assert.doesNotMatch(html,/Save your recovery codes|Welcome to Dpro Agent/);
});
