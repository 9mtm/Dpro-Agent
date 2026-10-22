require('./load.cjs');const {test}=require('node:test'),assert=require('node:assert/strict');
const {allowedReviewer,reviewerResponse}=require('../src/reviewers-contract.js'),{allowedRequest}=require('../src/session.ts'),{allowed}=require('../scripts/application-server.cjs');
const id='12345678-1234-1234-1234-123456789012',approvalId='12345678-1234-1234-1234-123456789013',base='/api/reviewer-policies',selected=base+'/'+id,queue='/api/reviewer-requests/'+id;
const ref={policyId:id,policyRevision:1,approvalId,paramsHash:'a'.repeat(64),requestHash:'b'.repeat(64),policyHash:'c'.repeat(64),decision:'approve'},challenge='d'.repeat(43),receipt='e'.repeat(43),expiresAt=1800000000000;
const policy={name:'Review rule',scope:{agentIds:['agent'],toolNames:['tool']},reviewerIds:['human-a','human-b','human-c'],requiredVotes:2,allowInitiatorVote:false,expiresAt};
const detail=queue+'/'+approvalId+'?'+new URLSearchParams({revision:'1',paramsHash:ref.paramsHash,requestHash:ref.requestHash,policyHash:ref.policyHash});
test('client and bridge allow exact reviewer read/draft/control/vote requests',()=>{
 const requests=[['GET',base],['GET',base+'?cursor='+id],['GET',base+'/eligible-humans?cursor=human-a'],['GET',selected],['GET',selected+'/draft'],['PUT',selected+'/draft',{expectedRevision:0,policy}],['GET','/api/reviewer-requests/policies'],['GET',queue],['GET',detail]];
 for(const action of ['activate','revoke'])for(const [phase,body] of [['preview',{revision:1}],['challenge',{revision:1,paramsHash:ref.paramsHash}],['complete',{revision:1,paramsHash:ref.paramsHash,challenge,code:'012345'}],['apply',{revision:1,paramsHash:ref.paramsHash,receipt}]])requests.push(['POST',selected+'/'+action+'/'+phase,body]);
 requests.push(['POST','/api/reviewer-votes/challenge',ref],['POST','/api/reviewer-votes/complete',{...ref,challenge,code:'012345'}],['POST','/api/reviewer-votes/cast',{...ref,receipt}]);
 for(const [method,path,body] of requests)for(const check of [allowedReviewer,allowedRequest,allowed])assert.equal(check(method,path,body),true,method+' '+path);
});
test('both boundaries reject path tricks, duplicate query, body identity/generation and implicit actions',()=>{
 const requests=[['GET',queue+'?userId=other'],['GET',base+'?cursor='+id+'&cursor='+approvalId],['GET',detail+'&policyHash='+ref.policyHash],['GET',base+'/../reviewer-policies'],['GET','/api/reviewer-policies%2f'+id],['POST',selected+'/activate'],['GET',queue,{}],['POST','/api/reviewer-votes/challenge',{...ref,userId:'other'}],['POST','/api/reviewer-votes/challenge',{...ref,policyVersion:1}],['POST','/api/reviewer-votes/complete',{...ref,challenge,code:123456}],['POST',selected+'/activate/preview',{revision:'1'}],['PUT',selected+'/draft',{expectedRevision:0,policy:{...policy,active:true}}],['PUT',selected+'/draft',{expectedRevision:0,policy:{...policy,scope:{agentIds:['*'],toolNames:['tool']}}}]];
 for(const [method,path,body] of requests)for(const check of [allowedReviewer,allowedRequest,allowed])assert.equal(check(method,path,body),false,method+' '+path);
});
test('proof responses are bounded, idempotent and refuse mixed authentication or opposite proof',()=>{
 for(const path of ['/api/reviewer-votes/challenge',selected+'/activate/challenge',selected+'/revoke/challenge']){
  const expected={challenge,expiresAt};assert.deepEqual(reviewerResponse(path,200,{...expected,privateMetadata:'strip'}),expected);assert.deepEqual(reviewerResponse(path,200,reviewerResponse(path,200,expected)),expected);
  for(const extra of [{token:'bad'},{user:{}},{deviceToken:'bad'},{receipt},{expiresAt:NaN}])assert.throws(()=>reviewerResponse(path,200,{...expected,...extra}));
 }
 for(const path of ['/api/reviewer-votes/complete',selected+'/revoke/complete'])assert.deepEqual(reviewerResponse(path,200,{receipt,expiresAt}),{receipt,expiresAt});
});
test('read projections strip private metadata and preserve exact reviewed references',()=>{
 const responses=[[base,{items:[{id,draftRevision:1,version:1,status:'active',private:'strip'}],nextCursor:null}],[base+'/eligible-humans',{items:[{id:'human-a',name:'Human A',role:'user',email:'private@example.test'}],nextCursor:null}],['/api/reviewer-requests/policies',{policies:[{id,revision:1,name:'Rule',requiredVotes:2,expiresAt,reviewerIds:['private']}]}],[queue,{items:[{reference:{...ref,private:'strip'},agentId:'agent',toolName:'tool',requestedAt:'2026-10-22T10:00:00Z',session:'private'}],nextCursor:null}],[detail,{reference:ref,params:{text:'Review this',password:{masked:true,fingerprint:'01234567'}},maskedFields:['password'],runScope:{memoryDrawers:[]},history:'private'}],[selected+'/draft',{id,revision:1,status:'draft',policy,updatedAt:expiresAt}],[selected,{id,version:1,status:'active',policy,unavailable:false}]];
 for(const [path,body] of responses){const projected=reviewerResponse(path,200,body);assert.deepEqual(reviewerResponse(path,200,projected),projected);assert.ok(!JSON.stringify(projected).includes('private'));}
 assert.throws(()=>reviewerResponse(detail,200,{reference:{...ref,approvalId:id},params:{},maskedFields:[],runScope:null}));
 assert.throws(()=>reviewerResponse(base,200,{items:Array(51).fill({id,draftRevision:1,version:1,status:'active'}),nextCursor:null}));
 assert.throws(()=>reviewerResponse(base+'/eligible-humans',200,{items:[{id:'mock-user',name:'System',role:'owner'}],nextCursor:null}));
});
test('state changes and failures project fixed results without raw errors',()=>{
 assert.deepEqual(reviewerResponse(selected+'/activate/apply',200,{id,version:1,status:'active',audit:'strip'}),{id,version:1,status:'active'});
 assert.throws(()=>reviewerResponse(selected+'/revoke/apply',200,{id,version:1,status:'active'}));
 assert.deepEqual(reviewerResponse('/api/reviewer-votes/cast',200,{recorded:true,decision:'deny',revision:1,idempotent:false,hash:'strip'}),{recorded:true,decision:'deny',revision:1,idempotent:false});
 assert.deepEqual(reviewerResponse('/api/reviewer-votes/cast',403,{code:'verification_refused',error:'private stack'}),{code:'verification_refused'});
 assert.deepEqual(reviewerResponse(queue,503,{code:'raw_unknown',error:'private'}),{code:'review_unavailable'});
});
test('owner inventory labels are bounded, idempotent and preserve unavailable-name truth',()=>{
 for(const name of ['Review customer messages',null]){const expected={items:[{id,name,draftRevision:1,version:1,status:'active'}],nextCursor:null},projected=reviewerResponse(base,200,{items:[{...expected.items[0],policy_json:'private',approved_by:'private'}],nextCursor:null});assert.deepEqual(projected,expected);assert.deepEqual(reviewerResponse(base,200,projected),expected);}
 for(const name of [7,'x'.repeat(101),'bad\nname'])assert.throws(()=>reviewerResponse(base,200,{items:[{id,name,draftRevision:1,version:1,status:'active'}],nextCursor:null}));
});
test('own-vote readback preserves only current human decision state and rejects contradictory metadata',()=>{
 const source={reference:ref,params:{},maskedFields:[],runScope:null};
 for(const ownVote of [null,{decision:'approve',revision:1,status:'current'},{decision:'approve',revision:2,status:'verification_required'},{decision:'deny',revision:1,status:'current'}]){const body={...source,ownVote},projected=reviewerResponse(detail,200,body);assert.deepEqual(projected,body);assert.deepEqual(reviewerResponse(detail,200,projected),body);}
 const clean=reviewerResponse(detail,200,{...source,ownVote:{decision:'approve',revision:1,status:'current',userId:'private',receipt_hash:'private'}});assert.ok(!JSON.stringify(clean).includes('private'));
 for(const ownVote of [{decision:'allow',revision:1,status:'current'},{decision:'approve',revision:NaN,status:'current'},{decision:'deny',revision:1,status:'verification_required'},{decision:'approve',revision:1,status:'future'}])assert.throws(()=>reviewerResponse(detail,200,{...source,ownVote}));
});
