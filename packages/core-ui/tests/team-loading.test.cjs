require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { SessionClient } = require('../src/session.ts');
const { AgentsController } = require('../src/agents.ts');
const { TeamGrid, MemberAgent } = require('../src/AgentsDestination.tsx');
async function session(t, response) {
  const calls=[];
  const client=new SessionClient({mock:async r=>{
    calls.push(r.path);
    if(r.path==='/api/auth/login')return {status:200,body:{token:'fictional-team-token',deviceToken:'fictional-device-token'.padEnd(43,'_'),user:{id:'test-member',email:'member@example.invalid',username:'Member',role:'user'}}};
    if(r.path==='/api/auth/me')return {status:200,body:{user:{id:'test-member',email:'member@example.invalid',username:'Member',role:'user'}}};
    return response;
  }});
  client.selectMode('mock');await client.login('member@example.invalid','fixture-only');
  assert.equal(client.getSnapshot().phase,'authenticated');
  const c=new AgentsController(client);t.after(()=>c.dispose());return {client,c,calls};
}
test('ordinary member can load readable team without owner privileges',async t=>{
  const {c,client}=await session(t,{status:200,body:{agents:[{id:'sample-main',name:'Main agent',version:1}]}});
  await c.list();assert.equal(c.getSnapshot().phase,'ready');assert.equal(c.getSnapshot().agents.length,1);assert.equal(c.getSnapshot().owner,false);
  client.cancel();assert.equal(c.getSnapshot().agents.length,0);assert.equal(c.getSnapshot().phase,'denied');
});
test('successful empty team finishes loading and renders an empty state',async t=>{
  const {c}=await session(t,{status:200,body:{agents:[]}});await c.list();
  assert.equal(c.getSnapshot().phase,'ready');
  const html=renderToStaticMarkup(React.createElement(TeamGrid,{controller:c,onOpen(){}}));
  assert.doesNotMatch(html,/Loading the team/);assert.match(html,/No agents yet/);
});
test('forbidden team read finishes with access denied instead of a spinner',async t=>{
  const {c}=await session(t,{status:403,body:null});await c.list();assert.equal(c.getSnapshot().phase,'denied');
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(TeamGrid,{controller:c,onOpen(){}})),/Loading the team/);
});

test('member agent overview never mounts privileged tool editors or requests their data',async t=>{
  const {c,calls}=await session(t,{status:200,body:{agents:[{id:'sample-main',name:'Main agent',version:1}]}});await c.list();const before=calls.length;
  const html=renderToStaticMarkup(React.createElement(MemberAgent,{controller:c,agentId:'sample-main',onBack(){}}));
  assert.match(html,/Main agent/);assert.match(html,/Only the workspace owner/);assert.doesNotMatch(html,/Turn all on|Save permissions/);assert.equal(calls.length,before);
});
