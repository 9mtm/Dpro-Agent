import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {spawn} from 'node:child_process';
const {Worker}=await import('node:worker_threads');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'paper-reviewed-runtime-'));
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
const strict=(f,time=f.upgradeTime)=>cycle.dispatchDueReviewedPaperRuntimeConsent(db,{consentId:f.g.consentId},time);
const journal=f=>dispatch.readPaperDispatchAttempts(db,f.ownerId,f.g.definitionId,f.upgradeTime+100000);
test('strict canonical buy requires actual reviewed overlay and preserves original finite cap and replay',async()=>{
 const f=await ready({maxSuccessfulTicks:1});quote(f,f.upgradeTime,1);const before=preserved(f);assert.equal(strict(f).ok,false);assert.deepEqual(preserved(f),before);assert.equal(journal(f).attemptCount,0);
 assert.equal((await apply(f)).ok,true);const completed=strict(f);assert.equal(completed.status,'completed');assert.equal(completed.replayed,false);assert.equal(state(f).fills.length,1);assert.equal(state(f).bot.successful_ticks,1);assert.equal(journal(f).attemptCount,1);assert.equal(journal(f).attempts[0].attemptKey,dispatch.derivePaperRuntimeDueAttemptKey(f.g.consentId,f.g.definitionId,f.g.definitionDigest,1));
 const after=preserved(f);assert.equal(strict(f,f.upgradeTime+1000).ok,false);assert.deepEqual(preserved(f),after);
 const k=journal(f).attempts[0].attemptKey;runtime.revokePaperRuntimeConsent(db,f.actor,f.g.consentId,f.upgradeTime+1001);const revoked=preserved(f);assert.equal(dispatcher.dispatchReviewedCanonicalPaperRuntimeAttempt(db,{consentId:f.g.consentId,attemptKey:k},f.upgradeTime+1001).replayed,true);assert.deepEqual(preserved(f),revoked);
});
function afterDeferred(ordinal,callback){const original=db.transaction;let reads=0;db.transaction=function(fn,...args){const tx=original.call(this,fn,...args),wrap=(...v)=>tx(...v);wrap.immediate=(...v)=>tx.immediate(...v);wrap.exclusive=(...v)=>tx.exclusive(...v);wrap.deferred=(...v)=>{const result=tx.deferred(...v);if(!db.inTransaction&&++reads===ordinal)callback(result);return result;};return wrap;};return ()=>{db.transaction=original;};}
function afterClaim(callback){const original=db.transaction;db.transaction=function(fn,...args){const tx=original.call(this,fn,...args),wrap=(...v)=>tx(...v);wrap.deferred=(...v)=>tx.deferred(...v);wrap.exclusive=(...v)=>tx.exclusive(...v);wrap.immediate=(...v)=>{const result=tx.immediate(...v);if(result?.ok&&result.replayed===false&&typeof result.fenceToken==='string')callback(result);return result;};return wrap;};return ()=>{db.transaction=original;};}
test('revocation disable and overlay corruption after released dispatcher snapshot refuse under claim lock with zero attempt',async()=>{
 for(const change of ['revoke','disable','overlay']){
  const f=await ready();assert.equal((await apply(f)).ok,true);quote(f,f.upgradeTime,1);let initial=state(f);let injected=false;
  const restore=afterDeferred(2,()=>{injected=true;if(change==='revoke')runtime.revokePaperRuntimeConsent(db,f.actor,f.g.consentId,f.upgradeTime);if(change==='disable')installation.provisionTrustedPaperInstallation(db,f.ownerId,{action:'disable',idempotencyKey:'strict-disable',expectedRevision:1,manifestDigest:installation.BUNDLED_PAPER_INSTALLATION.manifestDigest,capabilities:[]},()=>f.upgradeTime);if(change==='overlay')db.prepare('UPDATE paper_execution_upgrade_events SET event_hash=? WHERE owner_id=?').run('0'.repeat(64),f.ownerId);initial=state(f);});
  try{assert.equal(strict(f).ok,false);}finally{restore();}assert.equal(injected,true);assert.equal(journal(f).attemptCount,0);assert.deepEqual(state(f),initial);
 }
});
test('after durable claim revoked or disabled authority rolls back all trading effects while retaining consumed attempt budget',async()=>{
 for(const change of ['revoke','disable','overlay']){
  const f=await ready();assert.equal((await apply(f)).ok,true);quote(f,f.upgradeTime,1);let before=state(f);let injected=false;const restore=afterClaim(()=>{injected=true;if(change==='revoke')runtime.revokePaperRuntimeConsent(db,f.actor,f.g.consentId,f.upgradeTime);if(change==='disable')installation.provisionTrustedPaperInstallation(db,f.ownerId,{action:'disable',idempotencyKey:'claim-disable',expectedRevision:1,manifestDigest:installation.BUNDLED_PAPER_INSTALLATION.manifestDigest,capabilities:[]},()=>f.upgradeTime);if(change==='overlay')db.prepare('UPDATE paper_execution_upgrade_events SET event_hash=? WHERE owner_id=?').run('0'.repeat(64),f.ownerId);before=state(f);});
  let result;try{result=strict(f);}finally{restore();}assert.equal(injected,true);assert.equal(result.status,'failed');assert.equal(journal(f).attemptCount,1);assert.deepEqual(state(f),before);
 }
});
test('late authority change after tick but before finish cannot commit trade or completed attempt',async()=>{
 const f=await ready();assert.equal((await apply(f)).ok,true);quote(f,f.upgradeTime,1);const before=state(f),original=db.prepare;let injected=false;
 db.prepare=function(text,...args){if(text.startsWith('UPDATE main.paper_dispatch_attempts SET status=')){injected=true;original.call(this,'UPDATE main.paper_execution_upgrade_events SET event_hash=? WHERE owner_id=?').run('0'.repeat(64),f.ownerId);}return original.call(this,text,...args);};
 try{assert.equal(strict(f).ok,false);}finally{db.prepare=original;}assert.equal(injected,true);assert.deepEqual(state(f),before);assert.equal(journal(f).attemptCount,1);assert.equal(journal(f).attempts[0].status,'pending');
});
test('strict pending never resumes, expired lease becomes unknown and cannot open another attempt',async()=>{
 const f=await ready();assert.equal((await apply(f)).ok,true);quote(f,f.upgradeTime,1);const k=dispatch.derivePaperRuntimeDueAttemptKey(f.g.consentId,f.g.definitionId,f.g.definitionDigest,1),c=dispatch.claimReviewedCanonicalPaperDispatchAttempt(db,f.ownerId,{definitionId:f.g.definitionId,definitionDigest:f.g.definitionDigest,attemptKey:k,leaseMs:60000},f.g.consentId,f.upgradeTime);assert.equal(c.ok,true);const before=state(f);assert.equal(strict(f).status,'pending');assert.equal(strict(f,f.upgradeTime+60000).status,'unknown');assert.equal(strict(f,f.upgradeTime+60001).ok,false);assert.deepEqual(state(f),before);assert.equal(journal(f).attemptCount,1);
});
test('both module import orders initialize without circular TDZ or connections',async()=>{
 const a=new URL('../src/services/trading-paper-dispatch-attempts.ts',import.meta.url).href,b=new URL('../src/services/trading-paper-execution-upgrade-apply.ts',import.meta.url).href;
 for(const order of [[a,b],[b,a]]){const source=`await import(${JSON.stringify(order[0])});await import(${JSON.stringify(order[1])});`;const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',source],{env:process.env,stdio:'ignore'});const code=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(Error('owned import fixture timeout'));},10000);child.once('error',e=>{clearTimeout(timeout);reject(e);});child.once('exit',code=>{clearTimeout(timeout);resolve(code);});});assert.equal(code,0);}
});
test('strict canonical sell derives only the proved whole-unit strategy and settles owned inventory',async()=>{
 const f=await fixture();quote(f,f.activationTime+1000,1);const reserved=ledger.reservePaperOrder(db,f.ownerId,{accountId:f.input.accountId,policyId:f.input.policyId,policyRevision:1,appRevision:1,currency:'USD',symbol:'AAA',side:'buy',notional:1000,idempotencyKey:'owned-prior-inventory'},()=>f.activationTime+1000);assert.equal(reserved.ok,true);assert.equal(execution.executePaperBuy(db,f.ownerId,{accountId:f.input.accountId,reservationId:reserved.reservationId,executionKey:'owned-prior-fill'},()=>f.activationTime+1000).ok,true);
 quote(f,f.time,2);const value=request(f);value.strategy={kind:'fixed-paper-order',version:1,symbol:'AAA',side:'sell',amount:2};const g=await grant(f,value),time=f.time+30000;quote(f,time,3);
 const r=await review.stagePaperExecutionUpgradeReview(db,f.context,f.actor,{expectedRevision:1,targetManifestDigest:PAPER_EXECUTION_UPGRADE_CANDIDATE.manifestDigest},time);assert.equal(r.ok,true);const c=await review.issuePaperExecutionUpgradeProof(db,f.context,f.actor,r.id,time);assert.ok(c);const p=await review.completePaperExecutionUpgradeProof(db,f.context,f.actor,r.id,c.token,f.otp(time),time);assert.ok(p);assert.equal((await overlay.applyPaperExecutionUpgrade(db,f.context,f.actor,r.id,p.receipt,time)).ok,true);
 const result=cycle.dispatchDueReviewedPaperRuntimeConsent(db,{consentId:g.consentId},time);assert.equal(result.status,'completed');assert.equal(state(f).sells.length,1);assert.equal(state(f).positions[0].quantity_units,7);const before=state(f),key=dispatch.derivePaperRuntimeDueAttemptKey(g.consentId,g.definitionId,g.definitionDigest,1);assert.equal(dispatcher.dispatchReviewedCanonicalPaperRuntimeAttempt(db,{consentId:g.consentId,attemptKey:key},time).replayed,true);assert.deepEqual(state(f),before);
});
test('post-INSERT claim guard rolls back new budget when account authority changes inside actual claim write',async()=>{
 const f=await ready();assert.equal((await apply(f)).ok,true);quote(f,f.upgradeTime,1);const before=preserved(f),original=db.prepare;let injected=false;
 db.prepare=function(text,...args){const statement=original.call(this,text,...args);if(text.startsWith('INSERT INTO main.paper_dispatch_attempts'))return {run:(...values)=>{const result=statement.run(...values);injected=true;original.call(this,'UPDATE main.paper_accounts SET stopped=1 WHERE account_id=?').run(f.input.accountId);return result;}};return statement;};
 try{assert.equal(strict(f).ok,false);}finally{db.prepare=original;}assert.equal(injected,true);assert.equal(journal(f).attemptCount,0);assert.deepEqual(preserved(f),before);
});

test('clock crosses live lease after completed update: final guard rolls back fills tick and finish, preserving pending claim',async()=>{
 const f=await ready();assert.equal((await apply(f)).ok,true);quote(f,f.upgradeTime,1);const before=state(f),originalPrepare=db.prepare,originalClock=Date.now;let current=f.upgradeTime,injected=false;Date.now=()=>current;
 db.prepare=function(text,...args){const statement=originalPrepare.call(this,text,...args);if(text.startsWith('UPDATE main.paper_dispatch_attempts SET status='))return {run:(...values)=>{const result=statement.run(...values);injected=true;current=f.upgradeTime+60000;return result;}};return statement;};
 try{assert.equal(cycle.dispatchDueReviewedPaperRuntimeConsent(db,{consentId:f.g.consentId}).ok,false);}finally{db.prepare=originalPrepare;Date.now=originalClock;}
 assert.equal(injected,true);assert.deepEqual(state(f),before);assert.equal(journal(f).attemptCount,1);assert.equal(journal(f).attempts[0].status,'pending');assert.equal(strict(f,f.upgradeTime+60000).status,'unknown');assert.deepEqual(state(f),before);
});
