import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes,randomUUID} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'ap-policy-state-'));process.chdir(dir);process.env.DATABASE_PATH=join(dir,'test.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();test.after(()=>closeDatabase());
const {beginEnrollment,activateEnrollment}=await import('../src/auth/verification/enrollment.ts');const {hotp,decodeSecret}=await import('../src/auth/verification/totp.ts');const seeds={};
const initial=Date.now()-60000;
for(const [id,role] of [['state-owner','owner'],['state-a','user'],['state-b','admin']]){db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'x',?,'active',1)").run(id,id+'@example.test',id,role);const b={userId:id,sessionHash:'a'.repeat(64),tokenVersion:1},setup=await beginEnrollment(b,initial);seeds[id]=setup.secret;await activateEnrollment(b,hotp(decodeSecret(setup.secret),BigInt(Math.floor(initial/30000))),initial);}
const {saveReviewerDraft}=await import('../src/auth/verification/reviewer-policy.ts');const {reviewerDraftProofTarget,issueReviewerDraftChallenge,completeReviewerDraftChallenge}=await import('../src/auth/verification/reviewer-policy-proof.ts');
const {activateReviewerPolicy,reviewerPolicyRevocationTarget,issueReviewerPolicyRevocation,completeReviewerPolicyRevocation,revokeReviewerPolicy}=await import('../src/auth/verification/reviewer-policy-state.ts');
const {sql}=await import('../src/repositories/sql-steps.ts');const {consumeOperationReceiptStep}=await import('../src/auth/verification/operation-proof.ts');
const actor={kind:'user',userId:'state-owner',role:'owner'},context={userId:'state-owner',sessionHash:'b'.repeat(64),tokenVersion:2,factorVersion:1},draftContext={actor,tokenVersion:2};
let cursor=Date.now()+600000;const tick=()=>cursor+=60000,otp=time=>hotp(decodeSecret(seeds['state-owner']),BigInt(Math.floor(time/30000)));
const input=time=>({name:'Reviewed state policy',scope:{agentIds:['state-agent'],toolNames:['fixture_state_action']},reviewerIds:['state-a','state-b'],requiredVotes:1,allowInitiatorVote:false,expiresAt:time+3600000});
const generation=()=>db.prepare('SELECT version FROM approval_proof_policy WHERE id=1').get().version;
async function candidate(time){const id=randomUUID();await saveReviewerDraft(draftContext,id,0,input(time),time);return reviewerDraftProofTarget(context,actor,id,1,time);}
async function activationProof(target,time){const issued=await issueReviewerDraftChallenge(context,actor,target.policyId,target.draftRevision,target.paramsHash,time);const proof=await completeReviewerDraftChallenge(issued.token,context,actor,target.policyId,target.draftRevision,target.paramsHash,otp(time),time);assert.ok(proof);return proof.receipt;}
const activate=(receipt,target,time,ctx=context,a=actor)=>activateReviewerPolicy(receipt,ctx,a,target.policyId,target.draftRevision,target.paramsHash,time);
async function withdrawal(id,version,time){const target=await reviewerPolicyRevocationTarget(context,actor,id,version,time),issued=await issueReviewerPolicyRevocation(context,actor,id,version,target.paramsHash,time),proof=await completeReviewerPolicyRevocation(issued.token,context,actor,id,version,target.paramsHash,otp(time),time);assert.ok(proof);return {target,receipt:proof.receipt};}
const revoke=(proof,time)=>revokeReviewerPolicy(proof.receipt,context,actor,proof.target.policyId,proof.target.policyRevision,proof.target.paramsHash,time);
test('owner proof activates the actual gate and separate revocation proof withdraws that exact rule',async()=>{
 const time=Date.now(),target=await candidate(time),receipt=await activationProof(target,time),before=generation(),active=await activate(receipt,target,time);assert.equal(active.status,'active');assert.equal(active.version,1);assert.equal(generation(),before+1);
 const {checkReviewerQuorum}=await import('../src/auth/verification/reviewer-quorum.ts');const request=randomUUID(),hash='c'.repeat(64);db.prepare("INSERT INTO tool_approvals(id,status,tool_name,agent_id,params_encrypted,params_iv,params_tag,params_hash,requested_at) VALUES(?,'pending','fixture_state_action','state-agent','fixture','fixture','fixture',?,?)").run(request,hash,new Date(time).toISOString().slice(0,19).replace('T',' '));
 await assert.rejects(checkReviewerQuorum('state-owner',request,hash,Date.now()),/reviewer_quorum_required/);
 const revokeTime=Date.now(),revTarget=await reviewerPolicyRevocationTarget(context,actor,active.id,1,revokeTime),issued=await issueReviewerPolicyRevocation(context,actor,active.id,1,revTarget.paramsHash,revokeTime);
 const wrong=await completeReviewerPolicyRevocation(issued.token,context,actor,active.id,1,revTarget.paramsHash,otp(revokeTime+30000),revokeTime);assert.ok(wrong);
 const withdrawn=await revoke({target:revTarget,receipt:wrong.receipt},revokeTime);assert.equal(withdrawn.status,'revoked');assert.equal(withdrawn.version,2);assert.equal(generation(),before+2);await checkReviewerQuorum('state-owner',request,hash,Date.now());
 assert.deepEqual(db.prepare('SELECT action FROM human_reviewer_policy_events WHERE policy_id=? ORDER BY version').all(active.id).map(r=>r.action),['activate','revoke']);
});
test('concurrent activation consumes receipt and advances policy/history/generation once',async()=>{
 const time=tick(),target=await candidate(time),receipt=await activationProof(target,time),before=generation();const results=await Promise.allSettled(Array.from({length:8},()=>activate(receipt,target,time)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(generation(),before+1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_reviewer_policy_events WHERE policy_id=?').get(target.policyId).n,1);
});
test('state/history write failure rolls back activation receipt, policy and generation together',async()=>{
 const time=tick(),target=await candidate(time),receipt=await activationProof(target,time),before=generation();db.exec("CREATE TEMP TRIGGER fail_policy_event BEFORE INSERT ON human_reviewer_policy_events BEGIN SELECT RAISE(ABORT,'fixture history failure'); END");
 await assert.rejects(activate(receipt,target,time),/fixture history failure/);db.exec('DROP TRIGGER fail_policy_event');assert.equal(generation(),before);assert.equal(db.prepare('SELECT id FROM human_reviewer_policies WHERE id=?').get(target.policyId),undefined);assert.equal((await activate(receipt,target,time)).status,'active');
});
test('stale draft, revoked reviewer or wrong actor/session cannot activate a proved candidate',async()=>{
 const time=tick(),target=await candidate(time),receipt=await activationProof(target,time);
 await assert.rejects(activate(receipt,target,time,{...context,sessionHash:'d'.repeat(64)}),/forbidden/);await assert.rejects(activate(receipt,target,time,context,{...actor,kind:'agent'}),/forbidden/);
 db.prepare("UPDATE verification_factors SET enabled=0 WHERE user_id='state-a'").run();await assert.rejects(activate(receipt,target,time),/ineligible/);db.prepare("UPDATE verification_factors SET enabled=1 WHERE user_id='state-a'").run();
 await saveReviewerDraft(draftContext,target.policyId,1,{...input(time),name:'Changed candidate'},time+1);await assert.rejects(activate(receipt,target,time+1),/conflict/);assert.equal(db.prepare('SELECT id FROM human_reviewer_policies WHERE id=?').get(target.policyId),undefined);
});
test('activation proof cannot be reused for revocation or another operation',async()=>{
 const time=tick(),target=await candidate(time),receipt=await activationProof(target,time);await activate(receipt,target,time);
 const unusedTime=tick(),unusedTarget=await reviewerDraftProofTarget(context,actor,target.policyId,1,unusedTime),unusedActivation=await activationProof(unusedTarget,unusedTime),revTarget=await reviewerPolicyRevocationTarget(context,actor,target.policyId,1,unusedTime);
 await assert.rejects(revokeReviewerPolicy(unusedActivation,context,actor,target.policyId,1,revTarget.paramsHash,unusedTime),/forbidden/);assert.equal(db.prepare('SELECT status FROM human_reviewer_policies WHERE id=?').get(target.policyId).status,'active');
 const revokeTime=tick(),proof=await withdrawal(target.policyId,1,revokeTime);assert.equal(await sql().tx(()=>consumeOperationReceiptStep(proof.receipt,context,{kind:'tool_approval',approvalId:target.policyId,paramsHash:revTarget.paramsHash,policyVersion:revTarget.policyVersion},revokeTime)),false);await revoke(proof,revokeTime);
});
test('owner can withdraw unavailable policy after reviewer revocation, without granting a bypass',async()=>{
 const time=tick(),target=await candidate(time),receipt=await activationProof(target,time);await activate(receipt,target,time);
 db.prepare("UPDATE verification_factors SET enabled=0 WHERE user_id='state-a'").run();db.prepare('UPDATE human_reviewer_policies SET policy_json=? WHERE id=?').run('{unavailable fixture',target.policyId);
 const revokeTime=tick(),proof=await withdrawal(target.policyId,1,revokeTime);await revoke(proof,revokeTime);assert.equal(db.prepare('SELECT status FROM human_reviewer_policies WHERE id=?').get(target.policyId).status,'revoked');db.prepare("UPDATE verification_factors SET enabled=1 WHERE user_id='state-a'").run();
});
test('replacement invalidates stale revocation and failed revocation history rolls back receipt/state',async()=>{
 let time=tick();const target=await candidate(time),receipt=await activationProof(target,time);await activate(receipt,target,time);
 time=tick();const oldProof=await withdrawal(target.policyId,1,time);await saveReviewerDraft(draftContext,target.policyId,1,{...input(time),name:'Replacement'},time);
 time=tick();const changed=await reviewerDraftProofTarget(context,actor,target.policyId,2,time),nextReceipt=await activationProof(changed,time);assert.equal((await activate(nextReceipt,changed,time)).version,2);await assert.rejects(revoke(oldProof,time),/conflict/);
 time=tick();const fresh=await withdrawal(target.policyId,2,time),before=generation();db.exec("CREATE TEMP TRIGGER fail_revoke_event BEFORE INSERT ON human_reviewer_policy_events WHEN NEW.action='revoke' BEGIN SELECT RAISE(ABORT,'fixture revoke failure'); END");await assert.rejects(revoke(fresh,time),/fixture revoke failure/);db.exec('DROP TRIGGER fail_revoke_event');assert.equal(generation(),before);assert.equal(db.prepare('SELECT version FROM human_reviewer_policies WHERE id=?').get(target.policyId).version,2);assert.equal((await revoke(fresh,time)).version,3);
});

test('expired policy remains withdrawable; nonhuman or revoked owner cannot consume its proof',async()=>{
 const time=tick(),target=await candidate(time),receipt=await activationProof(target,time);await activate(receipt,target,time);
 db.prepare('UPDATE human_reviewer_policies SET policy_json=? WHERE id=?').run(JSON.stringify({...input(time),expiresAt:time+1}),target.policyId);
 const revokeTime=tick(),proof=await withdrawal(target.policyId,1,revokeTime);
 await assert.rejects(revokeReviewerPolicy(proof.receipt,context,{...actor,kind:'service'},target.policyId,1,proof.target.paramsHash,revokeTime),/forbidden/);
 await assert.rejects(revokeReviewerPolicy(proof.receipt,{...context,sessionHash:'f'.repeat(64)},actor,target.policyId,1,proof.target.paramsHash,revokeTime),/forbidden/);
 db.prepare("UPDATE users SET role='admin' WHERE id='state-owner'").run();await assert.rejects(revoke(proof,revokeTime),/forbidden/);db.prepare("UPDATE users SET role='owner' WHERE id='state-owner'").run();
 assert.equal((await revoke(proof,revokeTime)).status,'revoked');
});
