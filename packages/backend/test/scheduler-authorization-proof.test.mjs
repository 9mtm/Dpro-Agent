// Separate proof primitive only: no scheduler authorization row or execution is granted here.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes,randomUUID} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'ap-schedule-proof-'));process.env.DATABASE_PATH=join(dir,'test.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES('schedule-owner','schedule-owner@example.test','Schedule owner','x','owner','active',1)").run();
const {beginEnrollment,activateEnrollment}=await import('../src/auth/verification/enrollment.ts'),{decodeSecret,hotp}=await import('../src/auth/verification/totp.ts');
const base=1800000000000,context={userId:'schedule-owner',sessionHash:'a'.repeat(64),tokenVersion:2,factorVersion:1},initial={...context,tokenVersion:1};
const enrollment=await beginEnrollment(initial,base-60000),otp=when=>hotp(decodeSecret(enrollment.secret),BigInt(Math.floor(when/30000)));await activateEnrollment(initial,otp(base-60000),base-60000);
const {scheduleAuthorizationOperationHash,approvalOperationHash,reviewerPolicyOperationHash,issueOperationChallenge,completeOperationChallenge,consumeOperationReceiptStep}=await import('../src/auth/verification/operation-proof.ts');
const {sql,run}=await import('../src/repositories/sql-steps.ts');test.after(()=>closeDatabase());
const operation={kind:'schedule_authorization',jobId:randomUUID(),jobRevision:1,authorizationRevision:0,definitionHash:'b'.repeat(64),authorizationExpiresAt:base+86400000,policyVersion:1};
const tool={kind:'tool_approval',approvalId:operation.jobId,paramsHash:operation.definitionHash,policyVersion:1};
const consume=(receipt,op=operation,ctx=context,now=base)=>sql().tx(()=>consumeOperationReceiptStep(receipt,ctx,op,now));
async function proof(now){const challenge=await issueOperationChallenge(context,operation,now);return completeOperationChallenge(challenge.token,context,operation,otp(now),now);}
test('schedule fingerprint is separate from tool and rule authority and rejects identity/expiry injection',()=>{
 assert.notEqual(scheduleAuthorizationOperationHash(operation),approvalOperationHash(tool));assert.notEqual(scheduleAuthorizationOperationHash(operation),reviewerPolicyOperationHash({kind:'reviewer_policy',action:'activate',policyId:operation.jobId,draftRevision:1,paramsHash:operation.definitionHash,policyVersion:1}));
 for(const change of [{jobId:randomUUID()},{jobRevision:2},{authorizationRevision:1},{definitionHash:'c'.repeat(64)},{authorizationExpiresAt:base+3600000},{policyVersion:2}])assert.notEqual(scheduleAuthorizationOperationHash({...operation,...change}),scheduleAuthorizationOperationHash(operation));
 for(const change of [{userId:'other'},{verified:true},{actor:{role:'owner'}},{jobRevision:0},{jobRevision:'1'},{authorizationExpiresAt:NaN},{authorizationExpiresAt:-1},{definitionHash:'raw'},{policyVersion:0}])assert.throws(()=>scheduleAuthorizationOperationHash({...operation,...change}));
});
test('real challenge cannot cross domains; proof does not create or execute jobs',async()=>{
 const issued=await issueOperationChallenge(context,operation,base);assert.equal(await completeOperationChallenge(issued.token,context,tool,otp(base),base),null);
 const result=await completeOperationChallenge(issued.token,context,operation,otp(base),base);assert.ok(result);assert.equal(result.expiresAt,base+120000);
 assert.equal(await consume(result.receipt,tool),false);for(const change of [{jobId:randomUUID()},{jobRevision:2},{authorizationRevision:1},{definitionHash:'c'.repeat(64)},{authorizationExpiresAt:operation.authorizationExpiresAt+1},{policyVersion:2}])assert.equal(await consume(result.receipt,{...operation,...change}),false);
 assert.equal(await consume(result.receipt,operation,{...context,sessionHash:'d'.repeat(64)}),false);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cron_jobs').get().n,0);assert.equal(await consume(result.receipt),true);assert.equal(await consume(result.receipt),false);
});
test('schedule receipt rolls back with failed state claim and concurrent consumption wins once',async()=>{
 const now=base+600000,result=await proof(now);assert.ok(result);db.exec('CREATE TABLE fixture_schedule_claim(n INTEGER NOT NULL)');db.exec('INSERT INTO fixture_schedule_claim VALUES(0)');
 await assert.rejects(sql().tx(function*(){assert.equal(yield* consumeOperationReceiptStep(result.receipt,context,operation,now),true);yield* run('UPDATE fixture_schedule_claim SET n=n+1');throw Error('fixture claim failed');}),/fixture claim failed/);assert.equal(db.prepare('SELECT n FROM fixture_schedule_claim').get().n,0);
 const all=await Promise.all(Array.from({length:8},()=>sql().tx(function*(){if(!(yield* consumeOperationReceiptStep(result.receipt,context,operation,now)))return false;yield* run('UPDATE fixture_schedule_claim SET n=n+1');return true;})));assert.equal(all.filter(Boolean).length,1);assert.equal(db.prepare('SELECT n FROM fixture_schedule_claim').get().n,1);
});
test('expired, revoked-factor and revoked-account schedule proofs cannot be consumed',async()=>{
 const now=base+1200000,result=await proof(now);assert.ok(result);assert.equal(await consume(result.receipt,operation,context,result.expiresAt),false);
 db.prepare("UPDATE verification_factors SET enabled=0 WHERE user_id='schedule-owner'").run();assert.equal(await consume(result.receipt,operation,context,now),false);db.prepare("UPDATE verification_factors SET enabled=1 WHERE user_id='schedule-owner'").run();db.prepare("UPDATE users SET token_version=3 WHERE id='schedule-owner'").run();assert.equal(await consume(result.receipt,operation,context,now),false);
});


test('schedule consent expiry is bounded before proof admission',async()=>{
 for(const authorizationExpiresAt of [base,base-1,base+7776000001])await assert.rejects(issueOperationChallenge(context,{...operation,authorizationExpiresAt},base),/scheduled authorization expiry/);
});
