// Actual enrolled-owner consent state in a throwaway database; no scheduler or external action runs.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes,randomUUID,createHash} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'ap-schedule-admission-'));process.chdir(dir);process.env.DATABASE_PATH=join(dir,'test.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();test.after(()=>closeDatabase());
const {beginEnrollment,activateEnrollment}=await import('../src/auth/verification/enrollment.ts'),{decodeSecret,hotp}=await import('../src/auth/verification/totp.ts');
const {insertJob,updateJobDefinition}=await import('../src/scheduler/store.ts');const {scheduledAuthorizationTarget,issueScheduledAuthorization,completeScheduledAuthorization,authorizeScheduledJob}=await import('../src/scheduler/authorization.ts');
const sha=v=>createHash('sha256').update(v).digest('hex');
async function fixture(){const now=Date.now(),owner='owner-'+randomUUID();db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'x','owner','active',1)").run(owner,owner+'@example.test',owner);const context={userId:owner,tokenVersion:2,factorVersion:1,sessionHash:sha(owner)},actor={kind:'user',role:'owner',userId:owner},setup=await beginEnrollment({...context,tokenVersion:1},now-60000);await activateEnrollment({...context,tokenVersion:1},hotp(decodeSecret(setup.secret),BigInt(Math.floor((now-60000)/30000))),now-60000);const job={id:randomUUID(),name:'Reviewed schedule',cronExpression:'0 9 * * *',actionType:'api-call',actionData:{url:'https://example.invalid/task',method:'POST',body:{text:'Local test'}},enabled:false,createdAt:new Date(now),updatedAt:new Date(now)};await insertJob(job);return {now,owner,context,actor,secret:setup.secret,job};}
async function proof(f,now=f.now){const operation=await scheduledAuthorizationTarget(f.context,f.actor,f.job.id,f.now+3600000,now),challenge=await issueScheduledAuthorization(f.context,f.actor,operation,now),receipt=await completeScheduledAuthorization(challenge.token,f.context,f.actor,operation,hotp(decodeSecret(f.secret),BigInt(Math.floor(now/30000))),now);assert.ok(receipt);return {operation,receipt:receipt.receipt};}
const authorize=(f,p,now=f.now)=>authorizeScheduledJob(p.receipt,f.context,f.actor,p.operation,now);
const {assertScheduledDispatch,assertScheduledDispatchInTransaction}=await import('../src/scheduler/authorization.ts');
const native=db.getDb();
async function ready(){const f=await fixture();await authorize(f,await proof(f));db.prepare('UPDATE cron_jobs SET enabled=1 WHERE id=?').run(f.job.id);return f;}
const admission=f=>native.transaction(()=>assertScheduledDispatchInTransaction(native,f.job,'manual',f.now)).immediate();
test('actual consumed TOTP provenance supports both wrappers without reconsumption; manual paused compatibility is explicit',async()=>{
 const f=await ready(),before=db.prepare('SELECT * FROM verification_receipts WHERE user_id=?').all(f.owner);
 assert.equal((await assertScheduledDispatch(f.job,'manual',f.now)).id,f.job.id);
 const a=admission(f);assert.equal(a.ownerId,f.owner);assert.equal(a.authorizationRevision,1);assert.ok(Object.isFrozen(a));assert.ok(Object.isFrozen(a.definition));
 assert.deepEqual(db.prepare('SELECT * FROM verification_receipts WHERE user_id=?').all(f.owner),before);
 db.prepare('UPDATE cron_jobs SET enabled=0 WHERE id=?').run(f.job.id);
 await assertScheduledDispatch(f.job,'manual',f.now);assert.throws(()=>admission(f),/changed/);
 assert.equal(native.transaction(()=>assertScheduledDispatchInTransaction(native,f.job,'manual',f.now,false)).immediate().ownerId,f.owner);
 await assert.rejects(assertScheduledDispatch(f.job,'scheduled',f.now),/changed/);
});
test('receipt expiry is historical, but original consumption/event/operation bindings remain mandatory',async()=>{
 const f=await ready();const grant=db.prepare('SELECT * FROM scheduled_job_authorizations WHERE job_id=?').get(f.job.id);
 db.prepare('UPDATE verification_receipts SET expires_at=? WHERE token_hash=?').run(f.now+1,grant.receipt_hash);
 await assertScheduledDispatch(f.job,'manual',f.now+2);
 for(const query of [
 "UPDATE verification_receipts SET consumed_at=NULL WHERE token_hash=?",
 "UPDATE verification_receipts SET operation_hash='"+'0'.repeat(64)+"' WHERE token_hash=?",
 "UPDATE verification_receipts SET session_hash='"+'0'.repeat(64)+"' WHERE token_hash=?",
 'UPDATE verification_receipts SET expires_at=? WHERE token_hash=?',
 'DELETE FROM verification_receipts WHERE token_hash=?',
 'UPDATE scheduled_job_authorization_events SET token_version=99 WHERE job_id=?',
 'DELETE FROM scheduled_job_authorization_events WHERE job_id=?'
 ]){
  const check=native.transaction(()=>{query.includes('scheduled_job_authorization_events')?db.prepare(query).run(f.job.id):query.includes('expires_at=?')?db.prepare(query).run(f.now,grant.receipt_hash):db.prepare(query).run(grant.receipt_hash);assert.throws(()=>assertScheduledDispatchInTransaction(native,f.job,'manual',f.now));throw new Error('rollback fixture');});
  assert.throws(()=>check.immediate(),/rollback fixture/);assert.equal(admission(f).ownerId,f.owner);
 }
});
test('repeated current guard rolls back caller effects after pause, revoke, edit, or owner revocation',async()=>{
 native.exec('CREATE TABLE admission_effects(id TEXT PRIMARY KEY)');
 for(const mutation of ['pause','revoke','edit','owner']){
  const f=await ready();assert.equal(admission(f).ownerId,f.owner);
  assert.throws(()=>native.transaction(()=>{
   assertScheduledDispatchInTransaction(native,f.job,'manual',f.now);
   native.prepare('INSERT INTO admission_effects VALUES(?)').run(f.job.id);
   if(mutation==='pause')native.prepare('UPDATE cron_jobs SET enabled=0 WHERE id=?').run(f.job.id);
   if(mutation==='revoke')native.prepare("UPDATE scheduled_job_authorizations SET status='revoked' WHERE job_id=?").run(f.job.id);
   if(mutation==='edit')native.prepare('UPDATE scheduled_job_security_versions SET revision=revision+1 WHERE job_id=?').run(f.job.id);
   if(mutation==='owner')native.prepare('UPDATE users SET token_version=token_version+1 WHERE id=?').run(f.owner);
   assertScheduledDispatchInTransaction(native,f.job,'manual',f.now);
  }).immediate());
  assert.equal(native.prepare('SELECT COUNT(*) n FROM admission_effects WHERE id=?').get(f.job.id).n,0);assert.equal(admission(f).ownerId,f.owner);
 }
});
test('sync write boundary refuses no transaction, foreign handle, TEMP shadow, query_only and invalid option',async()=>{
 const f=await ready();assert.throws(()=>assertScheduledDispatchInTransaction(native,f.job,'manual',f.now));
 const {default:Database}=await import('better-sqlite3');const foreign=new Database(process.env.DATABASE_PATH);
 try{assert.throws(()=>foreign.transaction(()=>assertScheduledDispatchInTransaction(foreign,f.job,'manual',f.now)).immediate());}finally{foreign.close();}
 native.exec('CREATE TEMP VIEW verification_receipts AS SELECT * FROM main.verification_receipts');assert.throws(()=>admission(f));native.exec('DROP VIEW temp.verification_receipts');
 native.pragma('query_only=ON');try{assert.throws(()=>native.transaction(()=>assertScheduledDispatchInTransaction(native,f.job,'manual',f.now)).deferred());}finally{native.pragma('query_only=OFF');}
 assert.throws(()=>native.transaction(()=>assertScheduledDispatchInTransaction(native,f.job,'manual',f.now,'yes')).immediate());
 assert.equal(admission(f).ownerId,f.owner);
});

test('case-insensitive TEMP shadows and authority tables without ordered primary keys are refused',async()=>{
 const f=await ready();
 for(const name of ['USERS','Scheduled_Job_Authorizations']){
  native.exec(`CREATE TEMP VIEW ${name} AS SELECT * FROM main.${name}`);
  try{assert.throws(()=>admission(f),/forbidden/);}finally{native.exec(`DROP VIEW temp.${name}`);}
 }
 const rebuild=native.transaction(()=>{
  native.exec('CREATE TABLE fixture_events AS SELECT * FROM scheduled_job_authorization_events');
  native.exec('DROP TABLE scheduled_job_authorization_events');
  native.exec('ALTER TABLE fixture_events RENAME TO scheduled_job_authorization_events');
  native.prepare('INSERT INTO scheduled_job_authorization_events SELECT job_id,version,job_revision,definition_hash,owner_id,token_version+99,factor_version,policy_version,authorized_at,expires_at,receipt_hash,session_hash FROM scheduled_job_authorization_events WHERE job_id=?').run(f.job.id);
  assert.equal(native.prepare('SELECT COUNT(*) n FROM scheduled_job_authorization_events WHERE job_id=?').get(f.job.id).n,2);
  assert.throws(()=>assertScheduledDispatchInTransaction(native,f.job,'manual',f.now),/forbidden/);
  throw new Error('rollback fixture schema');
 });
 assert.throws(()=>rebuild.immediate(),/rollback fixture schema/);
 assert.equal(admission(f).ownerId,f.owner);
});
