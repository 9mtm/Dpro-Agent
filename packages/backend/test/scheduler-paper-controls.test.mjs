import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'paper-schedule-controls-'));
Object.assign(process.env,{AGENT_PLAYER_DATA_DIR:root,DATABASE_PATH:path.join(root,'main.db'),JWT_SECRET:randomBytes(64).toString('hex'),ENCRYPTION_KEY:randomBytes(32).toString('hex')});delete process.env.AGENT_PLAYER_DB;
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const main=getDatabase();await main.initialize();const db=main.getDb();
const activation=await import('../src/services/trading-paper-bot-activation.ts'),ledger=await import('../src/services/trading-paper-ledger.ts'),execution=await import('../src/services/trading-paper-execution.ts');
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
test.after(async()=>{closeDatabase();await fs.rm(root,{recursive:true,force:true});});
const review=await import('../src/services/trading-paper-execution-upgrade-review.ts');
const overlay=await import('../src/services/trading-paper-execution-upgrade-apply.ts');
const {PAPER_EXECUTION_UPGRADE_CANDIDATE}=await import('../src/services/trading-paper-manifest-catalog.ts');
runtime.initializePaperRuntimeConsent(db);dispatch.initializePaperDispatchAttempts(db);review.initializePaperExecutionUpgradeReviews(db);overlay.initializePaperExecutionUpgradeApplications(db);
async function ready({side='buy',maxSuccessfulTicks=3}={}){
 const f=await fixture({maxSuccessfulTicks});let revision=0;
 if(side==='sell'){execution.recordPaperExecutionQuote(db,{accountId:f.input.accountId,symbol:'AAA',priceMinor:100,quotedAt:f.activationTime+1000,revision:++revision,currency:'USD',unitScale:1});const r=ledger.reservePaperOrder(db,f.ownerId,{accountId:f.input.accountId,policyId:f.input.policyId,policyRevision:1,appRevision:1,currency:'USD',symbol:'AAA',side:'buy',notional:1000,idempotencyKey:'prior-inventory'},()=>f.activationTime+1000);assert.equal(r.ok,true);assert.equal(execution.executePaperBuy(db,f.ownerId,{accountId:f.input.accountId,reservationId:r.reservationId,executionKey:'prior-inventory-fill'},()=>f.activationTime+1000).ok,true);execution.recordPaperExecutionQuote(db,{accountId:f.input.accountId,symbol:'AAA',priceMinor:100,quotedAt:f.time,revision:++revision,currency:'USD',unitScale:1});}
 const value=request(f);if(side==='sell')value.strategy={kind:'fixed-paper-order',version:1,symbol:'AAA',side:'sell',amount:2};const g=await grant(f,value),time=f.time+30000;
 if(side==='sell')execution.recordPaperExecutionQuote(db,{accountId:f.input.accountId,symbol:'AAA',priceMinor:100,quotedAt:time,revision:++revision,currency:'USD',unitScale:1});
 const upgradeRequest={expectedRevision:1,targetManifestDigest:PAPER_EXECUTION_UPGRADE_CANDIDATE.manifestDigest};
 const r=await review.stagePaperExecutionUpgradeReview(db,f.context,f.actor,upgradeRequest,time);assert.equal(r.ok,true);
 const challenge=await review.issuePaperExecutionUpgradeProof(db,f.context,f.actor,r.id,time);assert.ok(challenge);
 const proof=await review.completePaperExecutionUpgradeProof(db,f.context,f.actor,r.id,challenge.token,f.otp(time),time);assert.ok(proof);
 return {...f,g,quoteRevision:revision,upgradeTime:time,upgradeReview:r,upgradeProof:proof,upgradeRequest};
}
const apply=f=>overlay.applyPaperExecutionUpgrade(db,f.context,f.actor,f.upgradeReview.id,f.upgradeProof.receipt,f.upgradeTime);
const definitions=await import('../src/scheduler/definitions.ts');
const auth=await import('../src/scheduler/authorization.ts');
async function prepared(options={}){const f=await ready(options);assert.equal((await apply(f)).ok,true);const time=f.upgradeTime+30000,id=randomUUID();const revision=f.quoteRevision+1;execution.recordPaperExecutionQuote(db,{accountId:f.input.accountId,symbol:'AAA',priceMinor:100,quotedAt:time,revision,currency:'USD',unitScale:1});const changes={name:'Paused paper cycle',cronExpression:'*/5 * * * *',actionType:'paper-runtime-cycle',actionData:{consentId:f.g.consentId}};const saved=await definitions.saveScheduledDefinition(f.actor,f.context.tokenVersion,id,0,changes,time);assert.equal(saved.job.enabled,false);return {...f,quoteRevision:revision,scheduleTime:time,saved,job:saved.job};}
async function scheduleProof(f,lifetime=180000){const expiresAt=Math.min(f.input.expiresAt,f.scheduleTime+lifetime),preview=await auth.scheduledAuthorizationPreview(f.context,f.actor,f.job.id,expiresAt,f.scheduleTime);const challenge=await auth.issueScheduledAuthorization(f.context,f.actor,preview.operation,f.scheduleTime),proof=await auth.completeScheduledAuthorization(challenge.token,f.context,f.actor,preview.operation,f.otp(f.scheduleTime),f.scheduleTime);assert.ok(proof);return {preview,proof};}
async function withClock(time,callback){const before=Date.now;Date.now=()=>time;try{return await callback();}finally{Date.now=before;}}
const attempts=f=>db.prepare('SELECT COUNT(*) n FROM paper_dispatch_attempts WHERE owner_id=?').get(f.ownerId).n;
const fills=f=>db.prepare('SELECT COUNT(*) n FROM paper_fills WHERE account_id=?').get(f.input.accountId).n;
const {resolvePaperScheduleExecutionInTransaction}=await import('../src/scheduler/paper-execution-admission.ts');

const controls=await import('../src/scheduler/paper-controls.ts');
async function authorized(options={}){const f=await prepared(options),p=await scheduleProof(f,options.scheduleLifetimeMs??180000);await auth.authorizeScheduledJob(p.proof.receipt,f.context,f.actor,p.preview.operation,f.scheduleTime);return {...f,scheduleProof:p,enableInput:{jobId:f.job.id,jobRevision:p.preview.operation.jobRevision,authorizationRevision:p.preview.operation.authorizationRevision+1,definitionHash:p.preview.operation.definitionHash}};}
const enable=(f,input=f.enableInput,time=f.scheduleTime)=>controls.enablePaperSchedule(db,f.context,f.actor,input,time);
const disable=(f,time=f.scheduleTime)=>controls.disablePaperSchedule(db,f.context,f.actor,{jobId:f.job.id},time);
const read=(f,time=f.scheduleTime)=>controls.readPaperScheduleControl(db,f.context,f.actor,{jobId:f.job.id},time);
const saved=f=>db.prepare('SELECT enabled,last_run,next_run,updated_at FROM cron_jobs WHERE id=?').get(f.job.id);
const business=f=>Object.fromEntries([['paper_accounts','account_id',f.input.accountId],['paper_policies','policy_id',f.input.policyId],['paper_execution_profiles','account_id',f.input.accountId],['paper_bots','bot_id',f.botId],['paper_dispatch_definitions','owner_id',f.ownerId],['paper_dispatch_attempts','owner_id',f.ownerId],['paper_fills','account_id',f.input.accountId],['paper_sell_fills','account_id',f.input.accountId],['paper_reservations','account_id',f.input.accountId],['paper_sell_reservations','account_id',f.input.accountId]].map(([table,key,id])=>[table,db.prepare('SELECT * FROM '+table+' WHERE '+key+'=?').all(id)]));
function afterEnableWrite(callback){const original=db.prepare;let hit=false;db.prepare=function(statement){const prepared=original.call(this,statement);if(!hit&&/UPDATE main\.cron_jobs SET enabled=1/.test(statement))return new Proxy(prepared,{get(target,key){if(key==='run')return(...args)=>{const result=target.run(...args);hit=true;callback();return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});return prepared;};return()=>{db.prepare=original;assert.equal(hit,true);};}
test.afterEach(()=>db.prepare('UPDATE cron_jobs SET enabled=0').run());
test('real paused TOTP grant enables idempotently without reset or new proof and does not claim physical registration',async()=>{
 const f=await authorized(),before=business(f),grant=db.prepare('SELECT * FROM scheduled_job_authorizations WHERE job_id=?').get(f.job.id),events=db.prepare('SELECT * FROM scheduled_job_authorization_events WHERE job_id=?').all(f.job.id);assert.equal(saved(f).enabled,0);assert.equal(read(f).authorization,'authorized');
 const first=enable(f);assert.equal(first.ok,true);assert.equal(first.savedEnabled,true);assert.equal(first.replayed,false);assert.equal(first.registration,'not_observed');assert.equal(first.runtimeConnection,'not_observed');assert.equal(Object.hasOwn(first,'registered'),false);assert.equal(saved(f).enabled,1);assert.deepEqual(business(f),before);assert.deepEqual(db.prepare('SELECT * FROM scheduled_job_authorizations WHERE job_id=?').get(f.job.id),grant);assert.deepEqual(db.prepare('SELECT * FROM scheduled_job_authorization_events WHERE job_id=?').all(f.job.id),events);
 assert.equal(enable(f).replayed,true);assert.deepEqual(business(f),before);assert.equal(disable(f).savedEnabled,false);assert.equal(disable(f).replayed,true);assert.equal(read(f).savedEnabled,false);assert.equal(read(f).authorization,'authorized');
});
test('explicit independent engine can register enabled control and fill once while control read remains not_observed',async()=>{
 const f=await authorized();assert.equal(enable(f).ok,true);const {CronEngine}=await import('../src/scheduler/engine.ts'),{default:cron}=await import('node-cron'),original=cron.schedule,background=process.env.AGENT_PLAYER_BACKGROUND;const callbacks=[];cron.schedule=(expression,callback)=>{callbacks.push(callback);return {stop(){},destroy(){}};};process.env.AGENT_PLAYER_BACKGROUND='on';const e=new CronEngine(db);
 try{await withClock(f.scheduleTime,()=>e.start());assert.equal(e.getPaperStatus(f.job.id).registered,true);assert.equal(read(f).registration,'not_observed');await withClock(f.scheduleTime,()=>callbacks.at(-1)());assert.equal(attempts(f),1);assert.equal(fills(f),1);assert.equal(disable(f).ok,true);await withClock(f.scheduleTime+1000,()=>callbacks.at(-1)());assert.equal(attempts(f),1);assert.equal(fills(f),1);}finally{await e.stop();cron.schedule=original;if(background===undefined)delete process.env.AGENT_PLAYER_BACKGROUND;else process.env.AGENT_PLAYER_BACKGROUND=background;}
});
test('wrong actor context revisions hash expiry and descriptor input refuse before enabling or budget mutation',async()=>{
 const f=await authorized(),before=business(f);const other=await authorized();
 for(const actor of [{...f.actor,kind:'agent'},{...f.actor,channel:'fixture'},{...f.actor,agentId:'agent'}, {...f.actor,role:'admin'},{kind:'system',role:'owner'},{...f.actor,userId:'system'},other.actor])assert.equal(controls.enablePaperSchedule(db,f.context,actor,f.enableInput,f.scheduleTime).ok,false);
 for(const context of [{...f.context,tokenVersion:f.context.tokenVersion+1},{...f.context,factorVersion:f.context.factorVersion+1},{...f.context,sessionHash:'b'.repeat(64)}])assert.equal(controls.enablePaperSchedule(db,context,f.actor,f.enableInput,f.scheduleTime).ok,false);
 for(const input of [{...f.enableInput,jobRevision:2},{...f.enableInput,authorizationRevision:2},{...f.enableInput,definitionHash:'0'.repeat(64)},{...f.enableInput,enabled:true},{...f.enableInput,jobId:f.job.id+'\n'},Object.create(f.enableInput),Object.defineProperty({...f.enableInput},'definitionHash',{get(){throw Error('getter invoked');}})])assert.equal(enable(f,input).ok,false);
 assert.equal(enable(f,f.enableInput,f.scheduleProof.preview.operation.authorizationExpiresAt).ok,false);assert.equal(saved(f).enabled,0);assert.deepEqual(business(f),before);
});
test('post-UPDATE stop policy and owner mutation roll back enabled flag and all injected changes',async()=>{
 for(const change of ['stop','policy','owner','revision']){const f=await authorized(),before=business(f),user=db.prepare('SELECT * FROM users WHERE id=?').get(f.ownerId),restore=afterEnableWrite(()=>{if(change==='stop')db.prepare('UPDATE paper_accounts SET stopped=1 WHERE account_id=?').run(f.input.accountId);if(change==='policy')db.prepare('UPDATE paper_policies SET enabled=0 WHERE policy_id=?').run(f.input.policyId);if(change==='owner')db.prepare("UPDATE users SET role='user' WHERE id=?").run(f.ownerId);if(change==='revision')db.prepare('UPDATE scheduled_job_security_versions SET revision=revision+1 WHERE job_id=?').run(f.job.id);});try{assert.equal(enable(f).ok,false);}finally{restore();}assert.equal(saved(f).enabled,0);assert.deepEqual(business(f),before);assert.deepEqual(db.prepare('SELECT * FROM users WHERE id=?').get(f.ownerId),user);}
});
test('emergency disable survives factor-off expired revoked damaged proof and overlay without journal reset',async()=>{
 for(const change of ['factor','expired','revoked','proof','overlay','missing-proof-table']){const f=await authorized();assert.equal(enable(f).ok,true);const before=business(f);let time=f.scheduleTime;
 if(change==='factor')db.prepare('UPDATE verification_factors SET enabled=0 WHERE user_id=?').run(f.ownerId);if(change==='expired')time=f.scheduleProof.preview.operation.authorizationExpiresAt;if(change==='revoked')db.prepare("UPDATE scheduled_job_authorizations SET status='revoked' WHERE job_id=?").run(f.job.id);if(change==='proof')db.prepare('UPDATE verification_receipts SET consumed_at=NULL WHERE token_hash=(SELECT receipt_hash FROM scheduled_job_authorizations WHERE job_id=?)').run(f.job.id);
 if(change==='overlay')db.prepare('UPDATE paper_execution_upgrade_events SET event_hash=? WHERE owner_id=?').run('0'.repeat(64),f.ownerId);
 if(change==='missing-proof-table'){db.exec('ALTER TABLE verification_receipts RENAME TO fixture_damaged_receipts');}
 try{assert.equal(controls.disablePaperSchedule(db,change==='factor'?{...f.context,factorVersion:0}:f.context,f.actor,{jobId:f.job.id},time).ok,true);assert.equal(saved(f).enabled,0);assert.deepEqual(business(f),before);assert.equal(read(f,time).savedEnabled,false);assert.equal(read(f,time).authorization,'unavailable');}finally{if(change==='missing-proof-table')db.exec('ALTER TABLE fixture_damaged_receipts RENAME TO verification_receipts');}
 }
});
test('same-main foreign caller transaction TEMP queryonly and driver boundaries never initialize or grant',async()=>{
 const f=await authorized(),before=business(f),foreign=new Database(path.join(root,'main.db'));try{assert.equal(controls.enablePaperSchedule(foreign,f.context,f.actor,f.enableInput,f.scheduleTime).ok,false);}finally{foreign.close();}
 db.exec('BEGIN IMMEDIATE');try{assert.equal(enable(f).ok,false);assert.equal(disable(f).ok,false);assert.equal(read(f).ok,false);}finally{db.exec('ROLLBACK');}
 db.exec('CREATE TEMP TABLE USERS(id TEXT)');try{assert.equal(enable(f).ok,false);assert.equal(disable(f).ok,false);assert.equal(read(f).ok,false);}finally{db.exec('DROP TABLE temp.USERS');}
 db.pragma('query_only=ON');try{const schema=db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();assert.equal(read(f).ok,true);assert.equal(read(f).savedEnabled,false);assert.equal(read(f).authorization,'authorized');assert.equal(enable(f).ok,false);assert.equal(disable(f).ok,false);assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(),schema);}finally{db.pragma('query_only=OFF');}
 const driver=process.env.AGENT_PLAYER_DB;process.env.AGENT_PLAYER_DB='postgres';try{assert.equal(enable(f).ok,false);assert.equal(disable(f).ok,false);assert.equal(read(f).ok,false);}finally{if(driver===undefined)delete process.env.AGENT_PLAYER_DB;else process.env.AGENT_PLAYER_DB=driver;}
 assert.equal(saved(f).enabled,0);assert.deepEqual(business(f),before);
});

test('new same-owner session can inspect valid background authorization but cannot activate original-session grant',async()=>{
 const f=await authorized(),context={...f.context,sessionHash:'c'.repeat(64)};assert.equal(enable(f).ok,true);const before=saved(f);const status=controls.readPaperScheduleControl(db,context,f.actor,{jobId:f.job.id},f.scheduleTime);assert.equal(status.ok,true);assert.equal(status.savedEnabled,true);assert.equal(status.authorization,'authorized');assert.equal(status.registration,'not_observed');assert.equal(controls.enablePaperSchedule(db,context,f.actor,f.enableInput,f.scheduleTime).ok,false);assert.deepEqual(saved(f),before);assert.equal(controls.disablePaperSchedule(db,context,f.actor,{jobId:f.job.id},f.scheduleTime).ok,true);
});
test('emergency disable refuses wrong owner stale token generic adoption and post-write owner change',async()=>{
 const f=await authorized(),other=await authorized();assert.equal(enable(f).ok,true);const before=business(f);
 assert.equal(controls.disablePaperSchedule(db,other.context,other.actor,{jobId:f.job.id},f.scheduleTime).ok,false);assert.equal(controls.disablePaperSchedule(db,{...f.context,tokenVersion:f.context.tokenVersion+1},f.actor,{jobId:f.job.id},f.scheduleTime).ok,false);
 const original=db.prepare;let injected=false;db.prepare=function(statement){const prepared=original.call(this,statement);if(!injected&&/UPDATE main\.cron_jobs SET enabled=0/.test(statement))return new Proxy(prepared,{get(target,key){if(key==='run')return(...args)=>{const result=target.run(...args);injected=true;original.call(db,"UPDATE users SET role='user' WHERE id=?").run(f.ownerId);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});return prepared;};try{assert.equal(disable(f).ok,false);}finally{db.prepare=original;}assert.equal(injected,true);assert.equal(saved(f).enabled,1);assert.equal(db.prepare('SELECT role FROM users WHERE id=?').get(f.ownerId).role,'owner');assert.deepEqual(business(f),before);
 db.prepare("UPDATE cron_jobs SET action_type='custom' WHERE id=?").run(f.job.id);assert.equal(disable(f).ok,false);assert.equal(saved(f).enabled,1);
});

test('deleted factor with context version zero preserves owned saved status and emergency stop only',async()=>{
 const f=await authorized();assert.equal(enable(f).ok,true);const before=business(f);db.prepare('DELETE FROM verification_factors WHERE user_id=?').run(f.ownerId);const context={...f.context,factorVersion:0};const status=controls.readPaperScheduleControl(db,context,f.actor,{jobId:f.job.id},f.scheduleTime);assert.equal(status.ok,true);assert.equal(status.savedEnabled,true);assert.equal(status.authorization,'unavailable');assert.equal(controls.enablePaperSchedule(db,context,f.actor,f.enableInput,f.scheduleTime).ok,false);assert.equal(controls.disablePaperSchedule(db,context,f.actor,{jobId:f.job.id},f.scheduleTime).ok,true);assert.equal(saved(f).enabled,0);assert.deepEqual(business(f),before);
});
test('minimal ownership refuses consent shadows triggers and actual missing PK without repairing schema',async()=>{
 const f=await authorized();assert.equal(enable(f).ok,true);
 db.exec('CREATE TEMP TABLE PAPER_RUNTIME_CONSENTS(id TEXT)');try{assert.equal(disable(f).ok,false);assert.equal(read(f).ok,false);}finally{db.exec('DROP TABLE temp.PAPER_RUNTIME_CONSENTS');}
 db.exec('CREATE TRIGGER fixture_consent_trigger BEFORE UPDATE ON paper_runtime_consents BEGIN SELECT 1; END');try{assert.equal(disable(f).ok,false);assert.equal(read(f).ok,false);}finally{db.exec('DROP TRIGGER fixture_consent_trigger');}
 const originalSQL=db.prepare("SELECT sql FROM main.sqlite_master WHERE name='paper_runtime_consents' AND type='table'").get().sql;db.exec('CREATE TEMP TABLE fixture_saved_consents AS SELECT * FROM main.paper_runtime_consents');db.exec('DROP TABLE main.paper_runtime_consents');db.exec('CREATE TABLE paper_runtime_consents AS SELECT * FROM temp.fixture_saved_consents');
 try{const malformed=db.prepare("SELECT type,name,sql FROM main.sqlite_master WHERE tbl_name='paper_runtime_consents' ORDER BY name").all();assert.equal(db.prepare('SELECT owner_id FROM main.paper_runtime_consents WHERE id=?').get(f.g.consentId).owner_id,f.ownerId);assert.equal(disable(f).ok,false);assert.equal(read(f).ok,false);assert.equal(enable(f).ok,false);assert.equal(saved(f).enabled,1);assert.deepEqual(db.prepare("SELECT type,name,sql FROM main.sqlite_master WHERE tbl_name='paper_runtime_consents' ORDER BY name").all(),malformed);}finally{db.exec('DROP TABLE main.paper_runtime_consents');db.exec(originalSQL);db.exec('INSERT INTO main.paper_runtime_consents SELECT * FROM temp.fixture_saved_consents');db.exec('DROP TABLE temp.fixture_saved_consents');}
 assert.equal(read(f).ok,true);assert.equal(disable(f).ok,true);
});
test('fresh post-UPDATE grant expiry clock boundary rolls saved enable back',async()=>{
 const f=await authorized(),before=business(f),original=Date.now;let time=f.scheduleTime;Date.now=()=>time;const restore=afterEnableWrite(()=>{time=f.scheduleProof.preview.operation.authorizationExpiresAt;});
 try{assert.equal(controls.enablePaperSchedule(db,f.context,f.actor,f.enableInput).ok,false);}finally{Date.now=original;restore();}
 assert.equal(saved(f).enabled,0);assert.deepEqual(business(f),before);
});
