import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes,randomUUID} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'ap-approval-proof-'));process.env.DATABASE_PATH=join(dir,'test.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
for(const [id,role] of [['proof-owner','owner'],['proof-admin','admin']])db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'x',?,'active',1)").run(id,id+'@example.test',id,role);
const {beginEnrollment,activateEnrollment}=await import('../src/auth/verification/enrollment.ts');const {decodeSecret,hotp}=await import('../src/auth/verification/totp.ts');
const base=1800000000000,setupBinding={userId:'proof-owner',sessionHash:'a'.repeat(64),tokenVersion:1};const pending=await beginEnrollment(setupBinding,base-60000);
const otp=time=>hotp(decodeSecret(pending.secret),BigInt(Math.floor(time/30000)));
await activateEnrollment(setupBinding,otp(base-60000),base-60000);
const {issueApprovalProofChallenge,completeApprovalProofChallenge,claimApprovalWithReceiptStep}=await import('../src/auth/verification/approval-proof.ts');
const {sql}=await import('../src/repositories/sql-steps.ts');test.after(()=>closeDatabase());
const context={userId:'proof-owner',sessionHash:'b'.repeat(64),tokenVersion:2,factorVersion:1},paramsHash='c'.repeat(64);
function approval(time=base){const id=randomUUID();db.prepare("INSERT INTO tool_approvals(id,status,tool_name,params_encrypted,params_iv,params_tag,params_hash,requested_at) VALUES(?,'pending','fixture_tool','fixture','fixture','fixture',?,?)").run(id,paramsHash,new Date(time).toISOString().slice(0,19).replace('T',' '));return id;}
async function proof(id,time){const challenge=await issueApprovalProofChallenge(context,id,paramsHash,time);return completeApprovalProofChallenge(challenge.token,context,id,paramsHash,otp(time),time);}
const claim=(receipt,id,time)=>sql().tx(()=>claimApprovalWithReceiptStep(receipt,context,id,paramsHash,time));
test('actual pending row and current policy/target bind the challenge and receipt',async()=>{
 const time=base,id=approval(time),challenge=await issueApprovalProofChallenge(context,id,paramsHash,time);
 db.prepare('UPDATE tool_approvals SET tool_name=? WHERE id=?').run('changed_tool',id);
 assert.equal(await completeApprovalProofChallenge(challenge.token,context,id,paramsHash,otp(time),time),null);
 const fresh=await issueApprovalProofChallenge(context,id,paramsHash,time),receipt=await completeApprovalProofChallenge(fresh.token,context,id,paramsHash,otp(time),time);assert.ok(receipt);
 db.prepare('UPDATE approval_proof_policy SET version=version+1 WHERE id=1').run();
 assert.equal(await claim(receipt.receipt,id,time),false);assert.equal(db.prepare('SELECT status FROM tool_approvals WHERE id=?').get(id).status,'pending');
});
test('changed parameters, non-pending state and expiry cannot reuse proof',async()=>{
 const time=base+600000,id=approval(time),receipt=await proof(id,time);assert.ok(receipt);
 db.prepare('UPDATE tool_approvals SET params_hash=? WHERE id=?').run('d'.repeat(64),id);await assert.rejects(claim(receipt.receipt,id,time),/request changed/);
 const denied=approval(time);db.prepare("UPDATE tool_approvals SET status='denied' WHERE id=?").run(denied);await assert.rejects(issueApprovalProofChallenge(context,denied,paramsHash,time),/request changed/);
 const old=approval(time-86400000);await assert.rejects(issueApprovalProofChallenge(context,old,paramsHash,time),/expired/);
});
test('proof and actual approval CAS roll back together on storage failure',async()=>{
 const time=base+1200000,id=approval(time),receipt=await proof(id,time);assert.ok(receipt);
 db.exec("CREATE TEMP TRIGGER fail_approval_claim BEFORE UPDATE OF status ON tool_approvals WHEN NEW.status='approved' BEGIN SELECT RAISE(ABORT,'fixture claim failure'); END");
 await assert.rejects(claim(receipt.receipt,id,time),/fixture claim failure/);
 assert.equal(db.prepare('SELECT status FROM tool_approvals WHERE id=?').get(id).status,'pending');
 db.exec('DROP TRIGGER fail_approval_claim');assert.equal(await claim(receipt.receipt,id,time),true);
 assert.equal(db.prepare('SELECT decided_by FROM tool_approvals WHERE id=?').get(id).decided_by,context.userId);
});
test('concurrent real approval claims accept exactly once without executing a tool',async()=>{
 const time=base+1800000,id=approval(time),receipt=await proof(id,time);assert.ok(receipt);
 const results=await Promise.allSettled(Array.from({length:8},()=>claim(receipt.receipt,id,time)));
 assert.equal(results.filter(result=>result.status==='fulfilled'&&result.value===true).length,1);
 assert.equal(db.prepare('SELECT executed_at FROM tool_approvals WHERE id=?').get(id).executed_at,null);
});
test('administrator and revoked owner authority cannot issue or consume approval proof',async()=>{
 const time=base+2400000,id=approval(time),receipt=await proof(id,time);assert.ok(receipt);
 await assert.rejects(issueApprovalProofChallenge({...context,userId:'proof-admin',tokenVersion:1},id,paramsHash,time),/Owner approval context changed/);
 db.prepare("UPDATE users SET role='admin' WHERE id='proof-owner'").run();await assert.rejects(claim(receipt.receipt,id,time),/Owner approval context changed/);
 assert.equal(db.prepare('SELECT status FROM tool_approvals WHERE id=?').get(id).status,'pending');
});
