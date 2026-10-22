require('./load.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict');
const {allowedCoverage,coverageResponse,COVERAGE_PATH}=require('../src/security-coverage-contract.js');
const {allowedRequest}=require('../src/session.ts'),{allowed}=require('../scripts/application-server.cjs');
const tool={name:'fixture_tool',category:null,origin:'builtin',independentApproval:false,executionClass:true,allowedByServer:false,selfOnly:false};
test('coverage is an exact read-only bridge contract',()=>{
 assert.ok(allowedCoverage('GET',COVERAGE_PATH));assert.ok(allowedRequest('GET',COVERAGE_PATH));assert.ok(allowed('GET',COVERAGE_PATH));
 for(const method of ['POST','PUT','DELETE','PATCH']){assert.equal(allowedRequest(method,COVERAGE_PATH,{}),false);assert.equal(allowed(method,COVERAGE_PATH,{}),false);}
 assert.equal(allowedCoverage('GET',COVERAGE_PATH,{}),false);assert.equal(allowedRequest('GET',COVERAGE_PATH+'?agentId=other'),false);
});
test('projection is idempotent, strips arbitrary fields and refuses unknown coverage states',()=>{
 const body={scope:'workspace_catalogue',limited:false,separatePaths:['coding_apps','terminal','workspace_scheduler'],tools:[{...tool,env:{secret:'fixture-private'},schema:{token:'secret'},description:'private instructions'}],credentials:'private'};
 const first=coverageResponse(200,body);assert.deepEqual(coverageResponse(200,first),first);assert.ok(!JSON.stringify(first).includes('private'));assert.ok(!JSON.stringify(first).includes('schema'));
 for(const change of [{category:'everything'},{allowedByServer:'true'},{origin:'trusted'},{category:undefined}])assert.throws(()=>coverageResponse(200,{...body,tools:[{...tool,...change}]}));
 assert.throws(()=>coverageResponse(200,{...body,tools:[tool,tool]}));assert.deepEqual(coverageResponse(503,{secret:'hidden'}),{code:'coverage_unavailable'});
});
test('coverage viewer reports catalogue scope and offers no permission mutation or execution action',()=>{
 const React=require('../node_modules/react'),{renderToStaticMarkup}=require('../node_modules/react-dom/server'),{PermissionCoverage}=require('../src/PermissionCoverage.tsx');
 const client={getSnapshot:()=>({user:{role:'owner'}})};
 const html=renderToStaticMarkup(React.createElement(PermissionCoverage,{client,active:true}));
 assert.match(html,/Workspace tool catalogue/);assert.match(html,/not the selected agent/);assert.match(html,/Find coverage tool/);assert.match(html,/Without an action switch/);assert.doesNotMatch(html,/Run now|Enable tool|Save permissions/);
 assert.equal(renderToStaticMarkup(React.createElement(PermissionCoverage,{client:{getSnapshot:()=>({user:{role:'user'}})},active:true})), '');
});
