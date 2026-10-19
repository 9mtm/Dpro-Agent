import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
const backend=process.cwd();
test('process death resumes after the last completed conversation; duplicate requests and committed previews are not replayed',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'dpro-durable-'));const src=path.join(root,'.claude/projects/fixture');mkdirSync(src,{recursive:true});mkdirSync(path.join(root,'.data'));
 const facts=['Always answer in Arabic.','The Helios project deploys every Friday.','Invoice reports must use EUR.'];
 facts.forEach((content,i)=>writeFileSync(path.join(src,`${i}.jsonl`),JSON.stringify({type:'user',message:{content}})+'\n'));
 const env={...process.env,HOME:root,USERPROFILE:root,DATABASE_PATH:path.join(root,'.data/agent-player.db'),AGENT_PLAYER_DATA_DIR:path.join(root,'.data'),JWT_SECRET:randomBytes(64).toString('hex'),ENCRYPTION_KEY:randomBytes(32).toString('hex'),AGENT_PLAYER_BACKGROUND:'off'};
 const worker=mode=>spawn(process.execPath,['--import',pathToFileURL(path.join(backend,'node_modules/tsx/dist/loader.mjs')).href,path.join(backend,'test/fixtures/durable-import-worker.mjs'),backend,mode],{env,stdio:['ignore','ignore','pipe','ipc']});
 let first,second;
 try {
  first=worker('crash');let err='';first.stderr.on('data',x=>err+=x);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('First worker stalled: '+err)),20000);first.on('message',m=>{if(m.phase==='error'){clearTimeout(timer);reject(Error(m.message))}if(m.phase==='extract'&&m.calls===2){clearTimeout(timer);resolve()}});first.once('exit',()=>reject(Error('First worker exited: '+err)))});
  first.kill('SIGKILL');await new Promise(r=>first.once('exit',r));
  second=worker('resume');let report;second.on('message',m=>{report=m});let errors='';second.stderr.on('data',x=>errors+=x);
  const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Resume stalled')),20000);second.once('exit',c=>{clearTimeout(timer);resolve(c)})});
  assert.equal(code,0,JSON.stringify(report)+' '+errors);assert.equal(report.phase,'pass');assert.equal(report.calls,2);assert.equal(report.proposals,3);assert.equal(report.committedReplay,true);
 } finally {first?.kill('SIGKILL');second?.kill('SIGKILL');rmSync(root,{recursive:true,force:true})}
});
