import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import Database from 'better-sqlite3';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'paper-bundle-schema-'));process.env.AGENT_PLAYER_DATA_DIR=dir;process.env.DATABASE_PATH=path.join(dir,'main.db');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const main=getDatabase();await main.initialize();const db=main.getDb();
const {preparePaperBundleSchema:prepare,preparePaperBundleSchemaInTransaction:inside,inspectPaperBundleSchema:inspect,PAPER_BUNDLE_SCHEMA}=await import('../src/services/trading-paper-bundle-schema.ts');
const paper=()=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name GLOB 'paper_*' ORDER BY type,name").all();
const clear=()=>{for(const row of paper().filter(r=>r.type==='view'))db.exec('DROP VIEW '+row.name);for(const row of paper().filter(r=>r.type==='table'))db.exec('DROP TABLE '+row.name);};
test.after(async()=>{closeDatabase();await fs.rm(dir,{recursive:true,force:true});});
test('atomic exact idempotent schema-only setup creates no account grant or installation',()=>{
 assert.deepEqual(inspect(db),{ok:false,reason:'unavailable'});assert.deepEqual(paper(),[]);const users=db.prepare('SELECT count(*) n FROM users').get().n,result=prepare(db);assert.equal(result.ok,true);assert.equal(result.tableCount,15);assert.equal(result.schemaDigest,PAPER_BUNDLE_SCHEMA.digest);assert.match(result.schemaDigest,/^[a-f0-9]{64}$/);
 for(const row of paper().filter(r=>r.type==='table'))assert.equal(db.prepare('SELECT count(*) n FROM '+row.name).get().n,0);
 for(const name of ['paper_app_installations','paper_bot_installations','paper_install_grants','paper_installations'])assert.equal(db.prepare('SELECT count(*) n FROM sqlite_master WHERE name=?').get(name).n,0);
 const schema=paper(),version=db.pragma('schema_version',{simple:true});assert.deepEqual(prepare(db),result);assert.deepEqual(paper(),schema);assert.equal(db.pragma('schema_version',{simple:true}),version);assert.equal(db.prepare('SELECT count(*) n FROM users').get().n,users);assert.deepEqual(inspect(db),result);clear();
});
test('actual DDL before injected later failure rolls back completely',()=>{
 const original=db.exec;let writes=0;db.exec=function(sql){if(sql.includes('CREATE TABLE IF NOT EXISTS paper_bots'))throw Error('fixture failure');writes++;return original.call(this,sql);};
 try{assert.deepEqual(prepare(db),{ok:false,reason:'unavailable'});assert.ok(writes>2);assert.deepEqual(paper(),[]);assert.equal(db.inTransaction,false);}finally{db.exec=original;}assert.equal(prepare(db).ok,true);clear();
});
test('internal helper joins caller rollback and public wrapper refuses caller transaction',()=>{
 assert.throws(()=>inside(db));db.transaction(()=>{assert.deepEqual(prepare(db),{ok:false,reason:'unavailable'});assert.deepEqual(paper(),[]);}).immediate();
 assert.throws(()=>db.transaction(()=>{assert.equal(inside(db).tableCount,15);assert.equal(inspect(db).ok,true);throw Error('later installer refusal');}).immediate());assert.deepEqual(paper(),[]);
});
test('views changed columns constraints indexes triggers and legacy layouts refuse without mutation',()=>{
 for(const sql of ["CREATE VIEW paper_accounts AS SELECT 1 account_id","CREATE TABLE paper_accounts(account_id TEXT)","CREATE TABLE paper_accounts(account_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, mode TEXT NOT NULL, currency TEXT NOT NULL, cash INTEGER NOT NULL, exposure INTEGER NOT NULL, app_enabled INTEGER NOT NULL, app_revision INTEGER NOT NULL, stopped INTEGER NOT NULL)"]){db.exec(sql);const before=paper();assert.equal(prepare(db).ok,false);assert.deepEqual(paper(),before);clear();}
 for(const mutate of ['ALTER TABLE paper_accounts ADD COLUMN unexpected TEXT','CREATE INDEX paper_extra ON paper_accounts(owner_id)',"CREATE TRIGGER paper_extra AFTER INSERT ON paper_accounts BEGIN SELECT 1; END"]){assert.equal(prepare(db).ok,true);db.exec(mutate);const before=paper();assert.equal(inspect(db).ok,false);assert.equal(prepare(db).ok,false);assert.deepEqual(paper(),before);clear();}
});
test('supported existing tables and data survive completion of missing bundle tables',async()=>{
 const {initializePaperLedger}=await import('../src/services/trading-paper-ledger.ts');initializePaperLedger(db);db.prepare("INSERT INTO paper_accounts VALUES('retained','owner','paper','USD',1234,0,0,7,1)").run();const before=db.prepare('SELECT * FROM paper_accounts').all();assert.equal(prepare(db).ok,true);assert.deepEqual(db.prepare('SELECT * FROM paper_accounts').all(),before);assert.equal(db.prepare('SELECT count(*) n FROM paper_bots').get().n,0);clear();
});
test('different raw handles including same filename refuse before target SQL',()=>{
 for(const filename of [':memory:',path.join(dir,'main.db')]){const other=new Database(filename);try{const original=other.prepare;other.prepare=()=>{throw Error('foreign SQL forbidden');};assert.deepEqual(prepare(other),{ok:false,reason:'unavailable'});assert.deepEqual(inspect(other),{ok:false,reason:'unavailable'});assert.throws(()=>inside(other));other.prepare=original;}finally{other.close();}}assert.deepEqual(paper(),[]);
});
test('public activation initializer still rejects caller transactions',async()=>{
 const {initializePaperBotActivation}=await import('../src/services/trading-paper-bot-activation.ts');assert.throws(()=>db.transaction(()=>initializePaperBotActivation(db)).immediate());assert.deepEqual(paper(),[]);
});

test('temporary shadows and triggers on bundled tables refuse before and after preparation',()=>{
 for(const sql of ['CREATE TEMP TABLE paper_accounts(account_id TEXT)','CREATE TEMP TABLE PaPeR_AcCoUnTs(account_id TEXT)',"CREATE TEMP VIEW paper_accounts AS SELECT 'shadow' account_id"]){db.exec(sql);const before=paper();assert.equal(prepare(db).ok,false);assert.equal(inspect(db).ok,false);assert.deepEqual(paper(),before);db.exec(sql.includes('VIEW')?'DROP VIEW temp.paper_accounts':'DROP TABLE temp.paper_accounts');}
 assert.equal(prepare(db).ok,true);db.exec("CREATE TEMP TRIGGER temp_effect AFTER INSERT ON main.paper_accounts BEGIN SELECT 1; END");const before=paper();assert.equal(inspect(db).ok,false);assert.equal(prepare(db).ok,false);assert.deepEqual(paper(),before);db.exec('DROP TRIGGER temp.temp_effect');assert.equal(inspect(db).ok,true);clear();
});
test('all unchanged public initializers produce the exact shared bundled schema',async()=>{
 const ledger=await import('../src/services/trading-paper-ledger.ts'),execution=await import('../src/services/trading-paper-execution.ts'),sells=await import('../src/services/trading-paper-sells.ts'),bots=await import('../src/services/trading-paper-bots.ts'),activation=await import('../src/services/trading-paper-bot-activation.ts');
 ledger.initializePaperLedger(db);execution.initializePaperExecution(db);sells.initializePaperSells(db);bots.initializePaperBots(db);activation.initializePaperBotActivation(db);assert.equal(inspect(db).ok,true);const before=paper();assert.equal(prepare(db).ok,true);assert.deepEqual(paper(),before);clear();
});
