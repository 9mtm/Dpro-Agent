require('./load.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict');
const {allowedVerification,verificationResponse,VERIFICATION_PATH:P}=require('../src/verification-contract.js');
const {allowedRequest}=require('../src/session.ts');const {allowed}=require('../scripts/application-server.cjs');
test('lifecycle request boundaries are exact and exclude account targets',()=>{
 for(const [method,path,body] of [['GET',P],['POST',P+'/enroll',{password:'fiction'}],['POST',P+'/confirm',{password:'fiction',code:'012345'}],['POST',P+'/disable',{password:'fiction',code:'012345'}]]){
  assert.equal(allowedVerification(method,path,body),true);assert.equal(allowedRequest(method,path,body),true);assert.equal(allowed(method,path,body),true);
 }
 for(const [method,path,body] of [['DELETE',P],['GET',P+'?user=other'],['POST',P+'/enroll',{password:'fiction',userId:'other'}],['POST',P+'/confirm',{password:'fiction',code:123456}],['POST',P+'/disable',{password:'fiction',code:'012345',confirmation:true}],['POST',P+'/enroll',{password:'x'.repeat(1025)}]])assert.equal(allowedVerification(method,path,body),false);
});
test('lifecycle projection is bounded and idempotent for sensitive outputs and proof failures',()=>{
 const recoveryCodes=Array.from({length:8},(_,i)=>i.toString(16).padStart(32,'0'));
 for(const [path,body] of [[P,{enabled:true}],[P+'/enroll',{secret:'A'.repeat(32),expiresAt:1800000000000}],[P+'/confirm',{requiresSignIn:true,recoveryCodes}],[P+'/disable',{requiresSignIn:true}]]){
  const projected=verificationResponse(path,200,{...body,privateValue:'strip-me'});assert.deepEqual(projected,body);assert.deepEqual(verificationResponse(path,200,projected),body);
 }
 assert.deepEqual(verificationResponse(P+'/confirm',403,{code:'verification_refused',message:'private'}),{code:'verification_refused'});
 assert.equal(verificationResponse(P+'/enroll',200,{secret:'lowercase',expiresAt:1}),null);
 assert.equal(verificationResponse(P+'/confirm',200,{requiresSignIn:true,recoveryCodes:Array(8).fill('a'.repeat(32))}),null);
 assert.equal(verificationResponse(P+'/confirm',200,{requiresSignIn:true,recoveryCodes,token:'forbidden'}),null);
});
