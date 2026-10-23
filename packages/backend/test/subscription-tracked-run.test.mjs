import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const run=promisify(execFile),root=mkdtempSync(join(tmpdir(),'subscription-tracked-run-')),home=join(root,'home'),workspace=join(root,'workspace');mkdirSync(join(home,'.local','bin'),{recursive:true});mkdirSync(workspace);const binary=join(home,'.local','bin','claude');
const source=new URL('../src/services/subscription-chat.ts',import.meta.url).href;
async function fixture(program,code){writeFileSync(binary,'#!'+process.execPath+'\n'+program,{mode:0o700});const result=await run(process.execPath,['--import','tsx','--input-type=module','-e',`const api=await import(${JSON.stringify(source)});${code}`],{env:{PATH:process.env.PATH,HOME:home,DPRO_SUBSCRIPTION_CHAT:'1',AGENT_PLAYER_DATA_DIR:join(root,'.data'),DATABASE_PATH:join(root,'.data','fixture.db')},timeout:15000,maxBuffer:65536});return result.stdout.trim();}
test('actual subscription runner uses tracked handshake and returns provider result without a real CLI',async()=>{
 const value=await fixture("let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({type:'result',result:'fixture:'+s}));});",`const result=await api.runSubscription('subscription:claude',${JSON.stringify(workspace)},'literal fixture',new AbortController().signal);await api.stopSubscriptionProcesses();console.log(result);`);assert.equal(value,'fixture:literal fixture');
});
test('actual subscription cancellation terminates tracked group without returning partial output',async()=>{
 const value=await fixture("process.stdout.write('partial');setInterval(()=>{},1000);",`const c=new AbortController();const p=api.runSubscription('subscription:claude',${JSON.stringify(workspace)},'fixture',c.signal);setTimeout(()=>c.abort(),500);try{await p;throw Error('unexpected success');}catch(e){if(e.message!=='cancelled')throw e;}await api.stopSubscriptionProcesses();console.log('cancelled safely');`);assert.equal(value,'cancelled safely');
});

test('shutdown fences later subscription launches before a provider can start',async()=>{
 const value=await fixture("throw Error('must not start');",`await api.stopSubscriptionProcesses();try{await api.runSubscription('subscription:claude',${JSON.stringify(workspace)},'fixture',new AbortController().signal);throw Error('unexpected success');}catch(e){if(e.message!=='cli_disabled')throw e;}console.log('launch refused');`);assert.equal(value,'launch refused');
});
