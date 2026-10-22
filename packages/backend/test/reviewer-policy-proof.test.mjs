import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes,randomUUID,createHash} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'ap-reviewer-proof-'));process.chdir(dir);process.env.DATABASE_PATH=join(dir,'test.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();test.after(()=>closeDatabase());
const {beginEnrollment,activateEnrollment}=await import('../src/auth/verification/enrollment.ts');const {hotp,decodeSecret}=await import('../src/auth/verification/totp.ts');
const base=1800000000000;let ownerSecret;
for(const [id,role] of [['policy-owner','owner'],['person-a','user'],['person-b','admin']]){
 db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'x',?,'active',1)").run(id,id+'@example.test',id,role);
 const b={userId:id,sessionHash:'a'.repeat(64),tokenVersion:1},setup=await beginEnrollment(b,base-60000);await activateEnrollment(b,hotp(decodeSecret(setup.secret),BigInt(Math.floor((base-60000)/30000))),base-60000);if(id==='policy-owner')ownerSecret=setup.secret;
}
const {sql}=await import('../src/repositories/sql-steps.ts');
const {saveReviewerDraft}=await import('../src/auth/verification/reviewer-policy.ts');
const {reviewerDraftProofTarget,issueReviewerDraftChallenge,completeReviewerDraftChallenge,consumeReviewerDraftReceiptStep}=await import('../src/auth/verification/reviewer-policy-proof.ts');
const {approvalOperationHash,reviewerPolicyOperationHash,completeOperationChallenge,consumeOperationReceiptStep}=await import('../src/auth/verification/operation-proof.ts');
const actor={kind:'user',role:'owner',userId:'policy-owner'},context={userId:'policy-owner',sessionHash:'b'.repeat(64),tokenVersion:2,factorVersion:1},draftContext={actor,tokenVersion:2};
const input=time=>({name:'Reviewed policy',scope:{agentIds:['policy-agent'],toolNames:['fixture_action']},reviewerIds:['person-a','person-b'],requiredVotes:1,allowInitiatorVote:false,expiresAt:time+86400000});
const otp=time=>hotp(decodeSecret(ownerSecret),BigInt(Math.floor(time/30000)));
async function draft(time){const id=randomUUID();await saveReviewerDraft(draftContext,id,0,input(time),time);return reviewerDraftProofTarget(context,actor,id,1,time);}
async function proof(target,time){const issued=await issueReviewerDraftChallenge(context,actor,target.policyId,1,target.paramsHash,time);return completeReviewerDraftChallenge(issued.token,context,actor,target.policyId,1,target.paramsHash,otp(time),time);}
const claim=(receipt,target,time,ctx=context)=>sql().tx(()=>consumeReviewerDraftReceiptStep(receipt,ctx,actor,target.policyId,1,target.paramsHash,time));
test('policy proof has a separate exact domain and existing tool fingerprints remain stable',async()=>{
 const time=base,target=await draft(time),tool={kind:'tool_approval',approvalId:target.policyId,paramsHash:target.paramsHash,policyVersion:target.policyVersion};
 assert.equal(approvalOperationHash(tool),createHash('sha256').update(JSON.stringify(['tool-approval-proof-v1',tool.approvalId,tool.paramsHash,tool.policyVersion,null])).digest('hex'));
 assert.notEqual(approvalOperationHash(tool),reviewerPolicyOperationHash(target));
 assert.throws(()=>reviewerPolicyOperationHash({...target,action:'revoke'}));assert.throws(()=>reviewerPolicyOperationHash({...target,verified:true}));
 const challenge=await issueReviewerDraftChallenge(context,actor,target.policyId,1,target.paramsHash,time);
 assert.equal(await completeOperationChallenge(challenge.token,context,tool,otp(time),time),null);
 const receipt=await completeReviewerDraftChallenge(challenge.token,context,actor,target.policyId,1,target.paramsHash,otp(time),time);assert.ok(receipt);
 assert.equal(await sql().tx(()=>consumeOperationReceiptStep(receipt.receipt,context,tool,time)),false);
 const results=await Promise.all(Array.from({length:8},()=>claim(receipt.receipt,target,time)));assert.equal(results.filter(Boolean).length,1);
 assert.equal(db.prepare('SELECT status FROM human_reviewer_drafts WHERE id=?').get(target.policyId).status,'draft');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tool_approvals').get().n,0);
});
test('a changed candidate revision cannot reuse a challenge or completed policy receipt',async()=>{
 const time=base+600000,target=await draft(time),receipt=await proof(target,time);assert.ok(receipt);
 await saveReviewerDraft(draftContext,target.policyId,1,{...input(time),requiredVotes:2,reviewerIds:['policy-owner','person-a','person-b']},time+1);
 await assert.rejects(claim(receipt.receipt,target,time+1),/conflict/);
 const changed=await reviewerDraftProofTarget(context,actor,target.policyId,2,time+1);assert.notEqual(changed.paramsHash,target.paramsHash);
 await assert.rejects(issueReviewerDraftChallenge(context,actor,target.policyId,2,target.paramsHash,time+1),/conflict/);
});
test('live reviewer revocation and account/factor generations invalidate candidate proof',async()=>{
 const time=base+1200000,target=await draft(time),receipt=await proof(target,time);assert.ok(receipt);
 db.prepare("UPDATE users SET status='suspended' WHERE id='person-a'").run();await assert.rejects(claim(receipt.receipt,target,time),/ineligible/);db.prepare("UPDATE users SET status='active',token_version=token_version+1 WHERE id='person-a'").run();await assert.rejects(claim(receipt.receipt,target,time),/conflict/);
 db.prepare("UPDATE users SET token_version=token_version-1 WHERE id='person-a'").run();db.prepare("UPDATE verification_factors SET version=version+1 WHERE user_id='person-a'").run();await assert.rejects(claim(receipt.receipt,target,time),/conflict/);db.prepare("UPDATE verification_factors SET version=version-1 WHERE user_id='person-a'").run();
});
test('wrong session, expired receipt and revoked owner cannot consume proof',async()=>{
 const time=base+1800000,target=await draft(time),receipt=await proof(target,time);assert.ok(receipt);
 assert.equal(await claim(receipt.receipt,target,time,{...context,sessionHash:'c'.repeat(64)}),false);assert.equal(await claim(receipt.receipt,target,time+120001),false);
 db.prepare("UPDATE users SET role='admin' WHERE id='policy-owner'").run();await assert.rejects(claim(receipt.receipt,target,time),/forbidden/);db.prepare("UPDATE users SET role='owner' WHERE id='policy-owner'").run();
 await assert.rejects(claim(receipt.receipt,target,time,{...context,tokenVersion:1}),/forbidden/);
});
test('future activation transaction failure rolls back consumed proof and changes no authority',async()=>{
 const time=base+2400000,target=await draft(time),receipt=await proof(target,time);assert.ok(receipt);
 await assert.rejects(sql().tx(function*(){assert.equal(yield* consumeReviewerDraftReceiptStep(receipt.receipt,context,actor,target.policyId,1,target.paramsHash,time),true);throw Error('fixture state write failed');}),/fixture state write failed/);
 assert.equal(await claim(receipt.receipt,target,time),true);assert.equal(await claim(receipt.receipt,target,time),false);assert.equal(db.prepare('SELECT status FROM human_reviewer_drafts WHERE id=?').get(target.policyId).status,'draft');
});
test('nonhuman actors and changed policy generation cannot obtain or reuse policy authority proof',async()=>{
 const time=base+3000000,target=await draft(time),receipt=await proof(target,time);assert.ok(receipt);
 for(const kind of ['agent','service','system'])await assert.rejects(issueReviewerDraftChallenge(context,{...actor,kind},target.policyId,1,target.paramsHash,time),/forbidden/);
 for(const missing of [undefined,null,'']){await assert.rejects(issueReviewerDraftChallenge(context,actor,target.policyId,1,missing,time),/invalid/);await assert.rejects(claim(receipt.receipt,{...target,paramsHash:missing},time),/invalid/);}
 await assert.rejects(issueReviewerDraftChallenge(context,actor,target.policyId,1,'0'.repeat(64),time),/conflict/);
 db.prepare('UPDATE approval_proof_policy SET version=version+1 WHERE id=1').run();assert.equal(await claim(receipt.receipt,target,time),false);
});

test('channel-bound owner-shaped actor cannot save a draft or spend a human policy receipt',async()=>{
 const time=base+9000000,id=randomUUID(),polluted={...actor,channel:'outside'};
 await assert.rejects(saveReviewerDraft({...draftContext,actor:polluted},id,0,input(time),time),/forbidden/);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_reviewer_drafts WHERE id=?').get(id).n,0);
 const target=await draft(time),receipt=await proof(target,time);assert.ok(receipt);
 await assert.rejects(reviewerDraftProofTarget(context,polluted,target.policyId,1,time),/forbidden/);
 await assert.rejects(sql().tx(()=>consumeReviewerDraftReceiptStep(receipt.receipt,context,polluted,target.policyId,1,target.paramsHash,time)),/forbidden/);
 assert.equal(await claim(receipt.receipt,target,time),true);
});
