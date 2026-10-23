import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'paper-owned-cron-'));
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
async function armed(options={}){const f=await prepared(options),p=await scheduleProof(f,options.scheduleLifetimeMs??180000);await auth.authorizeScheduledJob(p.proof.receipt,f.context,f.actor,p.preview.operation,f.scheduleTime);db.prepare('UPDATE cron_jobs SET enabled=1 WHERE id=?').run(f.job.id);return {...f,scheduleProof:p};}
const {CronEngine,getCronEngine}=await import('../src/scheduler/engine.ts');
const {default:cron}=await import('node-cron');
const originalSchedule=cron.schedule,originalBackground=process.env.AGENT_PLAYER_BACKGROUND;
const timers=[],engines=[];
function mockedTimers(){cron.schedule=(expression,callback,options)=>{const task={expression,callback,options,stopped:false,destroyed:false,stop(){this.stopped=true;},destroy(){this.destroyed=true;}};timers.push(task);return task;};}
function engine(dependency=db){const instance=new CronEngine(dependency);engines.push(instance);return instance;}
async function started(f){const e=engine();await withClock(f.scheduleTime,()=>e.start());return e;}
const callbackAt=(timer,time)=>withClock(time,()=>timer.callback());
test.beforeEach(()=>{process.env.AGENT_PLAYER_BACKGROUND='on';mockedTimers();});
test.afterEach(async()=>{for(const e of engines.splice(0))await e.stop();timers.length=0;cron.schedule=originalSchedule;if(originalBackground===undefined)delete process.env.AGENT_PLAYER_BACKGROUND;else process.env.AGENT_PLAYER_BACKGROUND=originalBackground;db.prepare('UPDATE cron_jobs SET enabled=0').run();});
test('default null off and foreign adapters never register paper or claim; singleton remains disconnected',async()=>{
 const f=await armed();
 for(const e of [engine(null),getCronEngine()]){await withClock(f.scheduleTime,()=>e.start());assert.equal(e.getPaperStatus(f.job.id).registered,false);assert.equal((await e.executeJob(f.job.id)).success,false);await e.stop();}
 const foreign=new Database(path.join(root,'main.db'));try{const e=engine(foreign);await withClock(f.scheduleTime,()=>e.start());assert.equal(e.getPaperStatus(f.job.id).registered,false);}finally{foreign.close();}
 const closed=engine(foreign);await withClock(f.scheduleTime,()=>closed.start());assert.equal(closed.getPaperStatus(f.job.id).registered,false);
 process.env.AGENT_PLAYER_BACKGROUND='off';const off=await started(f);assert.equal(off.getPaperStatus(f.job.id).registered,false);assert.equal(timers.length,0);assert.equal(attempts(f),0);assert.equal(db.prepare('SELECT COUNT(*) n FROM job_executions WHERE job_id=?').get(f.job.id).n,0);
});
test('registered fixed callback uses reviewed timezone and actual completion history without changing cached schedule flags',async()=>{
 const f=await armed(),e=await started(f),timer=timers.at(-1),before=db.prepare('SELECT last_run,updated_at,enabled FROM cron_jobs WHERE id=?').get(f.job.id);
 assert.equal(timer.options.timezone,Intl.DateTimeFormat().resolvedOptions().timeZone);assert.equal(e.getPaperStatus(f.job.id).phase,'waiting');
 await callbackAt(timer,f.scheduleTime);assert.equal(attempts(f),1);assert.equal(fills(f),1);assert.equal(e.getPaperStatus(f.job.id).phase,'completed');assert.equal(e.getPaperStatus(f.job.id).historyRecorded,true);
 assert.deepEqual(db.prepare('SELECT last_run,updated_at,enabled FROM cron_jobs WHERE id=?').get(f.job.id),before);
 await callbackAt(timer,f.scheduleTime+999);assert.equal(e.getPaperStatus(f.job.id).phase,'refused');assert.equal(attempts(f),1);
 const history=db.prepare('SELECT success,output,error FROM job_executions WHERE job_id=? ORDER BY id').all(f.job.id);assert.equal(history.length,2);assert.equal(history[0].success,1);assert.equal(JSON.parse(history[0].output).status,'completed');assert.equal(history[1].success,0);assert.equal(history[1].error,'Paper cron refused');
});
test('retained callbacks after unschedule replacement and stop cannot act or change outcome history',async()=>{
 const f=await armed(),e=await started(f),old=timers.at(-1);e.unscheduleJob(f.job.id);await callbackAt(old,f.scheduleTime);assert.equal(attempts(f),0);assert.equal(old.destroyed,true);
 await withClock(f.scheduleTime,()=>e.scheduleJob({...e.getJob(f.job.id)}));const replaced=timers.at(-1);await withClock(f.scheduleTime,()=>e.scheduleJob({...e.getJob(f.job.id)}));await callbackAt(replaced,f.scheduleTime);assert.equal(attempts(f),0);const current=timers.at(-1);await e.stop();await callbackAt(current,f.scheduleTime);assert.equal(attempts(f),0);assert.equal((await e.executeJob(f.job.id)).success,false);assert.equal(e.getPaperStatus(f.job.id).phase,'stopped');assert.equal(current.destroyed,true);
});
test('paused deleted and revoked persisted jobs refuse at callback even with a retained registration',async()=>{
 for(const change of ['paused','deleted','revoked']){const f=await armed(),e=await started(f),timer=timers.at(-1);if(change==='paused')db.prepare('UPDATE cron_jobs SET enabled=0 WHERE id=?').run(f.job.id);if(change==='deleted')db.prepare('DELETE FROM cron_jobs WHERE id=?').run(f.job.id);if(change==='revoked')db.prepare("UPDATE scheduled_job_authorizations SET status='revoked' WHERE job_id=?").run(f.job.id);await callbackAt(timer,f.scheduleTime);assert.equal(attempts(f),0);assert.equal(fills(f),0);assert.equal(e.getPaperStatus(f.job.id).phase,'refused');await e.stop();}
});
test('real same-hash TOTP reauthorization invalidates old registered closure; fresh registration can execute',async()=>{
 const f=await armed(),e=await started(f),old=timers.at(-1),time=f.scheduleTime+30000;db.prepare('UPDATE cron_jobs SET enabled=0 WHERE id=?').run(f.job.id);
 execution.recordPaperExecutionQuote(db,{accountId:f.input.accountId,symbol:'AAA',priceMinor:100,quotedAt:time,revision:f.quoteRevision+1,currency:'USD',unitScale:1});
 const p=await scheduleProof({...f,scheduleTime:time});await auth.authorizeScheduledJob(p.proof.receipt,f.context,f.actor,p.preview.operation,time);db.prepare('UPDATE cron_jobs SET enabled=1 WHERE id=?').run(f.job.id);
 await callbackAt(old,time);assert.equal(attempts(f),0);assert.equal(e.getPaperStatus(f.job.id).phase,'refused');await withClock(time,()=>e.scheduleJob({...e.getJob(f.job.id)}));await callbackAt(timers.at(-1),time);assert.equal(attempts(f),1);assert.equal(fills(f),1);assert.equal(e.getPaperStatus(f.job.id).phase,'completed');
});
test('two owned instances share canonical budget and stopping one does not stop the other',async()=>{
 const f=await armed(),a=await started(f),ta=timers.at(-1),b=await started(f),tb=timers.at(-1);await callbackAt(ta,f.scheduleTime);await callbackAt(tb,f.scheduleTime);assert.equal(attempts(f),1);assert.equal(fills(f),1);await a.stop();assert.equal(tb.destroyed,false);await callbackAt(tb,f.scheduleTime+1000);assert.equal(attempts(f),2);assert.equal(fills(f),2);assert.equal(b.getPaperStatus(f.job.id).phase,'completed');
});
test('restart pending never resumes and lease expiry becomes unknown without resetting budget',async()=>{
 const f=await armed();const fence=db.transaction(()=>resolvePaperScheduleExecutionInTransaction(db,{jobId:f.job.id,trigger:'scheduled'},f.scheduleTime)).deferred();const key=dispatch.derivePaperRuntimeDueAttemptKey(f.g.consentId,f.g.definitionId,f.g.definitionDigest,1);
 const claimed=dispatch.claimScheduledCanonicalPaperDispatchAttempt(db,f.ownerId,{definitionId:f.g.definitionId,definitionDigest:f.g.definitionDigest,attemptKey:key,leaseMs:60000},f.g.consentId,fence,f.scheduleTime);assert.equal(claimed.ok,true);
 const e=await started(f),timer=timers.at(-1);await callbackAt(timer,f.scheduleTime+1);assert.equal(e.getPaperStatus(f.job.id).phase,'pending');assert.equal(fills(f),0);assert.equal(attempts(f),1);
 // Registration remains a constraint; expiry reconciliation is journal-only, never an order retry.
 execution.recordPaperExecutionQuote(db,{accountId:f.input.accountId,symbol:'AAA',priceMinor:100,quotedAt:f.scheduleTime+60000,revision:f.quoteRevision+1,currency:'USD',unitScale:1});await callbackAt(timer,f.scheduleTime+60000);assert.equal(e.getPaperStatus(f.job.id).phase,'unknown');assert.equal(attempts(f),1);assert.equal(fills(f),0);
});
test('host timezone changes fail closed and read-only callback creates no history or paper writes',async()=>{
 const f=await armed(),e=await started(f),timer=timers.at(-1),before=process.env.TZ;try{process.env.TZ=Intl.DateTimeFormat().resolvedOptions().timeZone==='UTC'?'Europe/Vienna':'UTC';await callbackAt(timer,f.scheduleTime);assert.equal(attempts(f),0);}finally{if(before===undefined)delete process.env.TZ;else process.env.TZ=before;}
 db.pragma('query_only=ON');try{await callbackAt(timer,f.scheduleTime);assert.equal(attempts(f),0);assert.equal(e.getPaperStatus(f.job.id).phase,'refused');assert.equal(e.getPaperStatus(f.job.id).historyRecorded,false);}finally{db.pragma('query_only=OFF');}
});
test('stop during async startup and concurrent starts cannot leave an owned paper timer',async()=>{
 const f=await armed(),e=engine(),start=e.start();await e.stop();await start;assert.equal(timers.length,0);assert.equal(attempts(f),0);
 const other=engine();await withClock(f.scheduleTime,()=>Promise.all([other.start(),other.start()]));assert.equal(timers.length,1);await other.stop();assert.equal(timers[0].destroyed,true);
});
test('real node-cron owned task invokes fixed paper callback and is destroyed on stop',async()=>{
 cron.schedule=originalSchedule;const f=await armed();
 // Reauthor the actual every-second definition through the existing reviewed save/proof flow.
 db.prepare('UPDATE cron_jobs SET enabled=0 WHERE id=?').run(f.job.id);const revision=db.prepare('SELECT revision FROM scheduled_job_security_versions WHERE job_id=?').get(f.job.id).revision;
 const saved=await definitions.saveScheduledDefinition(f.actor,f.context.tokenVersion,f.job.id,revision,{name:f.job.name,cronExpression:'* * * * * *',actionType:'paper-runtime-cycle',actionData:{consentId:f.g.consentId}},f.scheduleTime+30000);
 const time=f.scheduleTime+30000;execution.recordPaperExecutionQuote(db,{accountId:f.input.accountId,symbol:'AAA',priceMinor:100,quotedAt:time,revision:f.quoteRevision+1,currency:'USD',unitScale:1});const p=await scheduleProof({...f,job:saved.job,scheduleTime:time});await auth.authorizeScheduledJob(p.proof.receipt,f.context,f.actor,p.preview.operation,time);db.prepare('UPDATE cron_jobs SET enabled=1 WHERE id=?').run(f.job.id);
 const e=engine();await withClock(time,async()=>{await e.start();await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('owned cron callback timeout')),3000);e.once('job:executed',()=>{clearTimeout(timeout);resolve();});});await e.stop();});assert.equal(attempts(f),1);assert.equal(fills(f),1);assert.equal(e.getPaperStatus(f.job.id).phase,'stopped');
});

test('real reauthorized grant committed after released callback snapshot cannot be adopted under claim lock',async()=>{
 const f=await armed(),e=await started(f),timer=timers.at(-1),time=f.scheduleTime+30000;
 const previous=db.prepare('SELECT * FROM scheduled_job_authorizations WHERE job_id=?').get(f.job.id);
 db.prepare('UPDATE cron_jobs SET enabled=0 WHERE id=?').run(f.job.id);execution.recordPaperExecutionQuote(db,{accountId:f.input.accountId,symbol:'AAA',priceMinor:100,quotedAt:time,revision:f.quoteRevision+1,currency:'USD',unitScale:1});
 const p=await scheduleProof({...f,scheduleTime:time});await auth.authorizeScheduledJob(p.proof.receipt,f.context,f.actor,p.preview.operation,time);db.prepare('UPDATE cron_jobs SET enabled=1 WHERE id=?').run(f.job.id);
 const next=db.prepare('SELECT * FROM scheduled_job_authorizations WHERE job_id=?').get(f.job.id),event=db.prepare('SELECT * FROM scheduled_job_authorization_events WHERE job_id=? AND version=?').get(f.job.id,next.version);
 const replace=(table,row,key)=>{const fields=Object.keys(row).filter(k=>k!==key);db.prepare('UPDATE '+table+' SET '+fields.map(k=>k+'=?').join(',')+' WHERE '+key+'=?').run(...fields.map(k=>row[k]),row[key]);};
 replace('scheduled_job_authorizations',previous,'job_id');db.prepare('DELETE FROM scheduled_job_authorization_events WHERE job_id=? AND version=?').run(f.job.id,next.version);db.prepare('UPDATE verification_receipts SET consumed_at=NULL WHERE token_hash=?').run(next.receipt_hash);
 const original=db.transaction;let reads=0;db.transaction=function(fn,...args){const tx=original.call(this,fn,...args),wrap=(...v)=>tx(...v);wrap.immediate=(...v)=>tx.immediate(...v);wrap.exclusive=(...v)=>tx.exclusive(...v);wrap.deferred=(...v)=>{const result=tx.deferred(...v);if(!db.inTransaction&&++reads===2){replace('scheduled_job_authorizations',next,'job_id');const fields=Object.keys(event);db.prepare('INSERT INTO scheduled_job_authorization_events('+fields.join(',')+') VALUES('+fields.map(()=>'?').join(',')+')').run(...fields.map(k=>event[k]));db.prepare('UPDATE verification_receipts SET consumed_at=? WHERE token_hash=?').run(next.authorized_at,next.receipt_hash);}return result;};return wrap;};
 try{await callbackAt(timer,time);}finally{db.transaction=original;}
 assert.equal(reads>=2,true);assert.equal(attempts(f),0);assert.equal(fills(f),0);assert.equal(e.getPaperStatus(f.job.id).phase,'refused');await withClock(time,()=>e.scheduleJob({...e.getJob(f.job.id)}));await callbackAt(timers.at(-1),time);assert.equal(attempts(f),1);assert.equal(fills(f),1);
});
test('availability reflects background switch after registration without claiming running or new effects',async()=>{
 const f=await armed(),e=await started(f),timer=timers.at(-1);process.env.AGENT_PLAYER_BACKGROUND='off';assert.equal(e.getPaperStatus(f.job.id).registered,true);assert.equal(e.getPaperStatus(f.job.id).phase,'unavailable');await callbackAt(timer,f.scheduleTime);assert.equal(attempts(f),0);process.env.AGENT_PLAYER_BACKGROUND='on';assert.equal(e.getPaperStatus(f.job.id).phase,'waiting');
});

test('retained generic closure cannot adopt a newly registered paper definition at the same ID',async()=>{
 const f=await armed(),e=await started(f);e.scheduleJob({...e.getJob(f.job.id),actionType:'custom',actionData:{functionName:'unsupported'}});const generic=timers.at(-1);await withClock(f.scheduleTime,()=>e.scheduleJob({...f.job,enabled:true}));const paper=timers.at(-1);await callbackAt(generic,f.scheduleTime);assert.equal(attempts(f),0);assert.equal(db.prepare('SELECT COUNT(*) n FROM job_executions WHERE job_id=?').get(f.job.id).n,0);await callbackAt(paper,f.scheduleTime);assert.equal(attempts(f),1);
});
test('registered lower entry requires complete immutable constraint and rejects missing or changed fields',async()=>{
 const f=await armed(),{dispatchRegisteredScheduledPaperRuntime}=await import('../src/services/trading-paper-runtime-dispatch.ts');const fence=db.transaction(()=>resolvePaperScheduleExecutionInTransaction(db,{jobId:f.job.id,trigger:'scheduled'},f.scheduleTime)).deferred();
 for(const bad of [undefined,null,false,0,'',{},[],{...fence,authorizationRevision:fence.authorizationRevision+1},{...fence,trigger:'manual'},{...fence,extra:true}])assert.equal(dispatchRegisteredScheduledPaperRuntime(db,{jobId:f.job.id,trigger:'scheduled'},bad,f.scheduleTime).ok,false);
 assert.equal(attempts(f),0);
});

test('generic callback awaiting claim cannot adopt paper after replacement or write a stale heartbeat',async()=>{
 const f=await armed(),e=await started(f);e.scheduleJob({...e.getJob(f.job.id),actionType:'custom',actionData:{functionName:'unsupported'}});const generic=timers.at(-1),before=db.prepare('SELECT last_run,updated_at FROM cron_jobs WHERE id=?').get(f.job.id);
 await withClock(f.scheduleTime,async()=>{const waiting=generic.callback();e.scheduleJob({...f.job,enabled:true});await waiting;});assert.equal(attempts(f),0);assert.deepEqual(db.prepare('SELECT last_run,updated_at FROM cron_jobs WHERE id=?').get(f.job.id),before);assert.equal(db.prepare('SELECT COUNT(*) n FROM job_executions WHERE job_id=?').get(f.job.id).n,0);
});

test('generic after-run SQL cannot project a stale heartbeat after persisted cross-type replacement at write boundary',async()=>{
 const f=await armed(),e=await started(f),before=db.prepare('SELECT last_run,next_run,updated_at FROM cron_jobs WHERE id=?').get(f.job.id);db.prepare("UPDATE cron_jobs SET action_type='custom' WHERE id=?").run(f.job.id);e.scheduleJob({...e.getJob(f.job.id),actionType:'custom',actionData:{functionName:'unsupported'}});const timer=timers.at(-1),original=db.prepare;let injected=false;
 db.prepare=function(statement){if(!injected&&/UPDATE\s+cron_jobs\s+SET\s+last_run/i.test(statement)){injected=true;original.call(this,"UPDATE cron_jobs SET action_type='paper-runtime-cycle' WHERE id=?").run(f.job.id);}return original.call(this,statement);};
 try{await callbackAt(timer,f.scheduleTime);}finally{db.prepare=original;}
 assert.equal(injected,true);assert.equal(db.prepare('SELECT action_type FROM cron_jobs WHERE id=?').get(f.job.id).action_type,'paper-runtime-cycle');assert.deepEqual(db.prepare('SELECT last_run,next_run,updated_at FROM cron_jobs WHERE id=?').get(f.job.id),before);assert.equal(attempts(f),0);assert.equal(fills(f),0);
});
