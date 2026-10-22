require('./load.cjs');const {test}=require('node:test'),assert=require('node:assert/strict');
const {allowedApproval,approvalResponse}=require('../src/approvals-contract.js');const {allowedRequest}=require('../src/session.ts');const {allowed}=require('../scripts/application-server.cjs');
const path='/api/approvals/12345678-1234-1234-1234-123456789012',paramsHash='a'.repeat(64),challenge='b'.repeat(43),receipt='c'.repeat(43);
test('client and bridge permit exact approval proof bodies only',()=>{
 for(const [target,body] of [[path+'/verification',{paramsHash}],[path+'/verification/complete',{paramsHash,challenge,code:'012345'}],[path+'/approve',{paramsHash,verificationReceipt:receipt}]]){
  assert.equal(allowedApproval('POST',target,body),true);assert.equal(allowedRequest('POST',target,body),true);assert.equal(allowed('POST',target,body),true);
 }
 for(const [method,target,body] of [['GET',path+'/verification'],['POST',path+'/verification',{paramsHash,userId:'other'}],['POST',path+'/verification/complete',{paramsHash,challenge,code:123456}],['POST',path+'/verification?other=1',{paramsHash}],['POST',path+'/approve',{paramsHash,verificationReceipt:true}],['POST',path+'/approve',{paramsHash,verificationReceipt:receipt,verified:true}]])assert.equal(allowedApproval(method,target,body),false);
});
test('challenge and receipt responses are bounded, idempotent and never authentication',()=>{
 for(const [suffix,body] of [['/verification',{challenge,expiresAt:1800000000000}],['/verification/complete',{receipt,expiresAt:1800000000000}]]){
  const value=approvalResponse(path+suffix,200,{...body,privateMetadata:'strip-me'});assert.deepEqual(value,body);assert.deepEqual(approvalResponse(path+suffix,200,value),body);
  assert.throws(()=>approvalResponse(path+suffix,200,{...body,token:'forbidden'}));assert.throws(()=>approvalResponse(path+suffix,200,{...body,expiresAt:NaN}));
 }
 assert.throws(()=>approvalResponse(path+'/verification',200,{challenge,receipt,expiresAt:1}));
 assert.deepEqual(approvalResponse(path+'/verification/complete',403,{code:'verification_refused',message:'secret'}),{code:'verification_refused'});
 assert.deepEqual(approvalResponse(path+'/verification',429,{code:'rate_limited'}),{code:'rate_limited'});
 assert.deepEqual(approvalResponse(path+'/approve',403,{code:'verification_required'}),{code:'verification_required'});
});

test('quorum refusals remain reviewed pre-execution codes across repeated projections',()=>{
 for(const code of ['reviewer_quorum_required','reviewer_denied','reviewer_policy_unavailable']){const safe=approvalResponse(path+'/approve',403,{code,message:'private detail'});assert.deepEqual(safe,{code});assert.deepEqual(approvalResponse(path+'/approve',403,safe),{code});}
 assert.deepEqual(approvalResponse(path+'/approve',403,{code:'unreviewed',message:'private'}),{code:'forbidden'});
});
