import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHash,randomBytes} from 'node:crypto';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'skill-install-proof-'));process.env.AGENT_PLAYER_DATA_DIR=root;process.env.DATABASE_PATH=path.join(root,'fixture.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts'),db=getDatabase();await db.initialize();
db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES('install-owner','install@example.invalid','install-owner','fixture','owner','active',1)").run();
const {CentralSkills}=await import('../src/skills/central-store.ts');await new CentralSkills(root,path.join(root,'library')).initialize();
const {beginEnrollment,activateEnrollment}=await import('../src/auth/verification/enrollment.ts'),{decodeSecret,hotp}=await import('../src/auth/verification/totp.ts');
const now=1800000000000,initial={userId:'install-owner',sessionHash:'a'.repeat(64),tokenVersion:1},setup=await beginEnrollment(initial,now-60000),otp=t=>hotp(decodeSecret(setup.secret),BigInt(Math.floor(t/30000)));await activateEnrollment(initial,otp(now-60000),now-60000);
const context={...initial,tokenVersion:2,factorVersion:1},actor={kind:'user',role:'owner',userId:context.userId};
const {stageSkillReview}=await import('../src/plugins/skill-review-stage.ts'),{issueSkillInstallProof,completeSkillInstallProof}=await import('../src/plugins/skill-install-proof.ts');
const {consumeOperationReceiptStep,skillInstallOperationHash,approvalOperationHash}=await import('../src/auth/verification/operation-proof.ts'),{sql}=await import('../src/repositories/sql-steps.ts');
const raw='---\nname: proof-example\ndescription: Fictional guide\n---\nBody\n',input={provider:'anthropic-skills',commit:'a'.repeat(40),sourcePath:'skills/proof-example',targetName:'proof-example',expectedRevision:0,previousContentHash:null,expectedContentHash:createHash('sha256').update(raw).digest('hex'),content:raw};
const operation=s=>({kind:'skill_install',reviewId:s.id,reviewHash:s.reviewHash,reviewExpiresAt:s.expiresAt,policyVersion:s.policyVersion});
test.after(async()=>{closeDatabase();await fs.rm(root,{recursive:true,force:true});});
test('enrolled owner proof binds exact review; completion does not install or consume the receipt',async()=>{
 const s=await stageSkillReview(context,actor,input,now),challenge=await issueSkillInstallProof(context,actor,s.id,now),proof=await completeSkillInstallProof(context,actor,s.id,challenge.token,otp(now),now);assert.ok(proof);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM central_skills').get().n,0);assert.equal(db.prepare('SELECT consumed_at FROM verification_receipts').get().consumed_at,null);
 assert.equal(await completeSkillInstallProof(context,actor,s.id,challenge.token,otp(now),now),null);
 const consume=o=>sql().tx(()=>consumeOperationReceiptStep(proof.receipt,context,o,now));
 assert.equal(await consume({kind:'tool_approval',approvalId:s.id,paramsHash:s.reviewHash,policyVersion:s.policyVersion}),false);
 for(const patch of [{reviewHash:'b'.repeat(64)},{reviewId:'12345678-1234-1234-1234-123456789012'},{policyVersion:s.policyVersion+1},{reviewExpiresAt:s.expiresAt-1}])assert.equal(await consume({...operation(s),...patch}),false);
 assert.equal(await consume(operation(s)),true);assert.equal(await consume(operation(s)),false);
});
test('server rereads policy, target and expiry before issuing or completing proof',async()=>{
 const t=now+600000,s=await stageSkillReview(context,actor,input,t),challenge=await issueSkillInstallProof(context,actor,s.id,t);
 db.prepare('UPDATE approval_proof_policy SET version=version+1 WHERE id=1').run();await assert.rejects(completeSkillInstallProof(context,actor,s.id,challenge.token,otp(t),t),e=>e.code==='changed');
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM verification_receipts').get().n,1);
 const fresh=await stageSkillReview(context,actor,input,t);await assert.rejects(issueSkillInstallProof(context,actor,fresh.id,t+300000),e=>e.code==='changed');
 await assert.rejects(issueSkillInstallProof({...context,sessionHash:'c'.repeat(64)},actor,fresh.id,t),e=>e.code==='unavailable');
 db.prepare("INSERT INTO central_skills(id,name,description,version,revision,content_hash,origin) VALUES('changed','proof-example','Changed','1',1,?,'fixture')").run('c'.repeat(64));await assert.rejects(issueSkillInstallProof(context,actor,fresh.id,t),e=>e.code==='changed');
});
test('malformed operations and extra capabilities cannot enter the proof domain',()=>{
 const base={kind:'skill_install',reviewId:'12345678-1234-1234-1234-123456789012',reviewHash:'a'.repeat(64),reviewExpiresAt:now+300000,policyVersion:1};
 for(const patch of [{kind:'plugin_install'},{reviewId:'../other'},{reviewHash:'bad'},{reviewExpiresAt:NaN},{policyVersion:0},{enabled:true}])assert.throws(()=>skillInstallOperationHash({...base,...patch}));
 assert.notEqual(skillInstallOperationHash(base),approvalOperationHash({kind:'tool_approval',approvalId:base.reviewId,paramsHash:base.reviewHash,policyVersion:1}));
});
