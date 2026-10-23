import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import Database from 'better-sqlite3';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'paper-paused-schedule-'));
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
async function ready(){
 const f=await fixture(),g=await grant(f),time=f.time+30000;
 const upgradeRequest={expectedRevision:1,targetManifestDigest:PAPER_EXECUTION_UPGRADE_CANDIDATE.manifestDigest};
 const r=await review.stagePaperExecutionUpgradeReview(db,f.context,f.actor,upgradeRequest,time);assert.equal(r.ok,true);
 const challenge=await review.issuePaperExecutionUpgradeProof(db,f.context,f.actor,r.id,time);assert.ok(challenge);
 const proof=await review.completePaperExecutionUpgradeProof(db,f.context,f.actor,r.id,challenge.token,f.otp(time),time);assert.ok(proof);
 return {...f,g,upgradeTime:time,upgradeReview:r,upgradeProof:proof,upgradeRequest};
}
const apply=f=>overlay.applyPaperExecutionUpgrade(db,f.context,f.actor,f.upgradeReview.id,f.upgradeProof.receipt,f.upgradeTime);
const definitions=await import('../src/scheduler/definitions.ts');
const auth=await import('../src/scheduler/authorization.ts');
const {captureScheduledDefinition,capturePaperRuntimeAction}=await import('../src/scheduler/authorization-definition.ts');
const {getCronEngine,CronEngine}=await import('../src/scheduler/engine.ts');
const {default:cron}=await import('node-cron');
const {default:Fastify}=await import('fastify');const {registerAuthGate}=await import('../src/auth/auth-gate.ts');const {generateToken}=await import('../src/auth/jwt.ts');
const {schedulerRoutes}=await import('../src/api/routes/scheduler.ts'),{schedulerAuthorizationRoutes}=await import('../src/api/routes/scheduler-authorization.ts');
const app=Fastify();registerAuthGate(app);await app.register(schedulerRoutes);await app.register(schedulerAuthorizationRoutes);await app.ready();test.after(async()=>{await app.close();await getCronEngine().stop();});
async function prepared(){const f=await ready();assert.equal((await apply(f)).ok,true);const time=f.upgradeTime+30000,id=randomUUID(),changes={name:'Paused paper cycle',cronExpression:'*/5 * * * *',actionType:'paper-runtime-cycle',actionData:{consentId:f.g.consentId}};const saved=await definitions.saveScheduledDefinition(f.actor,f.context.tokenVersion,id,0,changes,time);assert.equal(saved.job.enabled,false);return {...f,scheduleTime:time,saved,job:saved.job};}
async function scheduleProof(f){const expiresAt=Math.min(f.input.expiresAt,f.scheduleTime+60000),preview=await auth.scheduledAuthorizationPreview(f.context,f.actor,f.job.id,expiresAt,f.scheduleTime);const challenge=await auth.issueScheduledAuthorization(f.context,f.actor,preview.operation,f.scheduleTime),proof=await auth.completeScheduledAuthorization(challenge.token,f.context,f.actor,preview.operation,f.otp(f.scheduleTime),f.scheduleTime);assert.ok(proof);return {preview,proof};}
async function withClock(time,callback){const before=Date.now;Date.now=()=>time;try{return await callback();}finally{Date.now=before;}}
const attempts=f=>db.prepare('SELECT COUNT(*) n FROM paper_dispatch_attempts WHERE owner_id=?').get(f.ownerId).n;
const fills=f=>db.prepare('SELECT COUNT(*) n FROM paper_fills WHERE account_id=?').get(f.input.accountId).n;
test('typed paused definition and real existing schedule TOTP authorization disclose exact paper limits but never enable or dispatch',async()=>{
 const f=await prepared(),p=await scheduleProof(f);assert.equal(p.preview.review.actionType,'paper-runtime-cycle');assert.equal(p.preview.review.action.symbol,'AAA');assert.equal(p.preview.review.action.side,'buy');assert.equal(p.preview.review.action.amount,1000);assert.equal(p.preview.review.action.amountUnit,'account_minor_units');assert.equal(p.preview.review.action.currency,'USD');assert.equal(p.preview.review.action.maxAttempts,3);assert.equal(p.preview.review.action.attemptsConsumed,0);assert.equal(p.preview.review.action.cadenceMs,1000);assert.equal(p.preview.review.action.scheduleExpiresAt,p.preview.operation.authorizationExpiresAt);assert.equal(typeof p.preview.review.timeZone,'string');
 await auth.authorizeScheduledJob(p.proof.receipt,f.context,f.actor,p.preview.operation,f.scheduleTime);assert.equal(db.prepare('SELECT enabled FROM cron_jobs WHERE id=?').get(f.job.id).enabled,0);assert.equal(attempts(f),0);assert.equal(fills(f),0);
 assert.equal((await auth.inspectPausedPaperScheduleAuthorization(f.job,f.ownerId,f.scheduleTime)).status,'authorized');await assert.rejects(auth.assertScheduledDispatch(f.job,'manual',f.scheduleTime),/changed/);await assert.rejects(auth.assertScheduledDispatch(f.job,'scheduled',f.scheduleTime),/changed/);
 const definition=await withClock(f.scheduleTime,()=>definitions.readScheduledDefinition(f.actor,f.context.tokenVersion,f.job.id));assert.equal(definition.review.action.amount,1000);assert.equal(definition.enabled,false);
 const response=await withClock(f.scheduleTime,()=>app.inject({url:'/api/scheduler/jobs/'+f.job.id+'/authorization',headers:{authorization:'Bearer '+generateToken(f.ownerId,f.context.tokenVersion)}}));assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),{jobId:f.job.id,status:'execution_unavailable',authorization:'authorized',executionAvailable:false});
});
test('descriptor exact action and wrong owner expiry or stale current profile refuse before mutations or proof spend',async()=>{
 const f=await prepared(),other=await ready();assert.equal((await apply(other)).ok,true);await assert.rejects(definitions.saveScheduledDefinition(other.actor,other.context.tokenVersion,randomUUID(),0,{name:'Wrong owner',cronExpression:'0 9 * * *',actionType:'paper-runtime-cycle',actionData:{consentId:f.g.consentId}},f.scheduleTime));
 await assert.rejects(definitions.saveScheduledDefinition(other.actor,other.context.tokenVersion,f.job.id,1,{actionType:'api-call',actionData:{url:'https://example.invalid',method:'GET'}},f.scheduleTime));
 const base=f.job;for(const action of [{consentId:f.g.consentId,amount:99},{consentId:f.g.consentId+'\n'},{consentId:f.g.consentId,[Symbol('hidden')]:1}])assert.throws(()=>captureScheduledDefinition({...base,actionData:action}));let getters=0;const raw={};Object.defineProperty(raw,'consentId',{enumerable:true,get(){getters++;return f.g.consentId;}});assert.throws(()=>capturePaperRuntimeAction(raw));assert.equal(getters,0);
 await assert.rejects(definitions.saveScheduledDefinition(f.actor,f.context.tokenVersion,f.job.id,1,{actionData:{consentId:f.g.consentId,extra:true}},f.scheduleTime));await assert.rejects(auth.scheduledAuthorizationTarget(f.context,f.actor,f.job.id,f.input.expiresAt+1,f.scheduleTime));
 const p=await scheduleProof(f);execution.configurePaperExecution(db,{ownerId:f.ownerId,accountId:f.input.accountId,revision:2,feeBps:200,slippageBps:0,unitScale:1,currency:'USD'});await assert.rejects(auth.authorizeScheduledJob(p.proof.receipt,f.context,f.actor,p.preview.operation,f.scheduleTime));assert.equal(db.prepare('SELECT consumed_at FROM verification_receipts WHERE token_hash=?').get(createHash('sha256').update(p.proof.receipt).digest('hex')).consumed_at,null);assert.equal(attempts(f),0);
});
test('legacy routes refuse paper create edit enable and both manual aliases before persistence or callbacks; pause delete remain usable',async()=>{
 const f=await prepared(),engine=getCronEngine();engine.rememberPausedJob(f.job);let calls=0;const execute=engine.executeJob;engine.executeJob=async()=>{calls++;return {success:true};};const headers={authorization:'Bearer '+generateToken(f.ownerId,f.context.tokenVersion)},call=(method,path,payload)=>app.inject({method,url:'/api/scheduler/jobs'+path,headers,...(payload===undefined?{}:{payload})});const before=db.prepare('SELECT * FROM cron_jobs WHERE id=?').get(f.job.id);
 try{assert.equal((await call('POST','',{...f.job,enabled:true})).statusCode,409);assert.equal((await call('PUT','/'+f.job.id,{name:'Legacy changed'})).statusCode,409);for(const action of ['enable','execute','run'])assert.equal((await call('POST','/'+f.job.id+'/'+action,{})).statusCode,409);assert.deepEqual(db.prepare('SELECT * FROM cron_jobs WHERE id=?').get(f.job.id),before);assert.equal(calls,0);
  // A stale generic cache cannot conceal a persisted paper job from legacy guards.
  engine.rememberPausedJob({...f.job,actionType:'api-call',actionData:{method:'GET',url:'https://example.invalid'}});for(const action of ['enable','execute','run'])assert.equal((await call('POST','/'+f.job.id+'/'+action,{})).statusCode,409);assert.equal((await call('PUT','/'+f.job.id,{name:'Stale cache edit'})).statusCode,409);assert.deepEqual(db.prepare('SELECT * FROM cron_jobs WHERE id=?').get(f.job.id),before);assert.equal(calls,0);
  engine.rememberPausedJob(f.job);assert.equal((await call('POST','/'+f.job.id+'/disable',{})).statusCode,200);assert.equal((await call('DELETE','/'+f.job.id)).statusCode,200);assert.equal(db.prepare('SELECT 1 FROM cron_jobs WHERE id=?').get(f.job.id),undefined);
 }finally{engine.executeJob=execute;}
 assert.equal(attempts(f),0);assert.equal(fills(f),0);
});
test('engine start and direct manual call never register a paper timer or execute paper work',async()=>{
 const f=await prepared(),engine=new CronEngine(),original=cron.schedule,background=process.env.AGENT_PLAYER_BACKGROUND;let timers=0;cron.schedule=()=>{timers++;return {stop(){},destroy(){}};};process.env.AGENT_PLAYER_BACKGROUND='on';
 try{engine.scheduleJob({...f.job,enabled:true});assert.equal(timers,0);const result=await engine.executeJob(f.job.id);assert.equal(result.success,false);assert.equal(attempts(f),0);assert.equal(fills(f),0);db.prepare('UPDATE cron_jobs SET enabled=1 WHERE id=?').run(f.job.id);await engine.start();assert.equal(timers,0);assert.equal(engine.getJob(f.job.id).actionType,'paper-runtime-cycle');}
 finally{cron.schedule=original;if(background===undefined)delete process.env.AGENT_PLAYER_BACKGROUND;else process.env.AGENT_PLAYER_BACKGROUND=background;await engine.stop();}
});
test('post-authorization paper target mutation rolls back schedule proof and authorization event',async()=>{
 const f=await prepared(),p=await scheduleProof(f),original=db.prepare;let injected=false;
 db.prepare=function(text,...args){if(text.startsWith('INSERT INTO scheduled_job_authorization_events')){injected=true;original.call(this,'UPDATE paper_accounts SET stopped=1 WHERE account_id=?').run(f.input.accountId);}return original.call(this,text,...args);};
 try{await assert.rejects(auth.authorizeScheduledJob(p.proof.receipt,f.context,f.actor,p.preview.operation,f.scheduleTime));}finally{db.prepare=original;}
 assert.equal(injected,true);assert.equal(db.prepare('SELECT COUNT(*) n FROM scheduled_job_authorizations WHERE job_id=?').get(f.job.id).n,0);assert.equal(db.prepare('SELECT consumed_at FROM verification_receipts WHERE token_hash=?').get(createHash('sha256').update(p.proof.receipt).digest('hex')).consumed_at,null);assert.equal(db.prepare('SELECT stopped FROM paper_accounts WHERE account_id=?').get(f.input.accountId).stopped,0);
});

test('post-save current paper mutation is rolled back with definition revision and audit',async()=>{
 const f=await prepared(),original=db.prepare,before=db.prepare('SELECT * FROM cron_jobs WHERE id=?').get(f.job.id);let injected=false;
 db.prepare=function(text,...args){if(text.startsWith('INSERT INTO scheduled_job_definition_events')){injected=true;original.call(this,'UPDATE paper_accounts SET stopped=1 WHERE account_id=?').run(f.input.accountId);}return original.call(this,text,...args);};
 try{await assert.rejects(definitions.saveScheduledDefinition(f.actor,f.context.tokenVersion,f.job.id,1,{name:'Current checked save'},f.scheduleTime));}finally{db.prepare=original;}
 assert.equal(injected,true);assert.deepEqual(db.prepare('SELECT * FROM cron_jobs WHERE id=?').get(f.job.id),before);assert.equal(db.prepare('SELECT revision FROM scheduled_job_security_versions WHERE job_id=?').get(f.job.id).revision,1);assert.equal(db.prepare('SELECT stopped FROM paper_accounts WHERE account_id=?').get(f.input.accountId).stopped,0);
});

test('legacy store write locks reject paper and paper helper refuses foreign PG and TEMP without repair',async()=>{
 const f=await prepared(),{updateLegacyJobDefinition,setLegacyJobEnabled}=await import('../src/scheduler/store.ts'),{inspectPaperScheduleInTransaction}=await import('../src/scheduler/paper-authorization.ts');
 const before=db.prepare('SELECT * FROM cron_jobs WHERE id=?').get(f.job.id);await assert.rejects(updateLegacyJobDefinition({...f.job,actionType:'api-call',actionData:{url:'https://example.invalid',method:'GET'}}));await assert.rejects(setLegacyJobEnabled(f.job.id,true,new Date(f.scheduleTime)));assert.deepEqual(db.prepare('SELECT * FROM cron_jobs WHERE id=?').get(f.job.id),before);
 const foreign=new Database(process.env.DATABASE_PATH);try{assert.throws(()=>foreign.transaction(()=>inspectPaperScheduleInTransaction(foreign,f.ownerId,f.job.actionData,f.scheduleTime)).immediate());}finally{foreign.close();}
 const driver=process.env.AGENT_PLAYER_DB;process.env.AGENT_PLAYER_DB='postgres';try{assert.throws(()=>db.transaction(()=>inspectPaperScheduleInTransaction(db,f.ownerId,f.job.actionData,f.scheduleTime)).immediate());}finally{if(driver===undefined)delete process.env.AGENT_PLAYER_DB;else process.env.AGENT_PLAYER_DB=driver;}
 db.exec('CREATE TEMP VIEW CRON_JOBS AS SELECT * FROM main.cron_jobs');try{assert.throws(()=>db.transaction(()=>inspectPaperScheduleInTransaction(db,f.ownerId,f.job.actionData,f.scheduleTime)).immediate());}finally{db.exec('DROP VIEW temp.CRON_JOBS');}
 assert.deepEqual(db.prepare('SELECT * FROM cron_jobs WHERE id=?').get(f.job.id),before);assert.equal(attempts(f),0);
});
