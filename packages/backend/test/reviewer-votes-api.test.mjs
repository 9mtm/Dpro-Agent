// Actual signed HTTP reviewer requests over protected policy and authenticator fixtures.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes,randomUUID,createHash} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'ap-human-vote-http-'));process.chdir(dir);process.env.DATABASE_PATH=join(dir,'test.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
const {beginEnrollment,activateEnrollment}=await import('../src/auth/verification/enrollment.ts');const {hotp,decodeSecret}=await import('../src/auth/verification/totp.ts');
const {saveReviewerDraft}=await import('../src/auth/verification/reviewer-policy.ts');const {reviewerDraftProofTarget,issueReviewerDraftChallenge,completeReviewerDraftChallenge}=await import('../src/auth/verification/reviewer-policy-proof.ts');const {activateReviewerPolicy}=await import('../src/auth/verification/reviewer-policy-state.ts');
const {reviewerVoteTarget,issueReviewerVoteChallenge,completeReviewerVoteChallenge,castReviewerVote}=await import('../src/auth/verification/reviewer-votes.ts');const {issueApprovalProofChallenge,completeApprovalProofChallenge}=await import('../src/auth/verification/approval-proof.ts');
const {generateToken}=await import('../src/auth/jwt.ts');
const {default:Fastify}=await import('fastify');const {registerAuthGate}=await import('../src/auth/auth-gate.ts');const {reviewerVoteRoutes}=await import('../src/api/routes/reviewer-votes.ts');const {approvalsRoutes}=await import('../src/api/routes/approvals.ts');
const {reviewerRequestRoutes}=await import('../src/api/routes/reviewer-requests.ts');
const {reviewerPolicyRoutes}=await import('../src/api/routes/reviewer-policies.ts');
const app=Fastify();registerAuthGate(app);await app.register(reviewerPolicyRoutes);await app.register(reviewerRequestRoutes);await app.register(reviewerVoteRoutes);await app.register(approvalsRoutes);await app.ready();
const tools=await import('../src/tools/index.ts'),grants=await import('../src/tools/grants.ts'),approvals=await import('../src/tools/approvals.ts');
let executions=0,serial=0;const tool={name:'fixture_verified_vote',description:'Harmless verified-vote fixture',extensionId:'fixture-votes',requiresApproval:true,input_schema:{type:'object',properties:{text:{type:'string'}}},async execute(){executions++;return {content:[{type:'text',text:'Verified human quorum completed once'}]};}};tools.registerExtensionTool(tool);db.prepare("INSERT INTO agents_config(id,name,provider,model) VALUES('vote-agent','Vote fixture','claude','fixture')").run();const available=tools.createToolsRegistry({workspaceDir:dir}).listRegistered();
test.after(async()=>{await app.close();tools.unregisterExtensionTool(tool.name);closeDatabase();});test.beforeEach(()=>{db.prepare("UPDATE human_reviewer_policies SET status='revoked'").run();db.prepare("UPDATE tool_approvals SET status='denied' WHERE status='pending'").run();});
const sha=v=>createHash('sha256').update(v).digest('hex');const otp=(person,time=Date.now())=>hotp(decodeSecret(person.secret),BigInt(Math.floor(time/30000)));
const refOf=operation=>{const {kind,policyVersion,...ref}=operation;return ref;};
async function fixture(initiator='owner',parameters={text:'Local verified-vote fixture'}){
 const prefix='v'+(++serial),people={};
 for(const [name,role] of [['owner','owner'],['a','user'],['b','admin'],['c','user'],['outsider','admin']]){const id=prefix+'-'+name;db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'x',?,'active',1)").run(id,id+'@example.test',id,role);const initial=Date.now()-60000,b={userId:id,sessionHash:sha(id+'setup'),tokenVersion:1},setup=await beginEnrollment(b,initial);await activateEnrollment(b,hotp(decodeSecret(setup.secret),BigInt(Math.floor(initial/30000))),initial);const token=generateToken(id,2);people[name]={id,token,secret:setup.secret,actor:{kind:'user',role,userId:id},context:{userId:id,sessionHash:sha(token),tokenVersion:2,factorVersion:1}};}
 const owner=people.owner,time=Date.now(),policyId=randomUUID(),policyInput={name:'Verified review rule',scope:{agentIds:['vote-agent'],toolNames:[tool.name]},reviewerIds:[people.a.id,people.b.id,people.c.id],requiredVotes:2,allowInitiatorVote:false,expiresAt:time+3600000};
 await saveReviewerDraft({actor:owner.actor,tokenVersion:2},policyId,0,policyInput,time);const target=await reviewerDraftProofTarget(owner.context,owner.actor,policyId,1,time),issued=await issueReviewerDraftChallenge(owner.context,owner.actor,policyId,1,target.paramsHash,time),proof=await completeReviewerDraftChallenge(issued.token,owner.context,owner.actor,policyId,1,target.paramsHash,otp(owner,time),time);assert.ok(proof);const policy=await activateReviewerPolicy(proof.receipt,owner.context,owner.actor,policyId,1,target.paramsHash,time);
 await grants.setAgentGrants('vote-agent',{grants:[tool.name]},owner.id,available);const request=await approvals.requestApproval(tool,parameters,{userId:people[initiator].id,agentId:'vote-agent',sessionId:'vote-session',workspaceDir:dir},'other'),id=request.details.approvalId,detail=await approvals.getApprovalDetail(id);
 return {people,policy,policyInput,request:{id,hash:detail.paramsHash}};
}
async function voteProof(f,name,decision='approve',codeTime=Date.now()){
 const person=f.people[name],operation=await reviewerVoteTarget(person.context,person.actor,f.policy.id,f.policy.version,f.request.id,f.request.hash,decision),ref=refOf(operation),issued=await issueReviewerVoteChallenge(person.context,person.actor,ref),proof=await completeReviewerVoteChallenge(issued.token,person.context,person.actor,ref,otp(person,codeTime));assert.ok(proof);return {person,ref,receipt:proof.receipt};
}
const cast=proof=>castReviewerVote(proof.receipt,proof.person.context,proof.person.actor,proof.ref);
async function ownerProof(f){const p=f.people.owner,issued=await issueApprovalProofChallenge(p.context,f.request.id,f.request.hash),proof=await completeApprovalProofChallenge(issued.token,p.context,f.request.id,f.request.hash,otp(p,Date.now()+30000));assert.ok(proof);return {receipt:proof.receipt,context:p.context};}
const send=(action,person,payload)=>app.inject({method:'POST',url:'/api/reviewer-votes/'+action,headers:person?{authorization:'Bearer '+person.token}:{},payload});
async function reference(f,name='a',decision='approve'){const p=f.people[name];return refOf(await reviewerVoteTarget(p.context,p.actor,f.policy.id,1,f.request.id,f.request.hash,decision));}
async function httpProof(f,name='a',decision='approve'){
 const p=f.people[name],ref=await reference(f,name,decision),issued=await send('challenge',p,ref);assert.equal(issued.statusCode,200,issued.body);assert.deepEqual(Object.keys(issued.json()).sort(),['challenge','expiresAt']);
 const completed=await send('complete',p,{...ref,challenge:issued.json().challenge,code:otp(p)});assert.equal(completed.statusCode,200,completed.body);assert.deepEqual(Object.keys(completed.json()).sort(),['expiresAt','receipt']);assert.equal(completed.headers['cache-control'],'no-store');return {p,ref,receipt:completed.json().receipt};
}
test('actual user/admin HTTP votes do not execute; two votes plus explicit owner proof execute once',async()=>{
 const f=await fixture(),before=executions;
 for(const name of ['a','b']){const v=await httpProof(f,name),result=await send('cast',v.p,{...v.ref,receipt:v.receipt});assert.equal(result.statusCode,200,result.body);assert.deepEqual(result.json(),{recorded:true,decision:'approve',revision:1,idempotent:false});assert.equal(executions,before);assert.equal((await approvals.getApproval(f.request.id)).status,'pending');}
 const p=f.people.owner,proof=await ownerProof(f),run=await app.inject({method:'POST',url:'/api/approvals/'+f.request.id+'/approve',headers:{authorization:'Bearer '+p.token},payload:{paramsHash:f.request.hash,verificationReceipt:proof.receipt}});assert.equal(run.statusCode,200,run.body);assert.equal(executions,before+1);
});
test('reviewer HTTP access grants no owner approval list, detail, execute or deny capability',async()=>{
 const f=await fixture();for(const p of [f.people.a,f.people.b])for(const [method,url,payload] of [['GET','/api/approvals'],['GET','/api/approvals/'+f.request.id],['POST','/api/approvals/'+f.request.id+'/approve',{paramsHash:f.request.hash}],['POST','/api/approvals/'+f.request.id+'/deny',{}]]){const result=await app.inject({method,url,headers:{authorization:'Bearer '+p.token},...(payload?{payload}:{})});assert.equal(result.statusCode,403,result.body);}
});
test('unknown/unassigned/initiator policies share a fixed unavailable response',async()=>{
 const f=await fixture('a'),ref=await reference(f,'b'),results=[];
 for(const [person,body] of [[f.people.outsider,ref],[f.people.a,ref],[f.people.b,{...ref,policyId:randomUUID()}],[f.people.b,{...ref,approvalId:randomUUID()}]]){const r=await send('challenge',person,body);assert.equal(r.statusCode,404,r.body);assert.equal(r.headers['cache-control'],'no-store');results.push(r.body);}
 assert.equal(new Set(results).size,1);
});
test('HTTP rejects identity/generation injection, missing fields, query, malformed proof and decision values',async()=>{
 const f=await fixture(),ref=await reference(f),p=f.people.a;
 for(const extra of [{userId:f.people.owner.id},{actor:{kind:'user',role:'owner'}},{policyVersion:1},{verified:true},{receipt:'x'.repeat(43)}])assert.equal((await send('challenge',p,{...ref,...extra})).statusCode,400);
 for(const body of [{...ref,decision:'allow'},{...ref,policyRevision:'1'},{...ref,requestHash:undefined},[],null])assert.equal((await send('challenge',p,body)).statusCode,400);
 assert.equal((await send('challenge?userId=owner',p,ref)).statusCode,400);
 assert.equal((await send('complete',p,{...ref,challenge:'bad',code:'123456'})).statusCode,400);
 assert.equal((await send('cast',p,{...ref,receipt:'bad'})).statusCode,400);
 assert.equal((await send('challenge',undefined,ref)).statusCode,401);
});
test('correct OTP from another signed session fails without casting; original proof retry records once',async()=>{
 const f=await fixture(),p=f.people.a,ref=await reference(f),issued=await send('challenge',p,ref),other={...p,token:generateToken(p.id,2)};
 const wrong=await send('complete',other,{...ref,challenge:issued.json().challenge,code:otp(p)});assert.equal(wrong.statusCode,403,wrong.body);
 const complete=await send('complete',p,{...ref,challenge:issued.json().challenge,code:otp(p)});assert.equal(complete.statusCode,200,complete.body);const payload={...ref,receipt:complete.json().receipt};
 assert.equal((await send('cast',other,payload)).statusCode,403);const results=await Promise.all(Array.from({length:4},()=>send('cast',p,payload)));assert.ok(results.every(r=>r.statusCode===200));assert.equal(results.filter(r=>!r.json().idempotent).length,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_reviewer_votes WHERE approval_id=?').get(f.request.id).n,1);
});
test('HTTP rechecks account/factor and assignment revocation before a proved vote is cast',async()=>{
 const f=await fixture(),v=await httpProof(f);db.prepare('UPDATE users SET token_version=3 WHERE id=?').run(v.p.id);assert.equal((await send('cast',v.p,{...v.ref,receipt:v.receipt})).statusCode,401);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_reviewer_votes WHERE approval_id=?').get(f.request.id).n,0);
 const w=await httpProof(f,'b');db.prepare('UPDATE verification_factors SET enabled=0 WHERE user_id=?').run(w.p.id);assert.equal((await send('cast',w.p,{...w.ref,receipt:w.receipt})).statusCode,403);
 const z=await httpProof(f,'c');db.prepare("UPDATE human_reviewer_policies SET status='revoked' WHERE id=?").run(f.policy.id);assert.equal((await send('cast',z.p,{...z.ref,receipt:z.receipt})).statusCode,404);
});
const getReview=(path,p)=>app.inject({url:'/api/reviewer-requests/'+path,headers:p?{authorization:'Bearer '+p.token}:{}});
test('assigned policy list and metadata queue expose only safe assigned fields and real reviewed reference',async()=>{
 const f=await fixture(),p=f.people.a,listed=await getReview('policies',p);assert.equal(listed.statusCode,200,listed.body);assert.deepEqual(listed.json(),{policies:[{id:f.policy.id,revision:1,name:f.policyInput.name,requiredVotes:2,expiresAt:f.policyInput.expiresAt}]});
 const result=await getReview(f.policy.id,p);assert.equal(result.statusCode,200,result.body);assert.equal(result.headers['cache-control'],'no-store');const data=result.json();assert.equal(data.items.length,1);assert.equal(data.nextCursor,null);assert.deepEqual(Object.keys(data.items[0]).sort(),['agentId','ownVote','reference','requestedAt','toolName']);assert.deepEqual(data.items[0].reference,await reference(f));
 for(const secret of ['user_id','session_id','policy_json','reviewerIds','sealed_secret','receipt_hash','proof_session_hash','params_cipher','vote-session'])assert.ok(!result.body.includes(secret));
 assert.equal((await send('challenge',p,data.items[0].reference)).statusCode,200);
});
test('outsider admin and initiator cannot discover assigned request metadata; unknown policy is indistinguishable',async()=>{
 const f=await fixture('a');assert.deepEqual((await getReview('policies',f.people.outsider)).json(),{policies:[]});
 const denied=await getReview(f.policy.id,f.people.outsider),unknown=await getReview(randomUUID(),f.people.outsider);assert.equal(denied.statusCode,404);assert.equal(unknown.statusCode,404);assert.equal(denied.body,unknown.body);
 assert.deepEqual((await getReview(f.policy.id,f.people.a)).json(),{items:[],nextCursor:null});assert.equal((await getReview(f.policy.id,f.people.b)).json().items.length,1);
 assert.equal((await getReview('policies',undefined)).statusCode,401);assert.equal((await getReview(f.policy.id+'?userId=owner',f.people.b)).statusCode,400);assert.equal((await getReview(f.policy.id+'?cursor=bad',f.people.b)).statusCode,400);
});
test('queue excludes other tool/agent scopes, terminal/expired requests and revoked policies',async()=>{
 const f=await fixture(),p=f.people.a;db.prepare('UPDATE tool_approvals SET tool_name=? WHERE id=?').run('outside_tool',f.request.id);assert.deepEqual((await getReview(f.policy.id,p)).json(),{items:[],nextCursor:null});
 db.prepare('UPDATE tool_approvals SET tool_name=?,requested_at=? WHERE id=?').run(tool.name,new Date(Date.now()-90000000).toISOString(),f.request.id);assert.deepEqual((await getReview(f.policy.id,p)).json(),{items:[],nextCursor:null});
 db.prepare('UPDATE tool_approvals SET requested_at=?,status=? WHERE id=?').run(new Date().toISOString(),'denied',f.request.id);assert.deepEqual((await getReview(f.policy.id,p)).json(),{items:[],nextCursor:null});
 db.prepare("UPDATE human_reviewer_policies SET status='revoked' WHERE id=?").run(f.policy.id);assert.deepEqual((await getReview('policies',p)).json(),{policies:[]});assert.equal((await getReview(f.policy.id,p)).statusCode,404);
});
test('queue cursor bounds candidates before returning pages, without repeats or unassigned scopes',async()=>{
 const f=await fixture(),p=f.people.a,original=db.prepare('SELECT * FROM tool_approvals WHERE id=?').get(f.request.id),columns=Object.keys(original),insert=db.prepare('INSERT INTO tool_approvals('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')');
 const ids=[original.id];for(let i=0;i<53;i++){const clone={...original,id:randomUUID()};ids.push(clone.id);insert.run(...columns.map(key=>clone[key]));}
 const unrelated={...original,id:randomUUID(),tool_name:'outside_tool'};insert.run(...columns.map(key=>unrelated[key]));
 const first=await getReview(f.policy.id,p);assert.equal(first.statusCode,200,first.body);assert.equal(first.json().items.length,50);assert.ok(first.json().nextCursor);const second=await getReview(f.policy.id+'?cursor='+first.json().nextCursor,p);assert.equal(second.statusCode,200,second.body);assert.equal(second.json().items.length,4);assert.equal(second.json().nextCursor,null);
 const actual=[...first.json().items,...second.json().items].map(item=>item.reference.approvalId);assert.equal(new Set(actual).size,54);assert.deepEqual(actual.sort(),ids.sort());assert.ok(!actual.includes(unrelated.id));
});
const detailPath=ref=>ref.policyId+'/'+ref.approvalId+'?'+new URLSearchParams({revision:String(ref.policyRevision),paramsHash:ref.paramsHash,requestHash:ref.requestHash,policyHash:ref.policyHash});
test('assigned exact detail decrypts real payload, masks secret fields and projects no owner history',async()=>{
 const secret='Temporary-Fixture-Api-Secret-729',f=await fixture('owner',{text:'Review this exact action',apiKey:secret,nested:{password:secret},value:'Ordinary review value'}),ref=await reference(f),result=await getReview(detailPath(ref),f.people.a);
 assert.equal(result.statusCode,200,result.body);assert.equal(result.headers['cache-control'],'no-store');const data=result.json();assert.deepEqual(Object.keys(data).sort(),['maskedFields','ownVote','params','reference','runScope']);assert.deepEqual(data.reference,ref);assert.equal(data.params.text,'Review this exact action');assert.equal(data.params.value,'Ordinary review value');assert.equal(data.params.apiKey.masked,true);assert.equal(data.params.nested.password.masked,true);assert.ok(data.maskedFields.includes('apiKey'));assert.ok(!result.body.includes(secret));assert.ok(!result.body.includes('vote-session'));assert.equal((await approvals.getApproval(f.request.id)).status,'pending');
 const unknown=await getReview(detailPath({...ref,approvalId:randomUUID()}),f.people.outsider),unassigned=await getReview(detailPath(ref),f.people.outsider);assert.equal(unassigned.statusCode,404);assert.equal(unknown.body,unassigned.body);
});
test('detail refuses changed fingerprints, scope, stale policy, query injection and unreadable ciphertext',async()=>{
 const f=await fixture(),ref=await reference(f),p=f.people.a;
 for(const changed of [{...ref,requestHash:'0'.repeat(64)},{...ref,policyHash:'0'.repeat(64)},{...ref,paramsHash:'0'.repeat(64)},{...ref,policyRevision:2}])assert.equal((await getReview(detailPath(changed),p)).statusCode,404);
 assert.equal((await getReview(detailPath(ref)+'&userId=owner',p)).statusCode,400);
 db.prepare('UPDATE tool_approvals SET params_encrypted=? WHERE id=?').run('corrupt',f.request.id);assert.equal((await getReview(detailPath(ref),p)).statusCode,404);
 assert.equal((await approvals.getApproval(f.request.id)).status,'pending');
 db.prepare("UPDATE human_reviewer_policies SET status='revoked' WHERE id=?").run(f.policy.id);assert.equal((await getReview(detailPath(ref),p)).statusCode,404);
});
test('detail recomputes stored parameter hash and does not expire unrelated pending requests',async()=>{
 const f=await fixture(),ref=await reference(f),p=f.people.a,{getEncryptionService}=await import('../src/credentials/encryption.ts');
 const original=db.prepare('SELECT * FROM tool_approvals WHERE id=?').get(f.request.id),unrelated={...original,id:randomUUID(),requested_at:new Date(Date.now()-90000000).toISOString()},columns=Object.keys(unrelated);db.prepare('INSERT INTO tool_approvals('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').run(...columns.map(k=>unrelated[k]));
 assert.equal((await getReview(detailPath(ref),p)).statusCode,200);assert.equal(db.prepare('SELECT status FROM tool_approvals WHERE id=?').get(unrelated.id).status,'pending');
 const encrypted=await getEncryptionService().encrypt(JSON.stringify({text:'Changed encrypted payload without matching request hash'}));
 db.prepare('UPDATE tool_approvals SET params_encrypted=?,params_iv=?,params_tag=? WHERE id=?').run(encrypted.encrypted,encrypted.iv,encrypted.authTag,f.request.id);
 assert.equal((await getReview(detailPath(ref),p)).statusCode,404);
});
test('embedded credential text is redacted while ordinary review text remains visible',async()=>{
 const embedded='sk-proj-'+randomBytes(24).toString('hex'),f=await fixture('owner',{text:'Review text with '+embedded+' embedded credential'}),ref=await reference(f),result=await getReview(detailPath(ref),f.people.a);
 assert.equal(result.statusCode,200,result.body);assert.ok(result.json().params.text.includes('Review text with'));assert.ok(!result.body.includes(embedded));assert.ok(result.json().maskedFields.includes('text'));
});
const manage=(method,path,p,payload)=>app.inject({method,url:'/api/reviewer-policies'+(path?'/'+path:''),headers:p?{authorization:'Bearer '+p.token}:{},...(payload===undefined?{}:{payload})});
async function policyProof(id,action,p,codeTime=Date.now()){
 const preview=await manage('POST',id+'/'+action+'/preview',p,{revision:1});assert.equal(preview.statusCode,200,preview.body);const paramsHash=preview.json().paramsHash;
 const issue=await manage('POST',id+'/'+action+'/challenge',p,{revision:1,paramsHash});assert.equal(issue.statusCode,200,issue.body);
 const complete=await manage('POST',id+'/'+action+'/complete',p,{revision:1,paramsHash,challenge:issue.json().challenge,code:otp(p,codeTime)});assert.equal(complete.statusCode,200,complete.body);assert.deepEqual(Object.keys(complete.json()).sort(),['expiresAt','receipt']);return {revision:1,paramsHash,receipt:complete.json().receipt};
}
test('owner HTTP draft save/read grants no authority; activation requires proof and a separate apply',async()=>{
 const f=await fixture(),id=randomUUID(),p=f.people.owner;
 const saved=await manage('PUT',id+'/draft',p,{expectedRevision:0,policy:f.policyInput});assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().status,'draft');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_reviewer_policies WHERE id=?').get(id).n,0);
 const detail=await manage('GET',id+'/draft',p);assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.headers['cache-control'],'no-store');assert.equal(detail.json().revision,1);
 const proof=await policyProof(id,'activate',p,Date.now()+30000);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_reviewer_policies WHERE id=?').get(id).n,0);
 const changed=await manage('POST',id+'/activate/apply',p,proof);assert.equal(changed.statusCode,200,changed.body);assert.deepEqual(changed.json(),{id,version:1,status:'active'});assert.equal((await manage('POST',id+'/activate/apply',p,proof)).statusCode,403);
});
test('owner HTTP withdrawal requires separate exact proof and invalidates the active rule once',async()=>{
 const f=await fixture(),p=f.people.owner;
 const preview=await manage('POST',f.policy.id+'/revoke/preview',p,{revision:1});assert.equal(preview.statusCode,200,preview.body);
 assert.equal((await manage('POST',f.policy.id+'/revoke/apply',p,{revision:1,paramsHash:preview.json().paramsHash,receipt:'x'.repeat(43)})).statusCode,403);
 const proof=await policyProof(f.policy.id,'revoke',p,Date.now()+30000);assert.equal(db.prepare('SELECT status FROM human_reviewer_policies WHERE id=?').get(f.policy.id).status,'active');
 const result=await manage('POST',f.policy.id+'/revoke/apply',p,proof);assert.equal(result.statusCode,200,result.body);assert.deepEqual(result.json(),{id:f.policy.id,version:2,status:'revoked'});assert.equal((await manage('POST',f.policy.id+'/revoke/apply',p,proof)).statusCode,409);
});
test('policy HTTP denies admin/user authority and exact-input identity/generation injection',async()=>{
 const f=await fixture(),id=randomUUID(),p=f.people.owner;
 for(const person of [f.people.a,f.people.b])for(const [method,path,payload] of [['GET',f.policy.id+'/draft'],['PUT',id+'/draft',{expectedRevision:0,policy:f.policyInput}],['POST',f.policy.id+'/revoke/preview',{revision:1}]])assert.equal((await manage(method,path,person,payload)).statusCode,403);
 for(const payload of [{revision:'1'},{revision:1,userId:p.id},{revision:1,policyVersion:1},{revision:1,verified:true}])assert.equal((await manage('POST',f.policy.id+'/revoke/preview',p,payload)).statusCode,400);
 assert.equal((await manage('PUT',id+'/draft',p,{expectedRevision:0,policy:{...f.policyInput,active:true}})).statusCode,400);
 assert.equal((await manage('POST',f.policy.id+'/revoke/preview?target=other',p,{revision:1})).statusCode,400);
 assert.equal((await manage('POST',f.policy.id+'/revoke/preview',undefined,{revision:1})).statusCode,401);
});
test('owner policy proof stays bound to actual signed session and current draft revision',async()=>{
 const f=await fixture(),p=f.people.owner,id=randomUUID();assert.equal((await manage('PUT',id+'/draft',p,{expectedRevision:0,policy:f.policyInput})).statusCode,200);
 const preview=(await manage('POST',id+'/activate/preview',p,{revision:1})).json(),issue=(await manage('POST',id+'/activate/challenge',p,{revision:1,paramsHash:preview.paramsHash})).json();
 const payload={revision:1,paramsHash:preview.paramsHash,challenge:issue.challenge,code:otp(p,Date.now()+30000)};
 assert.equal((await manage('POST',id+'/activate/complete',{...p,token:generateToken(p.id,2)},payload)).statusCode,403);
 const complete=await manage('POST',id+'/activate/complete',p,payload);assert.equal(complete.statusCode,200,complete.body);
 assert.equal((await manage('PUT',id+'/draft',p,{expectedRevision:1,policy:{...f.policyInput,name:'Changed after review'}})).statusCode,200);
 assert.equal((await manage('POST',id+'/activate/apply',p,{revision:1,paramsHash:preview.paramsHash,receipt:complete.json().receipt})).statusCode,409);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_reviewer_policies WHERE id=?').get(id).n,0);
});
test('owner inventory/details are bounded and omit raw history; malformed rule can still be withdrawn',async()=>{
 const f=await fixture(),p=f.people.owner,listed=await manage('GET','',p);assert.equal(listed.statusCode,200,listed.body);assert.ok(listed.json().items.length<=50);assert.ok(listed.json().items.some(i=>i.id===f.policy.id));
 const detail=await manage('GET',f.policy.id,p);assert.equal(detail.statusCode,200,detail.body);assert.deepEqual(detail.json().policy,f.policyInput);assert.deepEqual(Object.keys(detail.json()).sort(),['id','policy','status','unavailable','version']);
 assert.equal((await manage('GET','',f.people.b)).statusCode,403);assert.equal((await manage('GET',f.policy.id,f.people.b)).statusCode,403);
 db.prepare('UPDATE human_reviewer_policies SET policy_json=? WHERE id=?').run('{bad content with private text',f.policy.id);const malformed=await manage('GET',f.policy.id,p);assert.equal(malformed.statusCode,200);assert.equal(malformed.json().policy,null);assert.equal(malformed.json().unavailable,true);assert.ok(!malformed.body.includes('private text'));
 const proof=await policyProof(f.policy.id,'revoke',p,Date.now()+30000);assert.equal((await manage('POST',f.policy.id+'/revoke/apply',p,proof)).statusCode,200);
});
test('eligible human picker is owner-only, bounded and excludes revoked/unverified/system accounts',async()=>{
 const f=await fixture(),p=f.people.owner,prefix='picker-'+randomUUID();
 for(const [suffix,role,status,verified,enabled] of [['yes','user','active',1,1],['guest','guest','active',1,1],['inactive','user','inactive',1,1],['unverified','user','active',0,1],['disabled-factor','user','active',1,0],['no-factor','user','active',1,null]]){
  const id=prefix+'-'+suffix;db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'private-password-hash',?,?,?)").run(id,id+'@example.test',id,role,status,verified);
  if(enabled!==null)db.prepare('INSERT INTO verification_factors(user_id,sealed_secret,version,enabled,last_counter,activated_at) VALUES(?,?,1,?,-1,?)').run(id,'private-factor-cipher',enabled,Date.now());
 }
 for(const id of ['mock-user','1']){db.prepare("UPDATE users SET role='owner',status='active',email_verified=1 WHERE id=?").run(id);db.prepare('INSERT OR REPLACE INTO verification_factors(user_id,sealed_secret,version,enabled,last_counter,activated_at) VALUES(?,?,1,1,-1,?)').run(id,'private-system-factor',Date.now());}
 assert.equal((await manage('GET','eligible-humans',f.people.b)).statusCode,403);assert.equal((await manage('GET','eligible-humans',f.people.a)).statusCode,403);assert.equal((await manage('GET','eligible-humans',undefined)).statusCode,401);
 let cursor='',all=[];do{const r=await manage('GET','eligible-humans'+(cursor?'?cursor='+encodeURIComponent(cursor):''),p);assert.equal(r.statusCode,200,r.body);assert.equal(r.headers['cache-control'],'no-store');assert.ok(r.json().items.length<=50);for(const i of r.json().items)assert.deepEqual(Object.keys(i).sort(),['id','name','role']);assert.ok(!r.body.includes('private-'));all.push(...r.json().items);cursor=r.json().nextCursor;}while(cursor);
 const selected=all.filter(i=>i.id.startsWith(prefix));assert.deepEqual(selected.map(i=>i.id),[prefix+'-yes']);assert.ok(!all.some(i=>['mock-user','1'].includes(i.id)));assert.equal(new Set(all.map(i=>i.id)).size,all.length);
 db.prepare('UPDATE verification_factors SET enabled=0 WHERE user_id=?').run(prefix+'-yes');const after=await manage('GET','eligible-humans?cursor='+prefix,p);assert.ok(!after.json().items.some(i=>i.id===prefix+'-yes'));
 assert.equal((await manage('GET','eligible-humans?userId=other',p)).statusCode,400);
});
test('owner inventory projects normalized draft names and never echoes malformed raw policy labels',async()=>{
 const f=await fixture(),p=f.people.owner,nameOf=async()=>{const response=await manage('GET','',p);assert.equal(response.statusCode,200,response.body);const item=response.json().items.find(v=>v.id===f.policy.id);assert.ok(item);assert.deepEqual(Object.keys(item).sort(),['draftPending','draftRevision','id','name','status','version']);assert.ok(!response.body.includes('PRIVATE-MALFORMED-LABEL'));return item;};
 assert.equal((await nameOf()).name,f.policyInput.name);assert.equal((await nameOf()).draftPending,false);
 db.prepare('UPDATE human_reviewer_drafts SET policy_json=? WHERE id=?').run(JSON.stringify({...f.policyInput,name:'Edited draft name'}),f.policy.id);assert.equal((await nameOf()).name,'Edited draft name');assert.equal((await nameOf()).draftPending,true);
 db.prepare('UPDATE human_reviewer_drafts SET policy_json=? WHERE id=?').run(JSON.stringify({name:'PRIVATE-MALFORMED-LABEL'}),f.policy.id);assert.equal((await nameOf()).name,f.policyInput.name);assert.equal((await nameOf()).draftPending,false);
 db.prepare('UPDATE human_reviewer_policies SET policy_json=? WHERE id=?').run(JSON.stringify({name:'PRIVATE-MALFORMED-LABEL'}),f.policy.id);assert.equal((await nameOf()).name,null);assert.equal((await nameOf()).draftPending,false);
});
test('assigned human reads only own durable vote and can explicitly renew a stale approval once',async()=>{
 const f=await fixture(),p=f.people.a,ref=await reference(f),initial=await getReview(detailPath(ref),p);assert.equal(initial.json().ownVote,null);
 const v=await httpProof(f);assert.equal((await send('cast',p,{...v.ref,receipt:v.receipt})).statusCode,200);
 const stored={decision:'approve',revision:1,status:'current'},detail=await getReview(detailPath(ref),p);assert.deepEqual(detail.json().ownVote,stored);assert.deepEqual((await getReview(f.policy.id,p)).json().items[0].ownVote,stored);
 assert.deepEqual((await getReview(detailPath(ref),{...p,token:generateToken(p.id,2)})).json().ownVote,stored);
 assert.equal((await getReview(detailPath(ref),f.people.b)).json().ownVote,null);assert.equal((await getReview(detailPath(ref),f.people.outsider)).statusCode,404);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_reviewer_vote_events WHERE approval_id=?').get(f.request.id).n,1);assert.ok(!detail.body.includes('proof_session_hash'));assert.ok(!detail.body.includes(v.receipt));
 db.prepare('UPDATE users SET token_version=3 WHERE id=?').run(p.id);const current={...p,token:generateToken(p.id,3)};assert.deepEqual((await getReview(detailPath(ref),current)).json().ownVote,{decision:'approve',revision:1,status:'verification_required'});
 const issue=await send('challenge',current,ref),complete=await send('complete',current,{...ref,challenge:issue.json().challenge,code:otp(p,Date.now()+30000)});assert.equal(complete.statusCode,200,complete.body);
 const renewed=await send('cast',current,{...ref,receipt:complete.json().receipt});assert.equal(renewed.statusCode,200,renewed.body);assert.equal(renewed.json().revision,2);assert.deepEqual((await getReview(detailPath(ref),current)).json().ownVote,{decision:'approve',revision:2,status:'current'});assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_reviewer_votes WHERE approval_id=?').get(f.request.id).n,1);
});
test('matching own decline stays terminal after a new account generation and readback never changes state',async()=>{
 const f=await fixture(),p=f.people.a,v=await httpProof(f,'a','deny');assert.equal((await send('cast',p,{...v.ref,receipt:v.receipt})).statusCode,200);db.prepare('UPDATE users SET token_version=3 WHERE id=?').run(p.id);const current={...p,token:generateToken(p.id,3)},r=await getReview(detailPath(v.ref),current);assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json().ownVote,{decision:'deny',revision:1,status:'current'});assert.equal((await approvals.getApproval(f.request.id)).status,'pending');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_reviewer_vote_events WHERE approval_id=?').get(f.request.id).n,1);
});
