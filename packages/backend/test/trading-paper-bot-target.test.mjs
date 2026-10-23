import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import Database from 'better-sqlite3';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'paper-bot-target-'));
Object.assign(process.env,{AGENT_PLAYER_DATA_DIR:root,DATABASE_PATH:path.join(root,'main.db'),JWT_SECRET:randomBytes(64).toString('hex'),ENCRYPTION_KEY:randomBytes(32).toString('hex')});delete process.env.AGENT_PLAYER_DB;
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const main=getDatabase();await main.initialize();const db=main.getDb();
const activation=await import('../src/services/trading-paper-bot-activation.ts'),ledger=await import('../src/services/trading-paper-ledger.ts'),execution=await import('../src/services/trading-paper-execution.ts'),bots=await import('../src/services/trading-paper-bots.ts');
const {enrollInstallOwner,reviewedInstall}=await import('./fixtures/reviewed-paper-install.mjs');const now=Date.now();
async function fixture({caps=['paper.account.read','paper.bot.manage'],maxSuccessfulTicks=3}={}){
 const ownerId='target-owner-'+randomUUID();db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'fixture','owner','active',1)").run(ownerId,ownerId+'@example.invalid',ownerId);
 const f=await enrollInstallOwner(ownerId,now-90000);await reviewedInstall(db,f,{now:now-60000,capabilities:caps});const time=now-30000,accountId='account-'+randomUUID(),policyId='policy-'+randomUUID();
 const policy={id:policyId,ownerId,accountId,revision:1,appRevision:1,currency:'USD',enabled:true,mode:'paper',expiresAt:now+86400000,symbols:['AAA'],maxOrder:1000,maxExposure:100000,maxDailyLoss:1000,maxOrders:100,cooldownMs:0,maxQuoteAgeMs:5000};ledger.provisionPaperAccount(db,{policy,cash:100000,exposure:0});execution.configurePaperExecution(db,{ownerId,accountId,revision:1,feeBps:100,slippageBps:0,unitScale:1,currency:'USD'});
 const input={accountId,policyId,policyRevision:1,appRevision:1,expiresAt:time+600000,maxSuccessfulTicks,cooldownMs:1000};
 const stage=await activation.stagePaperBotActivation(db,f.context,f.actor,input,time);assert.equal(stage.ok,true);const challenge=await activation.issuePaperBotActivationProof(db,f.context,f.actor,stage.id,time);assert.ok(challenge?.token);const proof=await activation.completePaperBotActivationProof(db,f.context,f.actor,stage.id,challenge.token,f.otp(time),time);assert.ok(proof?.receipt);assert.equal((await activation.applyPaperBotActivation(db,f.context,f.actor,stage.id,proof.receipt,time)).ok,true);
 return {...f,ownerId,time,policy,input,stage,proof,botId:stage.botId};
}
const resolve=(f,time=f.time)=>activation.readReviewedPaperBotTarget(db,f.ownerId,f.botId,time);
const schema=()=>db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
const state=f=>({bot:db.prepare('SELECT * FROM paper_bots WHERE bot_id=?').get(f.botId),events:db.prepare('SELECT * FROM paper_bot_activation_events WHERE bot_id=?').all(f.botId),receipt:db.prepare('SELECT consumed_at FROM verification_receipts WHERE token_hash=?').get(createHash('sha256').update(f.proof.receipt).digest('hex')),accounts:db.prepare('SELECT * FROM paper_accounts WHERE account_id=?').all(f.input.accountId)});
test.after(async()=>{closeDatabase();await fs.rm(root,{recursive:true,force:true});});
test('real applied owner activation resolves immutable current target without any execution grant',async()=>{
 const f=await fixture(),result=resolve(f);assert.equal(result.ok,true);assert.equal(result.botId,f.botId);assert.equal(result.reviewId,f.stage.id);assert.equal(result.activationCreatedAt,f.time);assert.equal(result.definition.accountId,f.input.accountId);assert.equal(result.definition.policyId,f.input.policyId);assert.equal(result.installationRevision,1);assert.equal(result.executeOrders,false);assert.equal(result.runtimeConnected,false);assert.equal(Object.isFrozen(result),true);assert.equal(Object.isFrozen(result.definition.limits.symbols),true);assert.equal(Object.isFrozen(result.definition.execution),true);assert.equal(JSON.stringify(result).includes(f.proof.receipt),false);assert.doesNotMatch(JSON.stringify(result),/session_hash|sealed_secret|fenceToken/);
});
test('current token/factor/proof-policy version rotation preserves original consumed activation consent',async()=>{
 const f=await fixture();db.prepare('UPDATE users SET token_version=token_version+1 WHERE id=?').run(f.ownerId);db.prepare('UPDATE verification_factors SET version=version+1 WHERE user_id=?').run(f.ownerId);const version=db.prepare('SELECT version FROM approval_proof_policy WHERE id=1').get().version;db.exec('UPDATE approval_proof_policy SET version=version+1 WHERE id=1');try{assert.equal(resolve(f).ok,true);}finally{db.prepare('UPDATE approval_proof_policy SET version=? WHERE id=1').run(version);}
 db.prepare('UPDATE verification_factors SET enabled=0 WHERE user_id=?').run(f.ownerId);assert.equal(resolve(f).ok,false);
});
test('raw provisioned and orphan bots or read-only installation grants do not establish reviewed runtime target',async()=>{
 const f=await fixture(),rawId=randomUUID();assert.equal(bots.provisionPaperBot(db,{botId:rawId,ownerId:f.ownerId,...f.input},()=>f.time).ok,true);assert.equal(activation.readReviewedPaperBotTarget(db,f.ownerId,rawId,f.time).ok,false);
 const g=await fixture({caps:['paper.account.read']});assert.equal(resolve(g).ok,false);
 const event=db.prepare('SELECT * FROM paper_bot_activation_events WHERE bot_id=?').get(f.botId);db.prepare('DELETE FROM paper_bot_activation_events WHERE bot_id=?').run(f.botId);assert.equal(resolve(f).ok,false);db.prepare('INSERT INTO paper_bot_activation_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...['id','review_id','bot_id','owner_id','session_hash','token_version','factor_version','policy_version','definition_hash','review_hash','receipt_hash','created_at','event_hash'].map(k=>event[k]));assert.equal(resolve(f).ok,true);
});
test('stop revoke expiry disabled installation and owner/factor revocation refuse current targets',async()=>{
 for(const action of ['stop','revoke','disable','expiry','owner']){const f=await fixture();if(action==='stop')bots.stopPaperBot(db,f.ownerId,f.botId);if(action==='revoke')bots.revokePaperBot(db,f.ownerId,f.botId);if(action==='disable')await reviewedInstall(db,f,{now,action:'disable',expectedRevision:1});if(action==='owner')db.prepare("UPDATE users SET role='user' WHERE id=?").run(f.ownerId);assert.equal(resolve(f,action==='expiry'?f.input.expiresAt:now).ok,false);}
});
test('changed current profile policy hashes account stop and risk deny stale target consent',async()=>{
 for(const action of ['profile','policy','policy-revocation','account-stop','app-revision']){const f=await fixture();if(action==='profile')execution.configurePaperExecution(db,{ownerId:f.ownerId,accountId:f.input.accountId,revision:2,feeBps:200,slippageBps:0,unitScale:1,currency:'USD'});if(action==='policy')db.prepare('UPDATE paper_policies SET policy_json=? WHERE policy_id=?').run(JSON.stringify({...f.policy,maxOrder:999}),f.input.policyId);if(action==='policy-revocation')ledger.revokePaperPolicy(db,f.ownerId,f.input.accountId,f.input.policyId);if(action==='account-stop')ledger.stopPaperAccount(db,f.ownerId,f.input.accountId);if(action==='app-revision')db.prepare('UPDATE paper_accounts SET app_revision=2 WHERE account_id=?').run(f.input.accountId);assert.equal(resolve(f).ok,false);}
});
test('altered review/event/receipt link or bot immutable field cannot be adopted',async()=>{
 const f=await fixture(),tokenHash=createHash('sha256').update(f.proof.receipt).digest('hex');
 for(const [sql,args,restore,values]of [
  ["UPDATE paper_bot_activation_events SET event_hash='bad' WHERE bot_id=?",[f.botId],'UPDATE paper_bot_activation_events SET event_hash=? WHERE bot_id=?',[db.prepare('SELECT event_hash FROM paper_bot_activation_events WHERE bot_id=?').get(f.botId).event_hash,f.botId]],
  ["UPDATE paper_bot_activation_reviews SET status='staged' WHERE id=?",[f.stage.id],"UPDATE paper_bot_activation_reviews SET status='applied' WHERE id=?",[f.stage.id]],
  ['UPDATE verification_receipts SET consumed_at=NULL WHERE token_hash=?',[tokenHash],'UPDATE verification_receipts SET consumed_at=? WHERE token_hash=?',[f.time,tokenHash]],
  ["UPDATE verification_receipts SET operation_hash='bad' WHERE token_hash=?",[tokenHash],'UPDATE verification_receipts SET operation_hash=? WHERE token_hash=?',[db.prepare('SELECT operation_hash FROM verification_receipts WHERE token_hash=?').get(tokenHash).operation_hash,tokenHash]],
  ['UPDATE paper_bots SET max_successful_ticks=4 WHERE bot_id=?',[f.botId],'UPDATE paper_bots SET max_successful_ticks=3 WHERE bot_id=?',[f.botId]],
 ]){db.prepare(sql).run(...args);assert.equal(resolve(f).ok,false);db.prepare(restore).run(...values);assert.equal(resolve(f).ok,true);}
});
async function tick(f){const at=f.time+1000;execution.recordPaperExecutionQuote(db,{accountId:f.input.accountId,symbol:'AAA',priceMinor:100,quotedAt:at,revision:1,currency:'USD',unitScale:1});const reservation=ledger.reservePaperOrder(db,f.ownerId,{accountId:f.input.accountId,policyId:f.input.policyId,policyRevision:1,appRevision:1,currency:'USD',symbol:'AAA',side:'buy',notional:1000,idempotencyKey:'tick'},()=>at);assert.equal(reservation.ok,true);assert.equal(bots.runPaperBotTick(db,f.ownerId,{botId:f.botId,tickKey:'tick',side:'buy',reservationId:reservation.reservationId},()=>at).ok,true);return at;}
test('full historical tick receipt validation accepts remaining budget during cooldown but rejects corruption and exhaustion',async()=>{
 const f=await fixture(),at=await tick(f),result=resolve(f,at+1);assert.equal(result.ok,true);assert.equal(result.successfulTicks,1);assert.equal(result.lastSuccessAt,at);
 db.prepare("UPDATE paper_bot_ticks SET receipt_hash='bad' WHERE bot_id=?").run(f.botId);assert.equal(resolve(f,at+1).ok,false);
 const g=await fixture({maxSuccessfulTicks:1}),finished=await tick(g);assert.equal(resolve(g,finished+1).ok,false);
});
test('query-only and caller-owned snapshots perform no schema/data/receipt mutation',async()=>{
 const f=await fixture(),before=state(f),beforeSchema=schema(),changes=db.prepare('SELECT total_changes() n').get().n;db.pragma('query_only=ON');try{assert.equal(resolve(f).ok,true);db.transaction(()=>assert.equal(resolve(f).ok,true)).deferred();assert.deepEqual(state(f),before);assert.deepEqual(schema(),beforeSchema);assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);}finally{db.pragma('query_only=OFF');}
});
test('foreign same-file handles malformed identity future clock and TEMP/auth/bundle effects refuse',async()=>{
 const f=await fixture();for(const foreign of [new Database(process.env.DATABASE_PATH),new Database(':memory:')])try{assert.equal(activation.readReviewedPaperBotTarget(foreign,f.ownerId,f.botId,f.time).ok,false);}finally{foreign.close();}
 assert.equal(activation.readReviewedPaperBotTarget(db,f.ownerId,f.botId+'\n',f.time).ok,false);assert.equal(resolve(f,f.time-1).ok,false);assert.equal(resolve(f,NaN).ok,false);assert.equal(activation.readReviewedPaperBotTarget(db,'mock-user',f.botId,f.time).ok,false);
 for(const table of ['users','verification_receipts','paper_bot_activation_reviews','paper_bot_activation_events','paper_bots','paper_execution_profiles']){db.exec(`CREATE TEMP TABLE ${table}(id TEXT)`);try{assert.equal(resolve(f).ok,false);}finally{db.exec(`DROP TABLE temp.${table}`);}}
 db.exec('CREATE TRIGGER target_unexpected AFTER UPDATE ON paper_bots BEGIN SELECT 1; END');try{assert.equal(resolve(f).ok,false);}finally{db.exec('DROP TRIGGER target_unexpected');}
 process.env.AGENT_PLAYER_DB='postgres';try{assert.equal(resolve(f).ok,false);}finally{delete process.env.AGENT_PLAYER_DB;}
});
