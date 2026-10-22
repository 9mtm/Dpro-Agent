require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedConnector, connectorResponse } = require('../src/connectors-contract.js');
const { allowed } = require('../scripts/application-server.cjs');
const { ConnectorsController, parseSecrets, splitArgs } = require('../src/connectors.ts');
const { SessionClient } = require('../src/session.ts');
const { createLoginMock } = require('../src/session-mock.ts');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const L = ['http:', '', '127.0.0.1:3333/mcp'].join('/');
test('connector routes: reviewed shapes only; secret values never come back', () => {
  for (const [m, p, b, ok] of [
    ['POST', '/api/mcp/servers', { name: 'cal', transport: 'http', url: L, headers: { Authorization: 'x' } }, true],
    ['POST', '/api/mcp/servers', { name: 'Bad Name', transport: 'http', url: L }, false],
    ['POST', '/api/mcp/servers', { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { KEY: 'v' } }, true],
    ['POST', '/api/mcp/servers', { name: 'fs', transport: 'stdio', command: 'npx', cwd: '/' }, false],
    ['POST', `/api/mcp/servers/${ID}/enable`, undefined, true],
    ['POST', `/api/mcp/servers/${ID}/enable`, { launchHash: 'sha256:abcdef1234' }, true],
    ['PUT', `/api/mcp/servers/${ID}/tools/read_file`, { requiresApproval: false }, true],
    ['DELETE', `/api/mcp/servers/${ID}`, undefined, true],
  ]) { assert.equal(allowedConnector(m, p, b), ok, `${m} ${p}`); assert.equal(allowed(m, p, b), ok, `bridge ${m} ${p}`); }
  const view = connectorResponse('/api/mcp/servers', 200, { servers: [{ id: ID, name: 'cal', transport: 'http', url: L, headers: { Authorization: '********' }, enabled: true, tools: [{ name: 'list', requiresApproval: true }] }] });
  assert.deepEqual(view.servers[0].headerNames, ['Authorization']);
  assert.ok(!JSON.stringify(view).includes('*****'), 'masked values are not passed on either');
  assert.deepEqual(connectorResponse('/api/mcp/servers', 200, view), view, 'stable twice');
  const approval = connectorResponse(`/api/mcp/servers/${ID}/enable`, 409, { code: 'launch_approval_required', error: 'x', launch: { command: 'npx', args: ['-y', 'pkg'], envNames: ['KEY'] }, launchHash: 'sha256:abc' });
  assert.equal(approval.launchHash, 'sha256:abc'); assert.deepEqual(approval.launch.args, ['-y', 'pkg']);
  assert.deepEqual(splitArgs('npx -y "my pkg" /tmp'), ['npx', '-y', 'my pkg', '/tmp']);
  assert.deepEqual(parseSecrets('A=1\n\nB = two'), { A: '1', B: 'two' });
  assert.equal(typeof parseSecrets('no equals'), 'string');
});

test('connectors: add, approve a program launch, discover tools, remove', async t => {
  const base = createLoginMock(); const servers = new Map();
  const live = async r => {
    if (!r.path.startsWith('/api/mcp')) return base(r);
    const id = r.path.split('/')[4];
    if (r.path === '/api/mcp/servers' && r.method === 'GET') return { status: 200, body: { servers: [...servers.values()] } };
    if (r.path === '/api/mcp/servers') { const s = { id: ID, name: r.body.name, transport: r.body.transport, command: r.body.command, args: r.body.args ?? [], env: Object.fromEntries(Object.keys(r.body.env ?? {}).map(k => [k, '****'])), enabled: false, tools: [] }; servers.set(ID, s); return { status: 201, body: s }; }
    const s = servers.get(id);
    if (r.path.endsWith('/enable')) { if (!r.body) return { status: 409, body: { code: 'launch_approval_required', launch: { command: s.command, args: s.args, envNames: Object.keys(s.env) }, launchHash: 'sha256:launch1' } }; s.enabled = true; return { status: 200, body: s }; }
    if (r.path.endsWith('/refresh')) { s.tools = [{ name: 'read_file', requiresApproval: false }]; return { status: 200, body: { server: s, discovered: 1, skipped: [] } }; }
    if (r.method === 'DELETE') { servers.delete(id); return { status: 200, body: { deleted: true } }; }
    return { status: 404, body: { code: 'not_found' } };
  };
  const client = new SessionClient({ live }); client.selectMode('live'); await client.login('demo@example.invalid', 'mock-only');
  const c = new ConnectorsController(client);
  await c.load();
  assert.equal(await c.add({ name: 'fs', description: '', kind: 'program', command: 'npx -y pkg /tmp', args: '', url: '', allowRemote: false, secrets: 'KEY=secret' }), null);
  await c.enable(ID);
  assert.deepEqual(c.getSnapshot().approval.launch, { command: 'npx', args: ['-y', 'pkg', '/tmp'], envNames: ['KEY'] });
  await c.approve();
  assert.equal(c.getSnapshot().servers[0].enabled, true);
  assert.equal(c.getSnapshot().servers[0].tools.length, 1, 'tools are read right after turning on');
  assert.match(c.getSnapshot().notice, /Found 1 tools/);
  const { ConnectorsSection } = require('../src/ConnectorsSection.tsx');
  assert.match(renderToStaticMarkup(React.createElement(ConnectorsSection, { client, active: false })), /Connectors/);
  await c.remove(ID);
  assert.equal(c.getSnapshot().servers.length, 0);
});


test('editing connection targets is bounded and tool approval responses preserve actual server state',()=>{
 const path=`/api/mcp/servers/${ID}`;
 const body={description:'Fictional revised description',url:L,allowRemote:false,headers:{TOKEN:'fictional'}};
 for(const fn of [allowedConnector,allowed]){assert.equal(fn('PUT',path,body),true);for(const bad of [{...body,enabled:true},{...body,name:'renamed'},{...body,transport:'stdio'},{...body,cwd:'/private'},{...body,headers:{TOKEN:4}}])assert.equal(fn('PUT',path,bad),false);}
 const raw={id:ID,name:'fixture',transport:'http',url:L,enabled:false,headers:{TOKEN:'do-not-return'},tools:[{name:'read',requiresApproval:true,requiresApprovalOverride:true}]};
 const response=connectorResponse(path+'/tools/read',200,raw);assert.equal(response.server.tools[0].requiresApproval,true);assert.equal(response.server.tools[0].requiresApprovalOverride,true);assert.deepEqual(response.server.headerNames,['TOKEN']);assert.doesNotMatch(JSON.stringify(response),/do-not-return/);assert.deepEqual(connectorResponse(path+'/tools/read',200,response),response);
 assert.equal(connectorResponse(path,409,{code:'conflict',error:'Changed'}).code,'conflict');
});

test('connection edits do not enable or discover; tool approval updates are reflected immediately',async()=>{
 const base=createLoginMock(),calls=[];let server={id:ID,name:'fixture',transport:'http',url:L,enabled:false,tools:[{name:'read',requiresApproval:false,requiresApprovalOverride:null}]};
 const live=async r=>{if(!r.path.startsWith('/api/mcp'))return base(r);calls.push(r);if(r.method==='GET')return {status:200,body:{servers:[server]}};if(r.path.endsWith('/tools/read')){server={...server,tools:[{...server.tools[0],requiresApproval:r.body.requiresApproval,requiresApprovalOverride:r.body.requiresApproval}]};return {status:200,body:server};}if(r.method==='PUT'){server={...server,description:r.body.description};return {status:200,body:{...server,disabledByChange:false,revokedGrants:[]}};}throw Error('Unexpected network action');};
 const client=new SessionClient({live});client.selectMode('live');await client.login('demo@example.invalid','mock-only');const c=new ConnectorsController(client);await c.load();await c.setApproval(ID,'read',true);assert.equal(c.getSnapshot().servers[0].tools[0].requiresApproval,true);assert.equal(await c.update(ID,{description:'Updated description'}),null);assert.equal(c.getSnapshot().servers[0].description,'Updated description');assert.equal(c.getSnapshot().servers[0].enabled,false);assert.ok(calls.every(r=>!r.path.endsWith('/enable')&&!r.path.endsWith('/refresh')));
});

test('MCP page owns a quiet desktop list and sidebar without nested library tabs',()=>{
 const {McpLibrary}=require('../src/McpLibrary.tsx'),{McpSection}=require('../src/ToolSections.tsx');
 const html=renderToStaticMarkup(React.createElement(McpLibrary,{client:{},active:false}));assert.match(html,/Installed MCP connections/);assert.match(html,/Selected MCP connection/);assert.match(html,/Add a connection/);assert.doesNotMatch(html,/<textarea|role="tablist"|connector-list catalogue-grid/);
 const section=renderToStaticMarkup(React.createElement(McpSection,{client:{},active:false}));for(const label of ['All connections','Enabled','Disabled','Needs attention','Import from apps','Found in folders'])assert.ok(section.includes(label),label);assert.match(section,/MCP connections places/);
});


test('desktop connection commands distinguish enable, reconnect and tool discovery',async()=>{
 const path=`/api/mcp/servers/${ID}/reconnect`;
 for(const fn of [allowedConnector,allowed]){assert.equal(fn('POST',path),true);assert.equal(fn('GET',path),false);assert.equal(fn('POST',path,{launchHash:'unreviewed'}),false);}
 const base=createLoginMock(),calls=[];const server={id:ID,name:'fixture',transport:'http',url:L,enabled:true,active:true,connectionState:'disconnected',tools:[]};
 const live=async r=>{if(!r.path.startsWith('/api/mcp'))return base(r);calls.push(r);if(r.method==='GET')return {status:200,body:{servers:[server]}};assert.equal(r.path,path);return {status:200,body:{server:{...server,connectionState:'connected'},discovered:0}};};
 const client=new SessionClient({live});client.selectMode('live');await client.login('demo@example.invalid','mock-only');const c=new ConnectorsController(client);await c.load();await c.reconnect(ID);assert.equal(c.getSnapshot().servers[0].connectionState,'connected');assert.equal(calls.length,2);assert.equal(calls[1].body,undefined);assert.match(c.getSnapshot().notice,/Reconnected/);
 const {McpLibrary}=require('../src/McpLibrary.tsx');const html=renderToStaticMarkup(React.createElement(McpLibrary,{client:{},active:false}));for(const label of ['Connection controls','Turn on connection','Reconnect connection','Refresh discovered tools','Edit selected connection','Add a connection'])assert.ok(html.includes(label),label);
});

test('background connection status reads never start a server or overwrite a newer edit',async()=>{
 const server={id:ID,name:'fixture',transport:'http',url:L,enabled:false,tools:[],description:'Old'};let finishPoll,get=0;const calls=[];
 const client={request:async r=>{calls.push(r);if(r.method==='GET'){get++;if(get===1)return {status:200,body:{servers:[server]}};return new Promise(resolve=>finishPoll=resolve);}assert.equal(r.method,'PUT');return {status:200,body:{server:{...server,description:'New'}}};}};
 const c=new ConnectorsController(client);await c.load();const polling=c.refreshStatus();await c.update(ID,{description:'New'});finishPoll({status:200,body:{servers:[server]}});await polling;assert.equal(c.getSnapshot().servers[0].description,'New');assert.ok(calls.every(r=>r.method==='GET'||r.method==='PUT'));
});
