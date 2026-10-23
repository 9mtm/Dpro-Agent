import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'paper-installation-'));
process.env.AGENT_PLAYER_DATA_DIR=root;process.env.DATABASE_PATH=path.join(root,'main.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');delete process.env.AGENT_PLAYER_DB;
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const main=getDatabase();await main.initialize();const db=main.getDb();
const {BUNDLED_PAPER_INSTALLATION:bundle,provisionTrustedPaperInstallation:provision,readPaperInstallation:read}=await import('../src/services/trading-paper-installation.ts');
const {PAPER_BUNDLE_SCHEMA,inspectPaperBundleSchema}=await import('../src/services/trading-paper-bundle-schema.ts');
const ledger=await import('../src/services/trading-paper-ledger.ts'),execution=await import('../src/services/trading-paper-execution.ts'),bots=await import('../src/services/trading-paper-bots.ts');
const now=1800000000000;
function owner(role='owner',extra={}){const userId='install-'+randomUUID();db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'fixture',?,?,?)").run(userId,userId+'@example.invalid',userId,role,extra.status??'active',extra.emailVerified??1);return userId;}
const request=(key='install',caps=['paper.account.read','paper.bot.manage'])=>({action:'install',idempotencyKey:key,expectedRevision:0,manifestDigest:bundle.manifestDigest,capabilities:caps});
const command=(action,revision,key)=>({action,idempotencyKey:key,expectedRevision:revision,manifestDigest:bundle.manifestDigest,capabilities:[]});
const schema=()=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','view','index','trigger') ORDER BY type,name").all();
function rows(table,userId){return db.prepare(`SELECT * FROM main.${table} WHERE owner_id=? ORDER BY rowid`).all(userId);}
function seed(userId){
 const accountId='account-'+userId,policyId='policy-'+userId,botId='bot-'+userId;
 const policy={id:policyId,revision:1,appRevision:1,currency:'USD',ownerId:userId,accountId,enabled:true,mode:'paper',expiresAt:now+600000,symbols:['AAA'],maxOrder:10000,maxExposure:10000,maxDailyLoss:1000,maxOrders:100,cooldownMs:0,maxQuoteAgeMs:5000};
 ledger.provisionPaperAccount(db,{policy,cash:10000,exposure:0});execution.configurePaperExecution(db,{ownerId:userId,accountId,revision:1,feeBps:100,slippageBps:0,unitScale:1,currency:'USD'});execution.recordPaperExecutionQuote(db,{accountId,symbol:'AAA',priceMinor:1000,quotedAt:now,revision:1,currency:'USD',unitScale:1});
 assert.equal(bots.provisionPaperBot(db,{botId,ownerId:userId,accountId,policyId,policyRevision:1,appRevision:1,expiresAt:now+300000,maxSuccessfulTicks:3,cooldownMs:0},()=>now).ok,true);
 const reservation=ledger.reservePaperOrder(db,userId,{accountId,policyId,policyRevision:1,appRevision:1,currency:'USD',symbol:'AAA',side:'buy',notional:1010,idempotencyKey:'seed-reservation'},()=>now);assert.equal(reservation.ok,true);
 assert.equal(bots.runPaperBotTick(db,userId,{botId,tickKey:'seed-tick',side:'buy',reservationId:reservation.reservationId},()=>now).ok,true);
 const history=()=>({fills:db.prepare('SELECT * FROM paper_fills WHERE account_id=?').all(accountId),positions:db.prepare('SELECT * FROM paper_positions WHERE account_id=?').all(accountId),reservations:db.prepare('SELECT * FROM paper_reservations WHERE account_id=?').all(accountId),ticks:db.prepare('SELECT * FROM paper_bot_ticks WHERE account_id=?').all(accountId)});
 return {accountId,policyId,botId,history};
}
test.after(async()=>{closeDatabase();await fs.rm(root,{recursive:true,force:true});});

test('failure after a real journal insert rolls back first-install DDL and every effect',()=>{
 const userId=owner(),before=schema(),original=db.prepare;let injected=0;
 db.prepare=function(sql,...args){const statement=original.call(this,sql,...args);if(sql.startsWith('INSERT INTO main.paper_install_operations '))return {run(...values){statement.run(...values);injected++;throw Error('Owned fixture failure after actual write');}};return statement;};
 try{assert.deepEqual(provision(db,userId,request(),()=>now),{ok:false,reason:'unavailable'});}finally{db.prepare=original;}
 assert.equal(injected,1);assert.deepEqual(schema(),before);assert.equal(db.prepare('SELECT role FROM users WHERE id=?').get(userId).role,'owner');
});
test('actual install prepares exact schema, explicit grants and one journal without accounts or ready metadata',()=>{
 const userId=owner(),first=provision(db,userId,request(),()=>now);assert.equal(first.ok,true);assert.equal(first.replayed,false);assert.equal(first.result.status,'provisioned');assert.equal(first.result.revision,1);
 assert.equal(inspectPaperBundleSchema(db).ok,true);assert.equal(PAPER_BUNDLE_SCHEMA.tableCount,15);const state=read(db,userId,()=>now);assert.equal(state.ok,true);assert.equal(state.state,'provisioned');assert.equal(state.runtimeConnected,false);assert.deepEqual(state.capabilities,['paper.account.read','paper.bot.manage']);assert.equal(state.revision,1);
 assert.equal(db.prepare('SELECT count(*) n FROM paper_accounts').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM paper_bots').get().n,0);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('paper_app_installations','paper_bot_installations')").get().n,0);
 assert.equal(rows('paper_install_operations',userId).length,1);assert.equal(rows('paper_install_grants',userId).length,2);assert.equal(db.prepare('SELECT count(*) n FROM paper_schema_journal').get().n,1);
 const second=owner();assert.equal(provision(db,second,request('read-only',['paper.account.read']),()=>now).ok,true);assert.deepEqual(read(db,second,()=>now).capabilities,['paper.account.read']);assert.equal(db.prepare('SELECT count(*) n FROM paper_schema_journal').get().n,1);assert.equal(Object.isFrozen(bundle),true);assert.equal(Object.isFrozen(bundle.capabilities),true);
});
test('idempotency is durable and changed intents refuse without granting more capability',()=>{
 const userId=owner(),input=request('exact',['paper.account.read']),first=provision(db,userId,input,()=>now),before=rows('paper_install_operations',userId);assert.equal(first.ok,true);
 assert.deepEqual(provision(db,userId,input,()=>now+1),{...first,replayed:true});assert.deepEqual(rows('paper_install_operations',userId),before);
 for(const changed of [{...input,capabilities:['paper.account.read','paper.bot.manage']},command('disable',1,'exact'),{...input,manifestDigest:'a'.repeat(64)}])assert.equal(provision(db,userId,changed,()=>now+1).ok,false);
 assert.deepEqual(read(db,userId,()=>now+1).capabilities,['paper.account.read']);
});
test('disable and removal retain trading history and another owner while old install replay never regrants',()=>{
 const userId=owner(),other=owner();assert.equal(provision(db,userId,request(),()=>now).ok,true);assert.equal(provision(db,other,request(),()=>now).ok,true);const own=seed(userId),unrelated=seed(other),originalHistory=own.history(),otherHistory=unrelated.history(),otherAccount=rows('paper_accounts',other),otherBots=rows('paper_bots',other),otherGrants=rows('paper_install_grants',other);
 const disabled=provision(db,userId,command('disable',1,'disable'),()=>now+1);assert.equal(disabled.ok,true);assert.equal(disabled.result.status,'disabled');assert.deepEqual(own.history(),originalHistory);let account=rows('paper_accounts',userId)[0],bot=rows('paper_bots',userId)[0];assert.equal(account.cash,8990);assert.equal(account.app_enabled,0);assert.equal(account.app_revision,2);assert.equal(bot.status,'stopped');assert.equal(bot.successful_ticks,1);assert.equal(bot.last_success_at,now);assert.deepEqual(read(db,userId,()=>now+1).capabilities,[]);
 const replay=provision(db,userId,request(),()=>now+2);assert.equal(replay.ok,true);assert.equal(replay.replayed,true);assert.equal(replay.result.status,'provisioned');assert.equal(read(db,userId,()=>now+2).state,'disabled');assert.deepEqual(read(db,userId,()=>now+2).capabilities,[]);assert.equal(provision(db,userId,request('reinstall'),()=>now+2).ok,false);
 const removed=provision(db,userId,command('remove_retained',2,'remove'),()=>now+3);assert.equal(removed.ok,true);assert.equal(read(db,userId,()=>now+3).state,'removed_retained');assert.deepEqual(own.history(),originalHistory);account=rows('paper_accounts',userId)[0];bot=rows('paper_bots',userId)[0];assert.equal(account.cash,8990);assert.equal(account.app_revision,3);assert.equal(bot.status,'revoked');assert.equal(bot.successful_ticks,1);assert.equal(bot.last_success_at,now);assert.equal(provision(db,userId,command('disable',3,'reenable'),()=>now+4).ok,false);
 assert.deepEqual(unrelated.history(),otherHistory);assert.deepEqual(rows('paper_accounts',other),otherAccount);assert.deepEqual(rows('paper_bots',other),otherBots);assert.deepEqual(rows('paper_install_grants',other),otherGrants);
});
test('malformed primitive bodies and accessor capabilities refuse before any getter executes',()=>{
 const userId=owner();for(const input of [null,[],{...request(),extra:true},{...request(),action:'enable'},{...request(),expectedRevision:1},{...request(),capabilities:[]},{...request(),capabilities:['paper.bot.manage']},{...request(),capabilities:['paper.account.read','paper.account.read']},{...request(),capabilities:['paper.live.trade']},{...request(),idempotencyKey:'key\n'}])assert.equal(provision(db,userId,input,()=>now).ok,false);
 let getters=0;const outer={...request()};Object.defineProperty(outer,'manifestDigest',{enumerable:true,get(){getters++;return bundle.manifestDigest;}});assert.equal(provision(db,userId,outer,()=>now).ok,false);assert.equal(getters,0);
 const caps=[];Object.defineProperty(caps,'0',{enumerable:true,configurable:true,get(){getters++;return 'paper.account.read';}});assert.equal(provision(db,userId,{...request(),capabilities:caps},()=>now).ok,false);assert.equal(getters,0);
});
test('foreign handle caller transaction unsupported driver and nonowners refuse',()=>{
 const userId=owner(),same=new Database(process.env.DATABASE_PATH),other=new Database(path.join(root,'other.db'));try{for(const foreign of [same,other])assert.equal(provision(foreign,userId,request(),()=>now).ok,false);assert.equal(other.prepare('SELECT count(*) n FROM sqlite_master').get().n,0);}finally{same.close();other.close();}
 db.transaction(()=>assert.equal(provision(db,userId,request(),()=>now).ok,false)).deferred();process.env.AGENT_PLAYER_DB='postgres';try{assert.equal(provision(db,userId,request(),()=>now).ok,false);}finally{delete process.env.AGENT_PLAYER_DB;}
 for(const invalid of [owner('admin'),owner('user'),owner('owner',{status:'inactive'}),owner('owner',{emailVerified:0}),'missing-owner','mock-user'])assert.equal(provision(db,invalid,request(),()=>now).ok,false);
});
test('TEMP shadow schema and corrupted journal refuse without changing existing data',()=>{
 const userId=owner();db.exec('CREATE TEMP TABLE paper_installations(value TEXT)');try{assert.equal(provision(db,userId,request(),()=>now).ok,false);}finally{db.exec('DROP TABLE temp.paper_installations');}
 db.exec('CREATE TEMP TABLE paper_accounts(value TEXT)');try{assert.equal(provision(db,userId,request(),()=>now).ok,false);}finally{db.exec('DROP TABLE temp.paper_accounts');}
 assert.equal(provision(db,userId,request(),()=>now).ok,true);const digest=db.prepare('SELECT schema_digest FROM paper_schema_journal').get().schema_digest;try{db.prepare("UPDATE paper_schema_journal SET schema_digest='bad'").run();assert.equal(read(db,userId,()=>now).ok,false);assert.equal(provision(db,userId,command('disable',1,'blocked'),()=>now+1).ok,false);}finally{db.prepare('UPDATE paper_schema_journal SET schema_digest=?').run(digest);}
 assert.equal(read(db,userId,()=>now).state,'provisioned');
});

test('failure after actual account disable restores installation, grants, revisions, cash and bot state',()=>{
 const userId=owner();assert.equal(provision(db,userId,request(),()=>now).ok,true);const owned=seed(userId),snapshot=()=>({installation:rows('paper_installations',userId),grants:rows('paper_install_grants',userId),operations:rows('paper_install_operations',userId),accounts:rows('paper_accounts',userId),bots:rows('paper_bots',userId),history:owned.history()}),before=snapshot(),original=db.prepare;let injected=0;
 db.prepare=function(sql,...args){const statement=original.call(this,sql,...args);if(sql.startsWith('UPDATE main.paper_accounts SET app_enabled=0'))return {run(...values){statement.run(...values);injected++;throw Error('Owned fixture failure after account disable');}};return statement;};
 try{assert.equal(provision(db,userId,command('disable',1,'failed-disable'),()=>now+1).ok,false);}finally{db.prepare=original;}assert.equal(injected,1);assert.deepEqual(snapshot(),before);
});
test('unexpected registry trigger is rejected as schema corruption before any operation effect',()=>{
 const userId=owner(),before=db.prepare('SELECT count(*) n FROM paper_install_operations').get().n;db.exec('CREATE TRIGGER unexpected_install AFTER INSERT ON paper_install_operations BEGIN SELECT 1; END');try{assert.equal(provision(db,userId,request(),()=>now).ok,false);}finally{db.exec('DROP TRIGGER unexpected_install');}assert.equal(db.prepare('SELECT count(*) n FROM paper_install_operations').get().n,before);
});

test('historical retry is read-only and refuses missing schema rather than repairing it',async()=>{
 const userId=owner(),input=request('historical');assert.equal(provision(db,userId,input,()=>now).ok,true);const before=schema(),changes=db.prepare('SELECT total_changes() n').get().n;
 assert.equal(provision(db,userId,input,()=>now+1).replayed,true);assert.deepEqual(schema(),before);assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
 assert.equal(db.prepare('SELECT count(*) n FROM paper_sell_fills').get().n,0);db.exec('DROP TABLE paper_sell_fills');const missing=schema(),after=db.prepare('SELECT total_changes() n').get().n;assert.equal(provision(db,userId,input,()=>now+2).ok,false);assert.deepEqual(schema(),missing);assert.equal(db.prepare('SELECT total_changes() n').get().n,after);
 const {preparePaperBundleSchema}=await import('../src/services/trading-paper-bundle-schema.ts');assert.equal(preparePaperBundleSchema(db).ok,true);assert.equal(read(db,userId,()=>now+3).state,'provisioned');
});
test('disable existing compatibility projections is owner scoped and never creates ready state',()=>{
 const a=owner(),b=owner();assert.equal(provision(db,a,request('compat'),()=>now).ok,true);assert.equal(provision(db,b,request('compat'),()=>now).ok,true);
 for(const name of ['paper_app_installations','paper_bot_installations']){db.exec(`CREATE TABLE IF NOT EXISTS ${name}(owner_id TEXT,app_id TEXT,version TEXT,schema_version INTEGER,manifest_digest TEXT,mode TEXT,status TEXT,UNIQUE(owner_id,app_id))`);for(const userId of [a,b])db.prepare(`INSERT INTO ${name} VALUES(?,?,?,?,?,?,?)`).run(userId,'trading','1.0.0',1,'fixture','paper','ready');}
 assert.equal(provision(db,a,command('disable',1,'compat-disable'),()=>now+1).ok,true);for(const name of ['paper_app_installations','paper_bot_installations']){assert.equal(db.prepare(`SELECT status FROM ${name} WHERE owner_id=?`).get(a).status,'disabled');assert.equal(db.prepare(`SELECT status FROM ${name} WHERE owner_id=?`).get(b).status,'ready');}
});
