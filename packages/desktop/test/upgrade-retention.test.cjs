'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { randomBytes, createHash } = require('node:crypto');
const { readSelection, INVALID_SELECTION } = require('../src/workspace-selection.cjs');
const { probe, decide, candidates } = require('../src/data-discovery.cjs');
const backend = path.resolve(__dirname, '../../backend');
const Database = require(require.resolve('better-sqlite3', { paths: [backend] }));
function digest(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
test('replacement app and two fresh discovery processes retain selected account, messages, ciphertext and keys', async () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dpro-upgrade-'));
 try {
  const profile=path.join(root,'profile'),data=path.join(root,'previous-backend','.data'),install=path.join(root,'application');
  for(const dir of [profile,data,install,path.join(data,'encryption')])fs.mkdirSync(dir,{recursive:true});
  const dbfile=path.join(data,'agent-player.db');const db=new Database(dbfile);
  db.exec('CREATE TABLE users(id TEXT,role TEXT,password_hash TEXT); CREATE TABLE chat_messages(content TEXT)');
  db.prepare('INSERT INTO users VALUES (?,?,?)').run('fictional-owner','owner','fictional-existing-password-hash');
  db.prepare('INSERT INTO chat_messages VALUES (?)').run('Fictional conversation retained during upgrade');db.close();
  fs.writeFileSync(path.join(data,'encryption','keys.db'),randomBytes(256));fs.writeFileSync(path.join(data,'encryption','credentials.db'),randomBytes(256));
  fs.writeFileSync(path.join(profile,'workspace.json'),JSON.stringify({dir:data}),{mode:0o600});
  const files=[dbfile,path.join(data,'encryption','keys.db'),path.join(data,'encryption','credentials.db'),path.join(profile,'workspace.json')];const before=files.map(digest);
  fs.writeFileSync(path.join(install,'version.txt'),'old application');
  for(const version of ['updated application','restarted application']) {
   fs.writeFileSync(path.join(install,'version.txt'),version);
   const selected=readSelection(profile);const rows=await Promise.all(candidates({defaultDir:path.join(root,'empty-default'),home:root,cwd:install,backendDir:backend,savedDir:selected}).map(dir=>probe(process.execPath,backend,dir)));
   assert.deepEqual(decide(rows,selected),{kind:'existing',dir:fs.realpathSync(data)});
   assert.deepEqual(files.map(digest),before);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('corrupted saved selection never falls back silently to another owner', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dpro-selection-'));
 try {for(const raw of ['{broken',JSON.stringify({dir:'relative-data'}),'{}']) {fs.writeFileSync(path.join(root,'workspace.json'),raw);assert.equal(readSelection(root),INVALID_SELECTION);assert.equal(decide([{dir:'/another-owner',state:'existing'}],readSelection(root)).kind,'choose');}}
 finally{fs.rmSync(root,{recursive:true,force:true});}
});
