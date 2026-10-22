import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes,randomUUID} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'ap-reviewer-drafts-'));process.chdir(dir);process.env.DATABASE_PATH=join(dir,'test.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();test.after(()=>closeDatabase());
for(const [id,role] of [['draft-owner','owner'],['reviewer-a','user'],['reviewer-b','admin'],['reviewer-c','user'],['guest-person','guest'],['no-factor','user']])db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'x',?,'active',1)").run(id,id+'@example.test',id,role);
const {beginEnrollment,activateEnrollment}=await import('../src/auth/verification/enrollment.ts');const {hotp,decodeSecret}=await import('../src/auth/verification/totp.ts');
const now=1800000000000;
for(const userId of ['draft-owner','reviewer-a','reviewer-b','reviewer-c','guest-person']){const b={userId,sessionHash:'a'.repeat(64),tokenVersion:1},setup=await beginEnrollment(b,now-60000);await activateEnrollment(b,hotp(decodeSecret(setup.secret),BigInt(Math.floor((now-60000)/30000))),now-60000);}
const {parseReviewerDraft,saveReviewerDraft,readReviewerDraft,ReviewerDraftError}=await import('../src/auth/verification/reviewer-policy.ts');
const context={actor:{kind:'user',userId:'draft-owner',role:'owner'},tokenVersion:2};
const input=()=>({name:'Sensitive tool decisions',scope:{agentIds:['review-agent'],toolNames:['fixture_action']},reviewerIds:['reviewer-b','reviewer-a'],requiredVotes:1,allowInitiatorVote:false,expiresAt:now+86400000});
const rejects=code=>error=>error instanceof ReviewerDraftError&&error.code===code;
test('exact finite draft validation rejects wildcard, identity/activation fields and impossible quorum',()=>{
 const valid=parseReviewerDraft(input(),now);assert.deepEqual(valid.reviewerIds,['reviewer-a','reviewer-b']);assert.equal(Object.isFrozen(valid.scope.agentIds),true);
 const bad=[{...input(),enabled:true},{...input(),ownerId:'reviewer-a'},{...input(),scope:{agentIds:['*'],toolNames:['fixture_action']}},{...input(),scope:{agentIds:['review-agent'],toolNames:[]}},{...input(),reviewerIds:['reviewer-a','reviewer-a']},{...input(),reviewerIds:['reviewer-a']},{...input(),requiredVotes:3},{...input(),requiredVotes:0},{...input(),requiredVotes:1.5},{...input(),allowInitiatorVote:'yes'},{...input(),expiresAt:now},{...input(),expiresAt:now+7776000001},{...input(),reviewerIds:['mock-user','reviewer-a']},{...input(),scope:{agentIds:['review-agent'],toolNames:['fixture_action'],network:true}}];
 for(const value of bad)assert.throws(()=>parseReviewerDraft(value,now),rejects('invalid'));
 assert.equal(parseReviewerDraft({...input(),reviewerIds:['reviewer-a'],allowInitiatorVote:true},now).requiredVotes,1);
});
test('owner can save/read a versioned draft without granting authority or changing proof policy',async()=>{
 const id=randomUUID(),generation=db.prepare('SELECT version FROM approval_proof_policy WHERE id=1').get().version;
 const saved=await saveReviewerDraft(context,id,0,input(),now);assert.equal(saved.status,'draft');assert.equal(saved.revision,1);assert.deepEqual(await readReviewerDraft(context,id),saved);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tool_approvals').get().n,0);assert.equal(db.prepare('SELECT version FROM approval_proof_policy WHERE id=1').get().version,generation);
 assert.throws(()=>db.prepare("UPDATE human_reviewer_drafts SET status='active' WHERE id=?").run(id),/CHECK constraint/);
 assert.equal((await readReviewerDraft(context,id)).status,'draft');
});
test('nonhuman and stale/revoked/spoofed owner authority never saves or reads drafts',async()=>{
 const id=randomUUID();await saveReviewerDraft(context,id,0,input(),now);
 for(const actor of [{kind:'agent',userId:'draft-owner',role:'owner'},{kind:'service',userId:'draft-owner',role:'owner'},{kind:'system',userId:'draft-owner',role:'owner'},{kind:'user',userId:'reviewer-b',role:'owner'},{kind:'user',userId:'draft-owner',role:'owner',agentId:'review-agent'}]){await assert.rejects(saveReviewerDraft({actor,tokenVersion:2},id,1,input(),now),rejects('forbidden'));await assert.rejects(readReviewerDraft({actor,tokenVersion:2},id),rejects('forbidden'));}
 await assert.rejects(saveReviewerDraft({...context,tokenVersion:1},id,1,input(),now),rejects('forbidden'));
 db.prepare("UPDATE users SET role='admin' WHERE id='draft-owner'").run();await assert.rejects(saveReviewerDraft(context,id,1,input(),now),rejects('forbidden'));db.prepare("UPDATE users SET role='owner' WHERE id='draft-owner'").run();
 assert.equal((await readReviewerDraft(context,id)).revision,1);
});
test('live inactive/unverified/guest/missing-factor reviewers cannot be counted in a saved draft',async()=>{
 for(const person of ['guest-person','no-factor','missing-person'])await assert.rejects(saveReviewerDraft(context,randomUUID(),0,{...input(),reviewerIds:['reviewer-a',person]},now),rejects('ineligible'));
 for(const [column,value,restore] of [['status','suspended','active'],['email_verified',0,1]]){db.prepare('UPDATE users SET '+column+'=? WHERE id=?').run(value,'reviewer-b');await assert.rejects(saveReviewerDraft(context,randomUUID(),0,input(),now),rejects('ineligible'));db.prepare('UPDATE users SET '+column+'=? WHERE id=?').run(restore,'reviewer-b');}
 db.prepare("UPDATE verification_factors SET enabled=0 WHERE user_id='reviewer-b'").run();await assert.rejects(saveReviewerDraft(context,randomUUID(),0,input(),now),rejects('ineligible'));db.prepare("UPDATE verification_factors SET enabled=1 WHERE user_id='reviewer-b'").run();
});
test('stale and concurrent revisions cannot overwrite another owner edit',async()=>{
 const id=randomUUID();await saveReviewerDraft(context,id,0,input(),now);
 const results=await Promise.allSettled(Array.from({length:6},(_,i)=>saveReviewerDraft(context,id,1,{...input(),name:'Edit '+i},now+1)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='conflict').length,5);assert.equal((await readReviewerDraft(context,id)).revision,2);
 await assert.rejects(saveReviewerDraft(context,id,1,input(),now+2),rejects('conflict'));
});
test('storage failure rolls back a policy edit and draft identity remains unchanged',async()=>{
 const id=randomUUID(),saved=await saveReviewerDraft(context,id,0,input(),now);
 db.exec("CREATE TEMP TRIGGER fail_reviewer_edit BEFORE UPDATE ON human_reviewer_drafts BEGIN SELECT RAISE(ABORT,'fixture edit failure'); END");
 await assert.rejects(saveReviewerDraft(context,id,1,{...input(),name:'Should roll back'},now+1),/fixture edit failure/);db.exec('DROP TRIGGER fail_reviewer_edit');assert.deepEqual(await readReviewerDraft(context,id),saved);
});
