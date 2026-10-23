import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'paper-account-proof-'));
process.env.AGENT_PLAYER_DATA_DIR=root;process.env.DATABASE_PATH=path.join(root,'fixture.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts'),db=getDatabase();await db.initialize();
db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES('account-proof-owner','account-proof@example.invalid','account-proof-owner','fixture','owner','active',1)").run();
const {beginEnrollment,activateEnrollment}=await import('../src/auth/verification/enrollment.ts');
const {decodeSecret,hotp}=await import('../src/auth/verification/totp.ts');
const {paperAppInstallOperationHash,paperAccountSetupOperationHash,paperBotActivationOperationHash,skillInstallOperationHash,approvalOperationHash,scheduleAuthorizationOperationHash,issueOperationChallenge,completeOperationChallenge,verifyOperationReceiptStep,consumeOperationReceiptStep}=await import('../src/auth/verification/operation-proof.ts');
const {sql}=await import('../src/repositories/sql-steps.ts');
const now=1800000000000,initial={userId:'account-proof-owner',sessionHash:'a'.repeat(64),tokenVersion:1},setup=await beginEnrollment(initial,now-60000);
const otp=time=>hotp(decodeSecret(setup.secret),BigInt(Math.floor(time/30000)));const enrollment=await activateEnrollment(initial,otp(now-60000),now-60000);assert.equal(enrollment?.factorVersion,1);
const context={...initial,tokenVersion:2,factorVersion:1};
const operation=time=>({kind:'paper_account_setup',reviewId:randomUUID(),reviewHash:'b'.repeat(64),reviewExpiresAt:time+300000,policyVersion:1});
const verify=(receipt,op,time,ctx=context)=>sql().tx(()=>verifyOperationReceiptStep(receipt,ctx,op,time));
const consume=(receipt,op,time,ctx=context)=>sql().tx(()=>consumeOperationReceiptStep(receipt,ctx,op,time));
async function proof(op,time){const challenge=await issueOperationChallenge(context,op,time);const receipt=await completeOperationChallenge(challenge.token,context,op,otp(time),time);assert.ok(receipt);return {challenge,...receipt};}
test.after(async()=>{closeDatabase();await fs.rm(root,{recursive:true,force:true});});
test('exact plain account setup operation has an isolated domain and refuses extra or borrowed capabilities',()=>{
 const base=operation(now);for(const patch of [{kind:'skill_install'},{reviewId:'../bad'},{reviewHash:'bad'},{reviewId:base.reviewId+'\n'},{reviewHash:base.reviewHash+'\n'},{reviewExpiresAt:NaN},{reviewExpiresAt:-1},{policyVersion:0},{policyVersion:1.5},{side:'buy'}])assert.throws(()=>paperAccountSetupOperationHash({...base,...patch}));
 assert.throws(()=>paperAccountSetupOperationHash(Object.assign(Object.create({extra:true}),base)));assert.throws(()=>paperAccountSetupOperationHash({...base,[Symbol('hidden')]:true}));const hidden={...base};Object.defineProperty(hidden,'extra',{value:true});assert.throws(()=>paperAccountSetupOperationHash(hidden));let calls=0;const getter={...base};Object.defineProperty(getter,'reviewHash',{enumerable:true,get(){calls++;return base.reviewHash;}});assert.throws(()=>paperAccountSetupOperationHash(getter));assert.equal(calls,0);
 assert.notEqual(paperAccountSetupOperationHash(base),paperAppInstallOperationHash({...base,kind:'paper_app_install'}));
 assert.notEqual(paperAccountSetupOperationHash(base),paperBotActivationOperationHash({...base,kind:'paper_bot_activation'}));
 assert.notEqual(paperAccountSetupOperationHash(base),skillInstallOperationHash({...base,kind:'skill_install'}));assert.notEqual(paperAccountSetupOperationHash(base),approvalOperationHash({kind:'tool_approval',approvalId:base.reviewId,paramsHash:base.reviewHash,policyVersion:1}));
 assert.notEqual(paperAccountSetupOperationHash(base),scheduleAuthorizationOperationHash({kind:'schedule_authorization',jobId:base.reviewId,jobRevision:1,authorizationRevision:0,definitionHash:base.reviewHash,authorizationExpiresAt:base.reviewExpiresAt,policyVersion:1}));
});
test('real owner TOTP account setup proof binds review, context and versions; completion creates no account setup grants or paper effects',async()=>{
 const op=operation(now),before=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'paper_%' ORDER BY name").all(),p=await proof(op,now);
 assert.equal(await verify(p.receipt,op,now),true);assert.equal(db.prepare('SELECT consumed_at FROM verification_receipts').get().consumed_at,null);assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'paper_%' ORDER BY name").all(),before);assert.equal(await completeOperationChallenge(p.challenge.token,context,op,otp(now),now),null);
 for(const patch of [{reviewId:randomUUID()},{reviewHash:'c'.repeat(64)},{reviewExpiresAt:op.reviewExpiresAt-1},{policyVersion:2}])assert.equal(await consume(p.receipt,{...op,...patch},now),false);
 for(const patch of [{userId:'other-owner'},{sessionHash:'d'.repeat(64)},{tokenVersion:3},{factorVersion:2}])assert.equal(await verify(p.receipt,op,now,{...context,...patch}),false);
 assert.equal(await consume(p.receipt,op,now),true);assert.equal(await consume(p.receipt,op,now),false);assert.equal(await verify(p.receipt,op,now),false);
});
test('account setup receipts and bot skill tool schedule receipts cannot cross domains in either direction',async()=>{
 const time=now+30000,op=operation(time),bot=await proof(op,time),skill={...op,kind:'skill_install'},tool={kind:'tool_approval',approvalId:op.reviewId,paramsHash:op.reviewHash,policyVersion:1},schedule={kind:'schedule_authorization',jobId:op.reviewId,jobRevision:1,authorizationRevision:0,definitionHash:op.reviewHash,authorizationExpiresAt:op.reviewExpiresAt,policyVersion:1};
 for(const other of [{...op,kind:'paper_app_install'},{...op,kind:'paper_bot_activation'},skill,tool,schedule])assert.equal(await consume(bot.receipt,other,time),false);
 for(const [i,kind] of ['install','bot','skill','tool','schedule'].entries()){const at=time+(i+1)*30000,base=operation(at),other=kind==='install'?{...base,kind:'paper_app_install'}:kind==='bot'?{...base,kind:'paper_bot_activation'}:kind==='skill'?{...base,kind:'skill_install'}:kind==='tool'?{kind:'tool_approval',approvalId:base.reviewId,paramsHash:base.reviewHash,policyVersion:1}:{kind:'schedule_authorization',jobId:base.reviewId,jobRevision:1,authorizationRevision:0,definitionHash:base.reviewHash,authorizationExpiresAt:base.reviewExpiresAt,policyVersion:1};const p=await proof(other,at);assert.equal(await consume(p.receipt,base,at),false);assert.equal(await consume(p.receipt,other,at),true);}
 assert.equal(await consume(bot.receipt,op,time),true);
});
test('review expiry and five-minute bounds cannot issue or complete authority; receipt expires separately',async()=>{
 const time=now+240000;
 for(const expiresAt of [time,time-1,time+300001])await assert.rejects(issueOperationChallenge(context,{...operation(time),reviewExpiresAt:expiresAt},time));
 const op=operation(time),p=await proof(op,time);assert.equal(await verify(p.receipt,op,time+120000),false);assert.equal(await consume(p.receipt,op,time+120000),false);
 await assert.rejects(verify(p.receipt,op,op.reviewExpiresAt));await assert.rejects(consume(p.receipt,op,op.reviewExpiresAt));
 const later=time+30000,short={...operation(later),reviewExpiresAt:later+1},challenge=await issueOperationChallenge(context,short,later);await assert.rejects(completeOperationChallenge(challenge.token,context,short,otp(later),later+1));
});
test('factor revocation and token-version rotation invalidate issued account setup receipts',async()=>{
 const time=now+300000,op=operation(time),p=await proof(op,time);db.prepare('UPDATE verification_factors SET enabled=0,version=version+1 WHERE user_id=?').run(context.userId);assert.equal(await verify(p.receipt,op,time),false);assert.equal(await consume(p.receipt,op,time),false);await assert.rejects(issueOperationChallenge(context,op,time));db.prepare('UPDATE verification_factors SET enabled=1,version=1 WHERE user_id=?').run(context.userId);db.prepare('UPDATE users SET token_version=3 WHERE id=?').run(context.userId);assert.equal(await verify(p.receipt,op,time),false);assert.equal(await consume(p.receipt,op,time),false);
});
