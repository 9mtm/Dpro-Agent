require('./load.cjs');
const {test}=require('node:test');const assert=require('node:assert/strict');
const {validLoginBody,loginContinuation}=require('../src/login-contract.js');
const {allowedRequest,createSameOriginTransport}=require('../src/session.ts');
const {allowed}=require('../scripts/application-server.cjs');
const challenge={verificationRequired:true,challenge:'a'.repeat(43),nonce:'b'.repeat(43),expiresAt:1800000000000,verificationMethod:'totp'};
const body={email:'fixture@example.invalid',password:'fiction-only'};
test('client and bridge accept only exact mode-specific login continuation bodies',()=>{
 const proof={challenge:challenge.challenge,nonce:challenge.nonce,code:'012345'};
 for(const value of [body,{...body,verification:proof},{...body,recovery:true,verification:{...proof,code:'a'.repeat(32)}}]){
  assert.equal(validLoginBody(value),true);assert.equal(allowedRequest('POST','/api/auth/login',value),true);assert.equal(allowed('POST','/api/auth/login',value),true);
 }
 for(const value of [{...body,recovery:'yes'},{...body,verification:{...proof,userId:'other'}},{...body,verification:{...proof,nonce:'bad'}},{...body,recovery:true,verification:proof},{...body,verification:{...proof,code:'a'.repeat(32)}},{...body,token:'session'}])assert.equal(validLoginBody(value),false);
});
test('challenge/recovery projections are idempotent and reject ambiguous authentication',()=>{
 assert.deepEqual(loginContinuation({...challenge,secret:'strip-me'}),challenge);
 assert.deepEqual(loginContinuation(loginContinuation(challenge)),challenge);
 const recovered={recovered:true,requiresSignIn:true};assert.deepEqual(loginContinuation({...recovered,secret:'strip-me'}),recovered);
 assert.equal(loginContinuation({user:{},token:'ordinary'}),undefined);
 for(const value of [{...challenge,token:'forbidden'},{...challenge,user:{}},{...challenge,deviceToken:'d'.repeat(43)},{...challenge,expiresAt:NaN},{...challenge,verificationMethod:'unknown'},{verificationRequired:false},{...recovered,token:'forbidden'},{requiresSignIn:true},{nonce:'b'.repeat(43)}])assert.throws(()=>loginContinuation(value));
});
test('same-origin transport safely projects continuation before requiring an authenticated user',async()=>{
 let value={...challenge,password:'strip-me'};
 const wire=createSameOriginTransport('http://127.0.0.1:42522',async()=>({status:200,headers:new Headers({'content-type':'application/json'}),json:async()=>value}));
 const request={method:'POST',path:'/api/auth/login',body,headers:{},signal:new AbortController().signal};
 assert.deepEqual((await wire(request)).body,challenge);
 value={recovered:true,requiresSignIn:true};assert.deepEqual((await wire(request)).body,value);
 value={...challenge,token:'ambiguous'};await assert.rejects(wire(request));
});
