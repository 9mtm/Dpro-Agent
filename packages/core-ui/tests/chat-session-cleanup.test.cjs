require('./load.cjs');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {ConversationsController} = require('../src/conversations.ts');

function fixture(t) {
  let session = {phase:'authenticated',epoch:1,user:{id:'owner-a',role:'owner'}};
  const listeners = new Set(), calls=[];
  let handler = async () => ({status:200,body:{}});
  const client={getSnapshot:()=>session,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},request:async r=>{calls.push(r);return handler(r);}};
  const c=new ConversationsController(client);
  t.after(()=>c.dispose());
  return {c,calls,respond:fn=>{handler=fn;},change:next=>{session=next;listeners.forEach(fn=>fn());}};
}

test('account epoch change clears every ephemeral chat field and blocks stale controller writes',async t=>{
  const f=fixture(t),{c}=f;
  f.respond(async r=>({status:200,body:r.path.endsWith('/projects')?{projects:[{id:'p1',name:'Private project',folder:'/private/work',repoUrl:null}]}:r.path==='/api/models'?{models:[{id:'local-model',label:'Local',provider:'ollama',size:''}]}:r.path==='/api/agents'?{agents:[{id:'agent-a',name:'Private agent'}]}:{conversations:[]}}));
  await c.load();await c.loadProjects();await c.loadModels();await c.loadAgents();
  c.filterProject('p1');c.selectAgent('agent-a');c.edit('Private unsent message');c.attach([{name:'private.txt',text:'Private attachment'}]);
  assert.equal(c.getSnapshot().attachments.length,1);assert.equal(c.getSnapshot().projects.length,1);
  f.change({phase:'authenticated',epoch:2,user:{id:'owner-b',role:'owner'}});
  const state=c.getSnapshot();
  for(const key of ['conversations','projects','agents','models','turns','queue','attachments'])assert.deepEqual(state[key],[],key);
  for(const key of ['draft','agentId','replyAgent','model','projectFilter'])assert.equal(state[key],'',key);
  assert.equal(state.git,null);assert.equal(state.focus,null);assert.equal(state.access,'denied');assert.equal(c.recall(),undefined);
  const before=f.calls.length;
  await c.rename('old-chat','Renamed');await c.moveToProject('old-chat','p1');await c.createProject({name:'New',folder:'/private/new',repoUrl:''});
  await assert.rejects(c.browseProjectFolders());
  await c.loadModels();await c.loadAgents();await c.loadProjects();
  assert.equal((await c.exportMarkdown('old-chat')).ok,false);
  assert.equal(f.calls.length,before,'stale controller cannot send using the new account');
});

for(const operation of ['create','browse'])test(`late ${operation} response after logout cannot restore private state`,async t=>{
  const f=fixture(t);let finish;
  f.respond(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=operation==='create'?f.c.createProject({name:'Private',folder:'/private/work',repoUrl:''}):f.c.browseProjectFolders();
  f.change({phase:'signed-out',epoch:2,user:null});
  finish({status:operation==='create'?201:200,body:{project:{id:'late',name:'Private',folder:'/private/work'},path:'/private/work',entries:[]}});
  if(operation==='create')assert.ok(await pending);else await assert.rejects(pending);
  assert.deepEqual(f.c.getSnapshot().projects,[]);assert.equal(f.c.getSnapshot().projectFilter,'');assert.equal(f.c.getSnapshot().access,'denied');
});

test('logout erases sent-message recall and stops retaining the live turn',async t=>{
  const {SessionClient}=require('../src/session.ts');
  const {createLoginMock}=require('../src/session-mock.ts');
  const client=new SessionClient({mock:createLoginMock()});
  client.selectMode('mock');await client.login('demo@example.invalid','mock-only');
  const c=new ConversationsController(client);t.after(()=>c.dispose());
  await c.send('Private recalled message');
  assert.equal(c.recall(),'Private recalled message');
  assert.ok(c.getSnapshot().runId);
  await client.logoutAllDevices();
  assert.equal(c.recall(),undefined);assert.equal(c.getSnapshot().runId,null);
  assert.deepEqual(c.getSnapshot().turns,[]);assert.equal(c.getSnapshot().notice,undefined);
});
