import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {spawn} from 'node:child_process';
const {Worker}=await import('node:worker_threads');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'paper-execution-overlay-'));
Object.assign(process.env,{AGENT_PLAYER_DATA_DIR:root,DATABASE_PATH:path.join(root,'main.db'),JWT_SECRET:randomBytes(64).toString('hex'),ENCRYPTION_KEY:randomBytes(32).toString('hex')});delete process.env.AGENT_PLAYER_DB;
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const main=getDatabase();await main.initialize();const db=main.getDb();
const activation=await import('../src/services/trading-paper-bot-activation.ts'),ledger=await import('../src/services/trading-paper-ledger.ts'),execution=await import('../src/services/trading-paper-execution.ts'),bots=await import('../src/services/trading-paper-bots.ts');
const dispatcher=await import('../src/services/trading-paper-runtime-dispatch.ts');
const runtime=await import('../src/services/trading-paper-runtime-consent.ts'),dispatch=await import('../src/services/trading-paper-dispatch-attempts.ts');
const {enrollInstallOwner,reviewedInstall}=await import('./fixtures/reviewed-paper-install.mjs');const now=Date.now();
async function fixture({caps=['paper.account.read','paper.bot.manage'],maxSuccessfulTicks=3,maxDailyLoss=1000}={}){
 const ownerId='target-owner-'+randomUUID();db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'fixture','owner','active',1)").run(ownerId,ownerId+'@example.invalid',ownerId);
 const f=await enrollInstallOwner(ownerId,now-90000);await reviewedInstall(db,f,{now:now-60000,capabilities:caps});const time=now-30000,accountId='account-'+randomUUID(),policyId='policy-'+randomUUID();
 const policy={id:policyId,ownerId,accountId,revision:1,appRevision:1,currency:'USD',enabled:true,mode:'paper',expiresAt:now+86400000,symbols:['AAA'],maxOrder:1000,maxExposure:100000,maxDailyLoss,maxOrders:100,cooldownMs:0,maxQuoteAgeMs:5000};ledger.provisionPaperAccount(db,{policy,cash:100000,exposure:0});execution.configurePaperExecution(db,{ownerId,accountId,revision:1,feeBps:100,slippageBps:0,unitScale:1,currency:'USD'});
 const input={accountId,policyId,policyRevision:1,appRevision:1,expiresAt:time+600000,maxSuccessfulTicks,cooldownMs:1000};
 const stage=await activation.stagePaperBotActivation(db,f.context,f.actor,input,time);assert.equal(stage.ok,true);const challenge=await activation.issuePaperBotActivationProof(db,f.context,f.actor,stage.id,time);assert.ok(challenge?.token);const proof=await activation.completePaperBotActivationProof(db,f.context,f.actor,stage.id,challenge.token,f.otp(time),time);assert.ok(proof?.receipt);assert.equal((await activation.applyPaperBotActivation(db,f.context,f.actor,stage.id,proof.receipt,time)).ok,true);
 return {...f,ownerId,time:now,activationTime:time,policy,input,stage,proof,botId:stage.botId};
}
const request=f=>({botId:f.botId,strategy:{kind:'fixed-paper-order',version:1,symbol:'AAA',side:'buy',amount:1000},limits:{expiresAt:f.input.expiresAt,maxAttempts:3,cadenceMs:1000}});
async function grant(f,value=request(f)){
 const staged=await runtime.stagePaperRuntimeConsent(db,f.context,f.actor,value,f.time);assert.equal(staged.ok,true);const challenge=await runtime.issuePaperRuntimeProof(db,f.context,f.actor,staged.id,f.time);assert.ok(challenge);const proof=await runtime.completePaperRuntimeProof(db,f.context,f.actor,staged.id,challenge.token,f.otp(f.time),f.time);assert.ok(proof);const applied=await runtime.applyPaperRuntimeConsent(db,f.context,f.actor,staged.id,proof.receipt,f.time);assert.equal(applied.ok,true);return applied;
}
const run=(consentId,attemptKey,time)=>dispatcher.dispatchPaperRuntimeAttempt(db,{consentId,attemptKey},time);
const quote=(f,time=f.time,revision=1,priceMinor=100)=>execution.recordPaperExecutionQuote(db,{accountId:f.input.accountId,symbol:'AAA',priceMinor,quotedAt:time,revision,currency:'USD',unitScale:1});
const state=f=>({account:db.prepare('SELECT * FROM paper_accounts WHERE account_id=?').get(f.input.accountId),positions:db.prepare('SELECT * FROM paper_positions WHERE account_id=?').all(f.input.accountId),fills:db.prepare('SELECT * FROM paper_fills WHERE account_id=?').all(f.input.accountId),sells:db.prepare('SELECT * FROM paper_sell_fills WHERE account_id=?').all(f.input.accountId),reservations:db.prepare('SELECT * FROM paper_reservations WHERE account_id=?').all(f.input.accountId),sellReservations:db.prepare('SELECT * FROM paper_sell_reservations WHERE account_id=?').all(f.input.accountId),bot:db.prepare('SELECT * FROM paper_bots WHERE bot_id=?').get(f.botId)});
test.after(async()=>{closeDatabase();await fs.rm(root,{recursive:true,force:true});});
const review=await import('../src/services/trading-paper-execution-upgrade-review.ts');
const cycle=await import('../src/services/trading-paper-runtime-cycle.ts');
const overlay=await import('../src/services/trading-paper-execution-upgrade-apply.ts');
const installation=await import('../src/services/trading-paper-installation.ts');
const {PAPER_EXECUTION_UPGRADE_CANDIDATE}=await import('../src/services/trading-paper-manifest-catalog.ts');
runtime.initializePaperRuntimeConsent(db);dispatch.initializePaperDispatchAttempts(db);review.initializePaperExecutionUpgradeReviews(db);overlay.initializePaperExecutionUpgradeApplications(db);
async function ready({filled=false,revoked=false,expired=false,maxSuccessfulTicks=3}={}){
 const f=await fixture({maxSuccessfulTicks}),g=await grant(f,expired?{...request(f),limits:{...request(f).limits,expiresAt:f.time+10000}}:request(f)),time=f.time+30000;
 if(filled){assert.equal(cycle.dispatchDuePaperRuntimeConsent(db,{consentId:g.consentId},f.time).status,'failed');quote(f,f.time+1000,1);assert.equal(cycle.dispatchDuePaperRuntimeConsent(db,{consentId:g.consentId},f.time+1000).status,'completed');quote(f,time,2);}
 if(revoked)assert.equal(runtime.revokePaperRuntimeConsent(db,f.actor,g.consentId,f.time+10000).ok,true);
 const upgradeRequest={expectedRevision:1,targetManifestDigest:PAPER_EXECUTION_UPGRADE_CANDIDATE.manifestDigest};
 const r=await review.stagePaperExecutionUpgradeReview(db,f.context,f.actor,upgradeRequest,time);assert.equal(r.ok,true);
 const challenge=await review.issuePaperExecutionUpgradeProof(db,f.context,f.actor,r.id,time);assert.ok(challenge);
 const proof=await review.completePaperExecutionUpgradeProof(db,f.context,f.actor,r.id,challenge.token,f.otp(time),time);assert.ok(proof);
 return {...f,g,upgradeTime:time,upgradeReview:r,upgradeProof:proof,upgradeRequest};
}
const apply=f=>overlay.applyPaperExecutionUpgrade(db,f.context,f.actor,f.upgradeReview.id,f.upgradeProof.receipt,f.upgradeTime);
const access=(f,time=f.upgradeTime)=>overlay.readEffectivePaperExecutionAccess(db,f.actor,time);
const preserved=f=>({state:state(f),installation:db.prepare('SELECT * FROM paper_installations WHERE owner_id=?').all(f.ownerId),grants:db.prepare('SELECT * FROM paper_install_grants WHERE owner_id=?').all(f.ownerId),definitions:db.prepare('SELECT * FROM paper_dispatch_definitions WHERE owner_id=?').all(f.ownerId),attempts:db.prepare('SELECT * FROM paper_dispatch_attempts WHERE owner_id=? ORDER BY sequence').all(f.ownerId),consents:db.prepare('SELECT * FROM paper_runtime_consents WHERE owner_id=?').all(f.ownerId)});
const counts=f=>['paper_execution_overlays','paper_execution_bindings','paper_execution_upgrade_events'].map(name=>db.prepare(`SELECT COUNT(*) n FROM ${name} WHERE owner_id=?`).get(f.ownerId).n);
test('reviewed proof applies separate execute-only overlay preserving failed+actual filled prefix and all baseline state',async()=>{
 const f=await ready({filled:true}),before=preserved(f),result=await apply(f);assert.equal(result.ok,true);assert.equal(result.replayed,false);assert.equal(result.executionGranted,true);assert.equal(result.runtimeConnected,false);assert.equal(result.baselineRevision,1);assert.equal(result.effectiveRevision,2);assert.deepEqual(preserved(f),before);assert.deepEqual(counts(f),[1,1,1]);
 assert.equal(installation.readPaperInstallation(db,f.ownerId,()=>f.upgradeTime).revision,1);assert.equal(access(f).ok,true);
 assert.equal(db.prepare('SELECT consumed_at FROM verification_receipts WHERE token_hash=?').get(createHash('sha256').update(f.upgradeProof.receipt).digest('hex')).consumed_at,f.upgradeTime);
 assert.equal((await apply(f)).replayed,true);assert.deepEqual(preserved(f),before);
 assert.equal((await review.stagePaperExecutionUpgradeReview(db,f.context,f.actor,f.upgradeRequest,f.upgradeTime)).ok,false);assert.equal(await review.issuePaperExecutionUpgradeProof(db,f.context,f.actor,f.upgradeReview.id,f.upgradeTime),null);assert.equal((await review.readPaperExecutionUpgradeReview(db,f.context,f.actor,f.upgradeReview.id,f.upgradeTime)).ok,false);
 // Existing trusted internal dispatcher remains unwired to overlay; original identity, cap and cadence are preserved.
 quote(f,f.upgradeTime+1000,3);assert.equal(cycle.dispatchDuePaperRuntimeConsent(db,{consentId:f.g.consentId},f.upgradeTime+1000).status,'completed');
 assert.equal(access(f,f.upgradeTime+1000).ok,true);assert.equal((await overlay.applyPaperExecutionUpgrade(db,f.context,f.actor,f.upgradeReview.id,f.upgradeProof.receipt,f.upgradeTime+1000)).replayed,true);
 const after=preserved(f);assert.deepEqual(after.attempts.map(a=>a.attempt_key),[1,2,3].map(sequence=>dispatch.derivePaperRuntimeDueAttemptKey(f.g.consentId,f.g.definitionId,f.g.definitionDigest,sequence)));assert.equal(run(f.g.consentId,dispatch.derivePaperRuntimeDueAttemptKey(f.g.consentId,f.g.definitionId,f.g.definitionDigest,2),f.upgradeTime+1000).replayed,true);assert.deepEqual(preserved(f),after);assert.equal(dispatch.readPaperDispatchAttempts(db,f.ownerId,f.g.definitionId,f.upgradeTime+1000).attemptCount,3);
});
test('pending, unknown, changed profile and stale affected set refuse without consuming proof',async()=>{
 for(const change of ['pending','unknown','profile','revoke']){
  const f=await ready();if(change==='profile')execution.configurePaperExecution(db,{ownerId:f.ownerId,accountId:f.input.accountId,revision:2,feeBps:200,slippageBps:0,unitScale:1,currency:'USD'});
  else if(change==='revoke')runtime.revokePaperRuntimeConsent(db,f.actor,f.g.consentId,f.upgradeTime);
  else{const c=dispatch.claimPaperDispatchAttempt(db,f.ownerId,{definitionId:f.g.definitionId,definitionDigest:f.g.definitionDigest,attemptKey:change,leaseMs:1000},f.upgradeTime-1001);assert.equal(c.ok,true);if(change==='unknown')dispatch.reconcileExpiredPaperDispatchAttempt(db,f.ownerId,{definitionId:f.g.definitionId,definitionDigest:f.g.definitionDigest,attemptKey:change},f.upgradeTime);}
  assert.equal((await apply(f)).ok,false);assert.deepEqual(counts(f),[0,0,0]);assert.equal(db.prepare('SELECT consumed_at FROM verification_receipts WHERE token_hash=?').get(createHash('sha256').update(f.upgradeProof.receipt).digest('hex')).consumed_at,null);
 }
});
test('actual SQL fault after overlay and binding insertion rolls receipt and every overlay row back',async()=>{
 const f=await ready(),before=preserved(f),original=db.prepare;let reached=false;
 db.prepare=function(text,...args){if(text.startsWith('INSERT INTO main.paper_execution_upgrade_events')){reached=true;assert.deepEqual(counts(f),[1,1,0]);return original.call(this,'INSERT INTO main.fixture_missing_upgrade_table VALUES(1)');}return original.call(this,text,...args);};
 try{assert.equal((await apply(f)).ok,false);}finally{db.prepare=original;}
 assert.equal(reached,true);assert.deepEqual(counts(f),[0,0,0]);assert.deepEqual(preserved(f),before);assert.equal(db.prepare('SELECT consumed_at FROM verification_receipts WHERE token_hash=?').get(createHash('sha256').update(f.upgradeProof.receipt).digest('hex')).consumed_at,null);
 assert.equal((await apply(f)).ok,true);
});
test('effective read is query-only; foreign/TEMP/current owner-factor loss refuses and base disable/revoke remain independent of overlay damage',async()=>{
 const f=await ready();assert.equal((await apply(f)).ok,true);const before=preserved(f),changes=db.prepare('SELECT total_changes() n').get().n;db.pragma('query_only=ON');try{assert.equal(access(f).ok,true);assert.equal((await apply(f)).ok,false);assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);}finally{db.pragma('query_only=OFF');}assert.deepEqual(preserved(f),before);
 const other=await fixture();assert.equal(overlay.readEffectivePaperExecutionAccess(db,other.actor,f.upgradeTime).ok,false);
 const foreign=new Database(process.env.DATABASE_PATH);try{assert.equal(overlay.readEffectivePaperExecutionAccess(foreign,f.actor,f.upgradeTime).ok,false);assert.equal((await overlay.applyPaperExecutionUpgrade(foreign,f.context,f.actor,f.upgradeReview.id,f.upgradeProof.receipt,f.upgradeTime)).ok,false);}finally{foreign.close();}
 db.exec('CREATE TEMP VIEW PAPER_EXECUTION_BINDINGS AS SELECT * FROM main.paper_execution_bindings');try{assert.equal(access(f).ok,false);}finally{db.exec('DROP VIEW temp.PAPER_EXECUTION_BINDINGS');}
 db.prepare('UPDATE verification_factors SET enabled=0 WHERE user_id=?').run(f.ownerId);assert.equal(access(f).ok,false);db.prepare('UPDATE verification_factors SET enabled=1 WHERE user_id=?').run(f.ownerId);
 db.prepare("UPDATE paper_execution_upgrade_events SET event_hash=? WHERE owner_id=?").run('0'.repeat(64),f.ownerId);assert.equal(access(f).ok,false);
 assert.equal(installation.provisionTrustedPaperInstallation(db,f.ownerId,{action:'disable',idempotencyKey:'base-disable',expectedRevision:1,manifestDigest:installation.BUNDLED_PAPER_INSTALLATION.manifestDigest,capabilities:[]},()=>f.upgradeTime).ok,true);
 assert.equal(access(f).ok,false);assert.equal(runtime.revokePaperRuntimeConsent(db,f.actor,f.g.consentId,f.upgradeTime).ok,true);
});

test('post-insert current target mutation rolls back proof overlay bindings and target change',async()=>{
 const f=await ready(),before=preserved(f),original=db.prepare;let injected=false;
 db.prepare=function(text,...args){if(text.startsWith('INSERT INTO main.paper_execution_upgrade_events')){injected=true;original.call(this,'UPDATE main.paper_accounts SET stopped=1 WHERE account_id=?').run(f.input.accountId);}return original.call(this,text,...args);};
 try{assert.equal((await apply(f)).ok,false);}finally{db.prepare=original;}
 assert.equal(injected,true);assert.deepEqual(preserved(f),before);assert.deepEqual(counts(f),[0,0,0]);assert.equal(db.prepare('SELECT consumed_at FROM verification_receipts WHERE token_hash=?').get(createHash('sha256').update(f.upgradeProof.receipt).digest('hex')).consumed_at,null);
});
const hashJSON=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function rehashBindingEvent(f){
 const bindings=db.prepare('SELECT * FROM paper_execution_bindings WHERE owner_id=? ORDER BY consent_id').all(f.ownerId),e=db.prepare('SELECT * FROM paper_execution_upgrade_events WHERE owner_id=?').get(f.ownerId);
 e.bindings_hash=hashJSON(['paper-execution-upgrade-bindings-v1',bindings]);const fields=['id','overlay_id','owner_id','review_id','context_json','definition_hash','review_hash','receipt_hash','created_at','bindings_hash'];e.event_hash=hashJSON(['paper-execution-upgrade-applied-v1',...fields.map(k=>e[k])]);db.prepare('UPDATE paper_execution_upgrade_events SET bindings_hash=?,event_hash=? WHERE id=?').run(e.bindings_hash,e.event_hash,e.id);
}
test('coherently rewritten terminal prefix plus binding/event hashes cannot replace prefix protected by original upgrade proof',async()=>{
 const f=await ready({filled:true});assert.equal((await apply(f)).ok,true);
 const a=db.prepare("SELECT * FROM paper_dispatch_attempts WHERE definition_id=? AND status='failed'").get(f.g.definitionId),b=db.prepare('SELECT * FROM paper_execution_bindings WHERE owner_id=?').get(f.ownerId),e=db.prepare('SELECT * FROM paper_execution_upgrade_events WHERE owner_id=?').get(f.ownerId);
 try{
  const changed={...a,status:'completed'};changed.event_hash=hashJSON(['paper-dispatch-attempt-event-v1',changed.id,changed.definition_id,changed.owner_id,changed.attempt_key,changed.sequence,changed.lease_ms,changed.request_json,changed.request_hash,changed.fence_token,changed.claimed_at,changed.lease_until,changed.status,changed.finished_at]);db.prepare('UPDATE paper_dispatch_attempts SET status=?,event_hash=? WHERE id=?').run(changed.status,changed.event_hash,a.id);
  const saved=JSON.parse(b.baseline_json);saved.prefix=db.transaction(()=>dispatch.readPaperDispatchPreservationPrefixInTransaction(db,f.ownerId,f.g.definitionId,2,f.upgradeTime)).deferred();const text=JSON.stringify(saved);db.prepare('UPDATE paper_execution_bindings SET baseline_json=?,baseline_hash=? WHERE consent_id=?').run(text,createHash('sha256').update(text).digest('hex'),b.consent_id);rehashBindingEvent(f);assert.equal(access(f).ok,false);
 }finally{db.prepare('UPDATE paper_dispatch_attempts SET status=?,event_hash=? WHERE id=?').run(a.status,a.event_hash,a.id);db.prepare('UPDATE paper_execution_bindings SET baseline_json=?,baseline_hash=? WHERE consent_id=?').run(b.baseline_json,b.baseline_hash,b.consent_id);db.prepare('UPDATE paper_execution_upgrade_events SET bindings_hash=?,event_hash=? WHERE id=?').run(e.bindings_hash,e.event_hash,e.id);}
 assert.equal(access(f).ok,true);
});
test('already-revoked consent provenance is proof-bound while later genuine revocation remains allowed',async()=>{
 const f=await ready({revoked:true});assert.equal((await apply(f)).ok,true);const original=db.prepare('SELECT * FROM paper_runtime_revocations WHERE consent_id=?').get(f.g.consentId);
 try{const at=original.created_at+1,hash=hashJSON(['paper-runtime-revoke-v1',original.id,original.consent_id,original.owner_id,at]);db.prepare('UPDATE paper_runtime_revocations SET created_at=?,event_hash=? WHERE id=?').run(at,hash,original.id);assert.equal(access(f).ok,false);}finally{db.prepare('UPDATE paper_runtime_revocations SET created_at=?,event_hash=? WHERE id=?').run(original.created_at,original.event_hash,original.id);}
 assert.equal(access(f).ok,true);
 const g=await ready();assert.equal((await apply(g)).ok,true);assert.equal(runtime.revokePaperRuntimeConsent(db,g.actor,g.g.consentId,g.upgradeTime+1).ok,true);assert.equal(access(g,g.upgradeTime+1).ok,true);assert.equal((await overlay.applyPaperExecutionUpgrade(db,g.context,g.actor,g.upgradeReview.id,g.upgradeProof.receipt,g.upgradeTime+1)).replayed,true);
});

test('post-insert profile revision mutation also rolls back proof and overlay atomically',async()=>{
 const f=await ready(),before=preserved(f),profile=db.prepare('SELECT * FROM paper_execution_profiles WHERE account_id=?').get(f.input.accountId),original=db.prepare;
 db.prepare=function(text,...args){if(text.startsWith('INSERT INTO main.paper_execution_upgrade_events'))original.call(this,'UPDATE main.paper_execution_profiles SET revision=revision+1 WHERE account_id=?').run(f.input.accountId);return original.call(this,text,...args);};
 try{assert.equal((await apply(f)).ok,false);}finally{db.prepare=original;}
 assert.deepEqual(preserved(f),before);assert.deepEqual(db.prepare('SELECT * FROM paper_execution_profiles WHERE account_id=?').get(f.input.accountId),profile);assert.deepEqual(counts(f),[0,0,0]);assert.equal(db.prepare('SELECT consumed_at FROM verification_receipts WHERE token_hash=?').get(createHash('sha256').update(f.upgradeProof.receipt).digest('hex')).consumed_at,null);
});

test('actual owned child SIGKILL after overlay binding and event insert rolls back receipt and every pending transaction effect',async()=>{
 const f=await ready({filled:true}),before=preserved(f);const moduleURL=new URL('../src/services/trading-paper-execution-upgrade-apply.ts',import.meta.url).href,dbURL=new URL('../src/db/database.ts',import.meta.url).href;
 const source=`const {getDatabase}=await import(${JSON.stringify(dbURL)});const main=getDatabase();await main.initialize();const db=main.getDb();const {applyPaperExecutionUpgrade}=await import(${JSON.stringify(moduleURL)});db.function('crash_owned_upgrade',()=>{process.kill(process.pid,'SIGKILL');return 0;});const original=db.prepare;db.prepare=function(text,...args){if(text.startsWith('INSERT INTO main.paper_execution_upgrade_events'))db.exec("CREATE TEMP TRIGGER crash_owned_upgrade AFTER INSERT ON main.paper_execution_upgrade_events BEGIN SELECT crash_owned_upgrade(); END");return original.call(this,text,...args);};let input='';for await(const chunk of process.stdin)input+=chunk;const f=JSON.parse(input);await applyPaperExecutionUpgrade(db,f.context,f.actor,f.id,f.receipt,f.now);process.exit(91);`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',source],{env:process.env,stdio:['pipe','ignore','ignore']});child.stdin.end(JSON.stringify({context:f.context,actor:f.actor,id:f.upgradeReview.id,receipt:f.upgradeProof.receipt,now:f.upgradeTime}));const exited=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('owned crash fixture timeout'));},10000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});assert.equal(exited.signal,'SIGKILL');
 assert.deepEqual(counts(f),[0,0,0]);assert.deepEqual(preserved(f),before);assert.equal(db.prepare('SELECT consumed_at FROM verification_receipts WHERE token_hash=?').get(createHash('sha256').update(f.upgradeProof.receipt).digest('hex')).consumed_at,null);assert.equal((await apply(f)).ok,true);assert.equal((await apply(f)).replayed,true);
});

test('installed capability survives normal token factor and proof-policy rotation; requests stay current-context bound',async()=>{
 const f=await ready();assert.equal((await apply(f)).ok,true);const policy=db.prepare('SELECT version FROM approval_proof_policy WHERE id=1').get().version;
 try{
  db.prepare('UPDATE users SET token_version=token_version+1 WHERE id=?').run(f.ownerId);db.prepare('UPDATE verification_factors SET version=version+1 WHERE user_id=?').run(f.ownerId);db.prepare('UPDATE approval_proof_policy SET version=version+1 WHERE id=1').run();
  assert.equal(access(f).ok,true);assert.equal((await apply(f)).ok,false);
  const rotated={...f.context,tokenVersion:f.context.tokenVersion+1,factorVersion:f.context.factorVersion+1};assert.equal((await overlay.applyPaperExecutionUpgrade(db,rotated,f.actor,f.upgradeReview.id,f.upgradeProof.receipt,f.upgradeTime)).ok,false);
  db.prepare('UPDATE verification_factors SET enabled=0 WHERE user_id=?').run(f.ownerId);assert.equal(access(f).ok,false);
 }finally{db.prepare('UPDATE users SET token_version=? WHERE id=?').run(f.context.tokenVersion,f.ownerId);db.prepare('UPDATE verification_factors SET enabled=1,version=? WHERE user_id=?').run(f.context.factorVersion,f.ownerId);db.prepare('UPDATE approval_proof_policy SET version=? WHERE id=1').run(policy);}
 assert.equal(access(f).ok,true);
});
test('expired original consent and exhausted bot are preserved without resetting or reviving their rights',async()=>{
 const f=await ready({expired:true});const before=preserved(f);assert.equal((await apply(f)).ok,true);assert.deepEqual(preserved(f),before);assert.equal(cycle.dispatchDuePaperRuntimeConsent(db,{consentId:f.g.consentId},f.upgradeTime).ok,false);assert.equal(dispatch.readPaperDispatchAttempts(db,f.ownerId,f.g.definitionId,f.upgradeTime).attemptCount,0);
 const g=await ready({filled:true,maxSuccessfulTicks:1});const exhausted=preserved(g);assert.equal(exhausted.state.bot.successful_ticks,1);assert.equal((await apply(g)).ok,true);assert.deepEqual(preserved(g),exhausted);assert.equal(cycle.dispatchDuePaperRuntimeConsent(db,{consentId:g.g.consentId},g.upgradeTime).ok,false);assert.equal(dispatch.readPaperDispatchAttempts(db,g.ownerId,g.g.definitionId,g.upgradeTime).attemptCount,2);
});
test('coherently changed original runtime proof metadata is refused by proof-bound immutable provenance',async()=>{
 const f=await ready();assert.equal((await apply(f)).ok,true);const event=db.prepare('SELECT receipt_hash FROM paper_runtime_events WHERE consent_id=?').get(f.g.consentId),proof=db.prepare('SELECT * FROM verification_receipts WHERE token_hash=?').get(event.receipt_hash);
 try{db.prepare('UPDATE verification_receipts SET expires_at=expires_at+1 WHERE token_hash=?').run(event.receipt_hash);assert.equal(access(f).ok,false);}finally{db.prepare('UPDATE verification_receipts SET expires_at=? WHERE token_hash=?').run(proof.expires_at,event.receipt_hash);}
 assert.equal(access(f).ok,true);
});
