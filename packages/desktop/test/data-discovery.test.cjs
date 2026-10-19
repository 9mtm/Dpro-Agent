'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { probe, decide, candidates } = require('../src/data-discovery.cjs');
const backend = path.resolve(__dirname, '../../backend');
const Database = require(require.resolve('better-sqlite3', { paths: [backend] }));
test('read-only discovery distinguishes owner, system accounts, empty and corrupt DB without mutation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpro-discovery-'));
  try {
    for (const [name, id, role, state] of [['owner','real','owner','existing'],['admin','real','admin','existing'],['system','1','admin','unconfigured'],['mock','mock-user','owner','unconfigured'],['user','real','user','unconfigured']]) {
      const dir = path.join(root, name); fs.mkdirSync(dir); const file = path.join(dir, 'agent-player.db');
      const db = new Database(file); db.exec('CREATE TABLE users (id TEXT, role TEXT)'); db.prepare('INSERT INTO users VALUES (?,?)').run(id, role); db.close();
      const before = fs.readFileSync(file); assert.equal((await probe(process.execPath, backend, dir)).state, state); assert.deepEqual(fs.readFileSync(file), before);
    }
    const broken = path.join(root, 'broken'); fs.mkdirSync(broken); fs.writeFileSync(path.join(broken,'agent-player.db'),'broken');
    assert.equal((await probe(process.execPath, backend, broken)).state, 'unreadable');
    assert.equal((await probe(process.execPath, backend, path.join(root,'absent'))).state, 'missing');
    assert.equal(fs.existsSync(path.join(root,'absent')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('fail closed on ambiguity, unreadable database or stale selection', () => {
  const one = { dir: '/a', state: 'existing' }, two = { dir:'/b', state:'existing' };
  assert.deepEqual(decide([one]),{kind:'existing',dir:'/a'});
  assert.equal(decide([one,two]).kind,'choose');
  assert.equal(decide([one,{dir:'/bad',state:'unreadable'}]).kind,'choose');
  assert.equal(decide([one],'/missing').kind,'choose');
  assert.equal(decide([{dir:'/empty',state:'unconfigured'}]).kind,'choose');
  assert.deepEqual(decide([one,two],'/b'),{kind:'existing',dir:'/b'});
});
test('explicit test data prevents discovery escaping into personal paths', () => {
  const rows=candidates({defaultDir:'/personal',home:'/home/user',cwd:'/repo',backendDir:'/repo/packages/backend',explicitDir:'/test'});
  assert.deepEqual(rows,[path.resolve('/test')]);
});

test('a verified saved workspace opens without waiting for unrelated legacy probes',async()=>{
 const {discover}=require('../src/data-discovery.cjs');const calls=[];
 const rows=await discover('node','backend',['/slow-old','/saved','/other'],'/saved',async(_,__,dir)=>{
  calls.push(dir);assert.equal(dir,'/saved','unrelated paths must not be opened');return {dir,state:'existing'};
 });
 assert.deepEqual(calls,['/saved']);assert.deepEqual(decide(rows,'/saved'),{kind:'existing',dir:'/saved'});
});
test('an unavailable saved workspace is probed once and never silently switches account',async()=>{
 const {discover}=require('../src/data-discovery.cjs');
 for(const state of ['missing','unreadable','unconfigured']){
  const calls=[];const rows=await discover('node','backend',['/other','/saved'],'/saved',async(_,__,dir)=>{calls.push(dir);return {dir,state:dir==='/saved'?state:'existing'};});
  assert.deepEqual(calls,['/saved','/other']);assert.equal(rows.length,2);assert.equal(decide(rows,'/saved').kind,'choose');
 }
});
test('fresh installs and explicit folder-picker scans retain full ambiguity checks',async()=>{
 const {discover}=require('../src/data-discovery.cjs');const calls=[];
 const rows=await discover('node','backend',['/a','/b'],null,async(_,__,dir)=>{calls.push(dir);return {dir,state:'existing'};});
 assert.deepEqual(calls,['/a','/b']);assert.equal(decide(rows).kind,'choose');
 const explicit=await discover('node','backend',['/test'],'/saved',async(_,__,dir)=>({dir,state:'existing'}));assert.deepEqual(explicit,[{dir:'/test',state:'existing'}]);
});
