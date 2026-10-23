import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import Database from 'better-sqlite3';
const {Worker}=await import('node:worker_threads');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'paper-execution-upgrade-review-'));
Object.assign(process.env,{AGENT_PLAYER_DATA_DIR:root,DATABASE_PATH:path.join(root,'main.db'),JWT_SECRET:randomBytes(64).toString('hex'),ENCRYPTION_KEY:randomBytes(32).toString('hex')});delete process.env.AGENT_PLAYER_DB;
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const main=getDatabase();await main.initialize();const db=main.getDb();
const activation=await import('../src/services/trading-paper-bot-activation.ts'),ledger=await import('../src/services/trading-paper-ledger.ts'),execution=await import('../src/services/trading-paper-execution.ts'),bots=await import('../src/services/trading-paper-bots.ts');
const runtime=await import('../src/services/trading-paper-runtime-consent.ts'),dispatch=await import('../src/services/trading-paper-dispatch-attempts.ts');
const catalog=await import('../src/services/trading-paper-manifest-catalog.ts'),upgrade=await import('../src/services/trading-paper-execution-upgrade.ts'),installation=await import('../src/services/trading-paper-installation.ts'),installReview=await import('../src/services/trading-paper-install-review.ts');
const {enrollInstallOwner,reviewedInstall}=await import('./fixtures/reviewed-paper-install.mjs');const now=Date.now();
async function fixture({caps=['paper.account.read','paper.bot.manage'],maxSuccessfulTicks=3}={}){
 const ownerId='target-owner-'+randomUUID();db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'fixture','owner','active',1)").run(ownerId,ownerId+'@example.invalid',ownerId);
 const f=await enrollInstallOwner(ownerId,now-90000);await reviewedInstall(db,f,{now:now-60000,capabilities:caps});const time=now-30000,accountId='account-'+randomUUID(),policyId='policy-'+randomUUID();
 const policy={id:policyId,ownerId,accountId,revision:1,appRevision:1,currency:'USD',enabled:true,mode:'paper',expiresAt:now+86400000,symbols:['AAA'],maxOrder:1000,maxExposure:100000,maxDailyLoss:1000,maxOrders:100,cooldownMs:0,maxQuoteAgeMs:5000};ledger.provisionPaperAccount(db,{policy,cash:100000,exposure:0});execution.configurePaperExecution(db,{ownerId,accountId,revision:1,feeBps:100,slippageBps:0,unitScale:1,currency:'USD'});
 const input={accountId,policyId,policyRevision:1,appRevision:1,expiresAt:time+600000,maxSuccessfulTicks,cooldownMs:1000};
 const stage=await activation.stagePaperBotActivation(db,f.context,f.actor,input,time);assert.equal(stage.ok,true);const challenge=await activation.issuePaperBotActivationProof(db,f.context,f.actor,stage.id,time);assert.ok(challenge?.token);const proof=await activation.completePaperBotActivationProof(db,f.context,f.actor,stage.id,challenge.token,f.otp(time),time);assert.ok(proof?.receipt);assert.equal((await activation.applyPaperBotActivation(db,f.context,f.actor,stage.id,proof.receipt,time)).ok,true);
 return {...f,ownerId,time:now,activationTime:time,policy,input,stage,proof,botId:stage.botId};
}
const request=f=>({botId:f.botId,strategy:{kind:'fixed-paper-order',version:1,symbol:'AAA',side:'buy',amount:1000},limits:{expiresAt:f.input.expiresAt,maxAttempts:3,cadenceMs:1000}});
async function grant(f){const stage=await runtime.stagePaperRuntimeConsent(db,f.context,f.actor,request(f),f.time);assert.equal(stage.ok,true);const challenge=await runtime.issuePaperRuntimeProof(db,f.context,f.actor,stage.id,f.time);assert.ok(challenge);const proof=await runtime.completePaperRuntimeProof(db,f.context,f.actor,stage.id,challenge.token,f.otp(f.time),f.time);assert.ok(proof);const result=await runtime.applyPaperRuntimeConsent(db,f.context,f.actor,stage.id,proof.receipt,f.time);assert.equal(result.ok,true);return {stage,proof,result};}
async function person({install=true}={}){const ownerId='upgrade-owner-'+randomUUID();db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'fixture','owner','active',1)").run(ownerId,ownerId+'@example.invalid',ownerId);const f=await enrollInstallOwner(ownerId,now-90000);if(install)await reviewedInstall(db,f,{now:now-60000});return {...f,ownerId,time:now};}
const candidate=catalog.PAPER_EXECUTION_UPGRADE_CANDIDATE;
const inspect=(f,time=f.time,value={expectedRevision:1,targetManifestDigest:candidate.manifestDigest})=>upgrade.inspectPaperExecutionUpgradeCompatibility(db,f.actor,value,time);
const schema=()=>db.prepare('SELECT name,type,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
const snapshot=f=>({registry:db.prepare('SELECT * FROM paper_installations WHERE owner_id=?').all(f.ownerId),grants:db.prepare('SELECT * FROM paper_install_grants WHERE owner_id=?').all(f.ownerId),consents:db.prepare('SELECT * FROM paper_runtime_consents WHERE owner_id=?').all(f.ownerId),definitions:db.prepare('SELECT * FROM paper_dispatch_definitions WHERE owner_id=?').all(f.ownerId),attempts:db.prepare('SELECT * FROM paper_dispatch_attempts WHERE owner_id=?').all(f.ownerId),events:db.prepare('SELECT * FROM paper_runtime_events WHERE owner_id=?').all(f.ownerId),revocations:db.prepare('SELECT * FROM paper_runtime_revocations WHERE owner_id=?').all(f.ownerId)});
test.after(async()=>{closeDatabase();await fs.rm(root,{recursive:true,force:true});});
const service=await import('../src/services/trading-paper-execution-upgrade-review.ts');
const proofApi=await import('../src/auth/verification/operation-proof.ts');
const {sql}=await import('../src/repositories/sql-steps.ts');
const requestUpgrade={expectedRevision:1,targetManifestDigest:candidate.manifestDigest};
const stage=(f,time=f.time+30000,value=requestUpgrade)=>service.stagePaperExecutionUpgradeReview(db,f.context,f.actor,value,time);
const read=(f,id,time=f.time+30000)=>service.readPaperExecutionUpgradeReview(db,f.context,f.actor,id,time);
async function reviewFixture(){const f=await fixture();runtime.initializePaperRuntimeConsent(db);dispatch.initializePaperDispatchAttempts(db);const g=await grant(f);service.initializePaperExecutionUpgradeReviews(db);return {...f,g,reviewTime:f.time+30000};}
async function upgradeProof(f,r){const challenge=await service.issuePaperExecutionUpgradeProof(db,f.context,f.actor,r.id,f.reviewTime);assert.ok(challenge);const receipt=await service.completePaperExecutionUpgradeProof(db,f.context,f.actor,r.id,challenge.token,f.otp(f.reviewTime),f.reviewTime);assert.ok(receipt);return {challenge,receipt};}
test('explicit storage only; review and actual TOTP proof disclose retained rights without installation or attempt effects',async()=>{
 const f=await reviewFixture(),before=snapshot(f),r=await stage(f);assert.equal(r.ok,true);assert.equal(r.retained.length,1);assert.equal(r.retained[0].botId,f.botId);assert.equal(r.retained[0].strategy.symbol,'AAA');assert.equal(r.retained[0].amountUnit,'account_minor_units');assert.equal(r.retained[0].attemptsConsumed,0);assert.equal(r.startsWorker,false);assert.equal(r.canApply,false);assert.ok(Object.isFrozen(r.retained[0].strategy));assert.deepEqual(snapshot(f),before);
 const p=await upgradeProof(f,r);assert.deepEqual(snapshot(f),before);const receipt=db.prepare('SELECT * FROM verification_receipts WHERE token_hash=?').get(createHash('sha256').update(p.receipt.receipt).digest('hex'));assert.equal(receipt.consumed_at,null);
 assert.equal(await service.completePaperExecutionUpgradeProof(db,f.context,f.actor,r.id,p.challenge.token,f.otp(f.reviewTime),f.reviewTime),null);
 const saved=db.prepare('SELECT * FROM paper_execution_upgrade_reviews WHERE id=?').get(r.id),op={kind:'paper_execution_upgrade',reviewId:r.id,reviewHash:saved.review_hash,reviewExpiresAt:saved.expires_at,policyVersion:saved.policy_version};
 assert.equal(await sql().tx(()=>proofApi.verifyOperationReceiptStep(p.receipt.receipt,f.context,op,f.reviewTime)),true);
 assert.equal(await sql().tx(()=>proofApi.verifyOperationReceiptStep(p.receipt.receipt,f.context,{...op,kind:'paper_app_install'},f.reviewTime)),false);
 assert.equal(JSON.stringify(r).includes('session_hash'),false);assert.equal(JSON.stringify(r).includes('fenceToken'),false);
});
test('actual attempt changes and revoke stale saved review; pending and unknown reject staging without reconciliation',async()=>{
 const f=await reviewFixture(),r=await stage(f),input={definitionId:f.g.result.definitionId,definitionDigest:f.g.result.definitionDigest,attemptKey:'upgrade-pending',leaseMs:1000};const c=dispatch.claimPaperDispatchAttempt(db,f.ownerId,input,f.reviewTime);assert.equal(c.ok,true);
 assert.equal((await read(f,r.id)).ok,false);assert.equal(await service.issuePaperExecutionUpgradeProof(db,f.context,f.actor,r.id,f.reviewTime),null);assert.equal((await stage(f)).ok,false);
 const before=snapshot(f);assert.equal((await stage(f,f.reviewTime+1001)).ok,false);assert.deepEqual(snapshot(f),before);
 dispatch.reconcileExpiredPaperDispatchAttempt(db,f.ownerId,{definitionId:input.definitionId,definitionDigest:input.definitionDigest,attemptKey:input.attemptKey},f.reviewTime+1001);assert.equal((await stage(f,f.reviewTime+1001)).ok,false);
 const g=await reviewFixture(),review=await stage(g);assert.equal(runtime.revokePaperRuntimeConsent(db,g.actor,g.g.result.consentId,g.reviewTime).ok,true);assert.equal((await read(g,review.id)).ok,false);assert.equal((await stage(g)).ok,true);
});
test('current session, token, factor and proof policy bind read and proof; no lazy init, getters, TEMP, foreign or query-only',async()=>{
 const f=await reviewFixture(),r=await stage(f),challenge=await service.issuePaperExecutionUpgradeProof(db,f.context,f.actor,r.id,f.reviewTime);assert.ok(challenge);assert.equal((await service.readPaperExecutionUpgradeReview(db,{...f.context,sessionHash:'e'.repeat(64)},f.actor,r.id,f.reviewTime)).ok,false);
 for(const [query,restore,args] of [
 ['UPDATE users SET token_version=token_version+1 WHERE id=?','UPDATE users SET token_version=? WHERE id=?',[f.context.tokenVersion,f.ownerId]],
 ['UPDATE verification_factors SET version=version+1 WHERE user_id=?','UPDATE verification_factors SET version=? WHERE user_id=?',[f.context.factorVersion,f.ownerId]],
 ['UPDATE approval_proof_policy SET version=version+1 WHERE id=1','UPDATE approval_proof_policy SET version=? WHERE id=1',[db.prepare('SELECT version FROM approval_proof_policy WHERE id=1').get().version]]
 ]){query.includes('WHERE id=1')?db.prepare(query).run():db.prepare(query).run(f.ownerId);try{assert.equal((await read(f,r.id)).ok,false);assert.equal(await service.issuePaperExecutionUpgradeProof(db,f.context,f.actor,r.id,f.reviewTime),null);assert.equal(await service.completePaperExecutionUpgradeProof(db,f.context,f.actor,r.id,challenge.token,f.otp(f.reviewTime),f.reviewTime),null);}finally{db.prepare(restore).run(...args);}}
 const foreign=new Database(process.env.DATABASE_PATH);try{assert.equal((await service.stagePaperExecutionUpgradeReview(foreign,f.context,f.actor,requestUpgrade,f.reviewTime)).ok,false);}finally{foreign.close();}
 let calls=0;const getter={...requestUpgrade};Object.defineProperty(getter,'expectedRevision',{enumerable:true,get(){calls++;return 1;}});assert.equal((await stage(f,f.reviewTime,getter)).ok,false);assert.equal(calls,0);
 db.exec('CREATE TEMP VIEW USERS AS SELECT * FROM main.users');try{assert.equal((await read(f,r.id)).ok,false);}finally{db.exec('DROP VIEW temp.USERS');}
 db.pragma('query_only=ON');try{const before=db.prepare('SELECT total_changes() n').get().n;assert.equal((await read(f,r.id)).ok,true);assert.equal((await stage(f)).ok,false);assert.equal(await service.issuePaperExecutionUpgradeProof(db,f.context,f.actor,r.id,f.reviewTime),null);assert.equal(await service.completePaperExecutionUpgradeProof(db,f.context,f.actor,r.id,challenge.token,f.otp(f.reviewTime),f.reviewTime),null);assert.equal(db.prepare('SELECT total_changes() n').get().n,before);}finally{db.pragma('query_only=OFF');}
 assert.equal((await read(f,r.id,f.reviewTime+300000)).ok,false);
});

test('strict staging captures caller input before await, caps active reviews, expires and never creates business schemas',async()=>{
 const f=await reviewFixture(),value={...requestUpgrade},promise=stage(f,f.reviewTime,value);value.expectedRevision=99;assert.equal((await promise).ok,true);
 for(let i=1;i<8;i++)assert.equal((await stage(f)).ok,true);assert.equal((await stage(f)).ok,false);
 assert.equal((await stage(f,f.reviewTime+300000)).ok,true);
 assert.equal((await stage(f,f.reviewTime,{...requestUpgrade,capabilities:['paper.runtime.execute']})).ok,false);
 assert.equal(typeof service.applyPaperExecutionUpgrade,'undefined');
});
test('an additional genuinely reviewed owner consent invalidates the staged affected set',async()=>{
 const f=await reviewFixture(),r=await stage(f),at=f.reviewTime+30000;
 const a=await activation.stagePaperBotActivation(db,f.context,f.actor,f.input,at);assert.equal(a.ok,true);
 const ac=await activation.issuePaperBotActivationProof(db,f.context,f.actor,a.id,at);assert.ok(ac);
 const ap=await activation.completePaperBotActivationProof(db,f.context,f.actor,a.id,ac.token,f.otp(at),at);assert.ok(ap);
 assert.equal((await activation.applyPaperBotActivation(db,f.context,f.actor,a.id,ap.receipt,at)).ok,true);
 const t=at+30000,second={...f,botId:a.botId,time:t};await grant(second);
 assert.equal((await read(f,r.id,t)).ok,false);assert.equal(await service.issuePaperExecutionUpgradeProof(db,f.context,f.actor,r.id,t),null);
 const fresh=await stage(f,t);assert.equal(fresh.ok,true);assert.equal(fresh.retained.length,2);
});
