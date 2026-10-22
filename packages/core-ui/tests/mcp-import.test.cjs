require('./load.cjs');const {test}=require('node:test'),assert=require('node:assert/strict');
const {allowedMcpImport,mcpImportResponse}=require('../src/mcp-import-contract.js'),{allowed}=require('../scripts/application-server.cjs'),{allowedRequest}=require('../src/session.ts');
const id='11111111-1111-4111-8111-111111111111',hash='a'.repeat(64);
test('MCP import bridge refuses filesystem and privilege injection',()=>{
 for(const [path,body]of [['scan',{}],['preview',{scanId:id,sourceId:id}],['import',{scanId:id,sourceId:id,hash}]])for(const fn of [allowedMcpImport,allowed,allowedRequest])assert.equal(fn('POST','/api/mcp-import/'+path,body),true);
 for(const body of [{root:'/etc'},{scanId:id,sourceId:id,hash,enabled:true}])assert.equal(allowed('POST','/api/mcp-import/import',body),false);
 assert.equal(allowed('GET','/api/mcp-import/scan'),false);assert.equal(allowed('POST','/api/mcp-import/preview',{scanId:id,sourceId:'../../private'}),false);
});
test('MCP preview projects secret names only and discards raw values',()=>{
 const body={name:'fictional',transport:'stdio',command:'node',args:['fixture.mjs'],url:null,allowRemote:false,hash,existingId:null,envNames:['TOKEN'],headerNames:[],env:{TOKEN:'private'},file:'/private'};const result=mcpImportResponse('/api/mcp-import/preview',200,body);assert.equal(JSON.stringify(result).includes('private'),false);assert.deepEqual(result.envNames,['TOKEN']);assert.equal(mcpImportResponse('/api/mcp-import/import',500,{error:'private'}),null);
});
test('MCP views show explicit scan/import and per-agent loading without auto grants',()=>{
 const React=require('../node_modules/react'),{renderToStaticMarkup}=require('../node_modules/react-dom/server'),{McpLibrary,AgentMcp}=require('../src/McpLibrary.tsx');const html=renderToStaticMarkup(React.createElement(McpLibrary,{client:{},view:'discover'}));assert.match(html,/Scan Claude/);assert.match(html,/never starts/);const agent=renderToStaticMarkup(React.createElement(AgentMcp,{client:{},agentId:'main-agent'}));assert.match(agent,/Loading connections/);assert.match(agent,/Future or changed tools need a new grant/);
});

test('GenVR automatic setup accepts only its fixed empty bootstrap request',()=>{
 const {allowedGenVR,genvrResponse}=require('../src/genvr-contract.js');const path='/api/genvr/mcp/bootstrap';assert.equal(allowedGenVR('POST',path,{}),true);assert.equal(allowedGenVR('POST',path,{command:'anything',grantAll:true}),false);assert.equal(allowedGenVR('GET',path),false);assert.deepEqual(genvrResponse(path,200,{status:'blocked',id:null,secret:'hidden'}),{status:'blocked',id:null});
});
