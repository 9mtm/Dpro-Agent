import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes,createHash} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'ap-operation-proof-'));process.env.DATABASE_PATH=join(dir,'test.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES('proof-user','proof@example.test','proof','x','user','active',1)").run();
const {beginEnrollment,activateEnrollment}=await import('../src/auth/verification/enrollment.ts');const {decodeSecret,hotp}=await import('../src/auth/verification/totp.ts');
const time=1800000000000;const setup=await beginEnrollment({userId:'proof-user',sessionHash:'a'.repeat(64),tokenVersion:1},time-60000);
const otp=now=>hotp(decodeSecret(setup.secret),BigInt(Math.floor(now/30000)));
await activateEnrollment({userId:'proof-user',sessionHash:'a'.repeat(64),tokenVersion:1},otp(time-60000),time-60000);
const {issueOperationChallenge,completeOperationChallenge,consumeOperationReceiptStep,approvalOperationHash}=await import('../src/auth/verification/operation-proof.ts');
const {sql,run}=await import('../src/repositories/sql-steps.ts');
test.after(()=>closeDatabase());
const context={userId:'proof-user',sessionHash:'b'.repeat(64),tokenVersion:2,factorVersion:1};
const operation={kind:'tool_approval',approvalId:'12345678-1234-1234-1234-123456789012',paramsHash:'c'.repeat(64),policyVersion:0};
const consume=(receipt,c=context,o=operation,now=time)=>sql().tx(()=>consumeOperationReceiptStep(receipt,c,o,now));
async function proof(now){const challenge=await issueOperationChallenge(context,operation,now);return completeOperationChallenge(challenge.token,context,operation,otp(now),now);}
test('operation proof stores only verifier and does not execute or confer authority',async()=>{
 const result=await proof(time);assert.ok(result);assert.equal(result.expiresAt,time+120000);
 const rows=db.prepare('SELECT * FROM verification_receipts').all();assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes(result.receipt));assert.equal(rows[0].token_hash,createHash('sha256').update(result.receipt).digest('hex'));
 for(const change of [{sessionHash:'d'.repeat(64)},{tokenVersion:3},{factorVersion:2},{userId:'other'}])assert.equal(await consume(result.receipt,{...context,...change}),false);
 for(const change of [{approvalId:'22345678-1234-1234-1234-123456789012'},{paramsHash:'d'.repeat(64)},{policyVersion:1}])assert.equal(await consume(result.receipt,context,{...operation,...change}),false);
 assert.equal(await consume(result.receipt,context,operation,result.expiresAt),false);
 assert.equal(await consume(result.receipt),true);assert.equal(await consume(result.receipt),false);
});
test('TOTP challenge cannot be replayed or completed for different operation',async()=>{
 const now=time+600000,challenge=await issueOperationChallenge(context,operation,now);
 assert.equal(await completeOperationChallenge(challenge.token,context,{...operation,policyVersion:1},otp(now),now),null);
 assert.ok(await completeOperationChallenge(challenge.token,context,operation,otp(now),now));
 assert.equal(await completeOperationChallenge(challenge.token,context,operation,otp(now),now),null);
});
test('receipt and harmless action claim roll back together, concurrent claims consume once',async()=>{
 const now=time+1200000,result=await proof(now);assert.ok(result);
 db.exec('CREATE TABLE fixture_action(claims INTEGER NOT NULL)');db.exec('INSERT INTO fixture_action VALUES(0)');
 await assert.rejects(sql().tx(function*(){assert.equal(yield* consumeOperationReceiptStep(result.receipt,context,operation,now),true);yield* run('UPDATE fixture_action SET claims=claims+1');throw Error('fixture action failure');}),/fixture action failure/);
 assert.equal(db.prepare('SELECT claims FROM fixture_action').get().claims,0);
 const decisions=await Promise.all(Array.from({length:8},()=>sql().tx(function*(){if(!(yield* consumeOperationReceiptStep(result.receipt,context,operation,now)))return false;yield* run('UPDATE fixture_action SET claims=claims+1');return true;})));
 assert.equal(decisions.filter(Boolean).length,1);assert.equal(db.prepare('SELECT claims FROM fixture_action').get().claims,1);
});
test('factor and account revocation invalidate outstanding receipts',async()=>{
 const now=time+1800000,result=await proof(now);assert.ok(result);
 db.prepare("UPDATE verification_factors SET enabled=0 WHERE user_id='proof-user'").run();assert.equal(await consume(result.receipt,context,operation,now),false);
 db.prepare("UPDATE verification_factors SET enabled=1 WHERE user_id='proof-user'").run();db.prepare("UPDATE users SET token_version=3 WHERE id='proof-user'").run();assert.equal(await consume(result.receipt,context,operation,now),false);
 await assert.rejects(issueOperationChallenge(context,operation,now),/context changed/);
});
test('unknown action kinds and malformed fingerprints fail closed',()=>{
 for(const change of [{kind:'terminal'},{approvalId:'../other'},{paramsHash:'x'},{policyVersion:-1},{policyVersion:NaN}])assert.throws(()=>approvalOperationHash({...operation,...change}));
});
