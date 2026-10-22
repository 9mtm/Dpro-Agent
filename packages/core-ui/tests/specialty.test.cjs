require('./load.cjs');const {test}=require('node:test'),assert=require('node:assert/strict');
const React=require('../node_modules/react'),{renderToStaticMarkup}=require('../node_modules/react-dom/server');
const {SpecialtyLibrary}=require('../src/SpecialtyLibrary.tsx'),{DocumentEditor,MarkdownDocument}=require('../src/DocumentEditor.tsx');
const {allowedTemplates,templatesResponse,TEMPLATES_PATH:P,templateCategories}=require('../src/specialty-contract.js');
const {allowed}=require('../scripts/application-server.cjs'),{allowedRequest}=require('../src/session.ts');
const id='11111111-1111-4111-8111-111111111111',reqId='22222222-2222-4222-8222-222222222222';
const config={primarySkill:null,skills:[],tools:[],memoryRead:[],memoryWrite:[],sharedMemory:false,modes:Object.fromEntries(templateCategories.map(c=>[c,'ask'])),requirements:[{id:reqId,name:'Accounting records',toolName:null,server:'Accounting MCP'}]};
const draft={name:'Accountant',department:'finance',description:'Financial reports',instructions:'# Accountant',revision:1,config};
test('hire entry is a review destination and specialty section owns role navigation',()=>{
 const hire=renderToStaticMarkup(React.createElement(SpecialtyLibrary,{client:{},hire:true}));assert.match(hire,/Choose specialty template/);assert.doesNotMatch(hire,/aria-label="New specialty"/);assert.match(hire,/Find a specialty/);
 const library=renderToStaticMarkup(React.createElement(SpecialtyLibrary,{client:{}}));assert.match(library,/aria-label="New specialty"/);assert.match(library,/Assigned agents/);assert.doesNotMatch(library,/<textarea|Run exam|History…/);
});
test('missing requirements and draft-bound preview pass both bridge and client without expanding paths',()=>{
 for(const [method,path,body] of [['PUT',P+'/'+id,draft],['POST',P+'/'+id+'/preview',draft],['POST',P+'/'+id+'/assign',{revision:1,agentIds:['main-agent'],expectedAgentIds:[]}],['GET',P+'/assigned/main-agent'],['POST',P+'/hire',{templateId:id,revision:1,requestId:reqId,confirmed:true,confirmRisky:false,linked:true}]]){assert.equal(allowedTemplates(method,path,body),true);assert.equal(allowed(method,path,body),true);assert.equal(allowedRequest(method,path,body),true);}
 assert.equal(allowedTemplates('POST',P+'/'+id+'/assign',{revision:1,agentIds:['small-local-agent'],expectedAgentIds:[]}),false);
 assert.equal(allowedTemplates('GET',P+'/'+id+'/assign'),false);assert.equal(allowedTemplates('POST',P+'/'+id+'/preview',{...draft,config:{...config,requirements:[{...config.requirements[0],root:'/private'}]}}),false);
 assert.equal(allowedTemplates('PUT',P+'/'+id,{...draft,confirmImpact:'not-a-review'}),false);assert.equal(allowedTemplates('POST',P+'/'+id+'/assign',{revision:1,agentIds:['main-agent','main-agent'],expectedAgentIds:[]}),false);
});
test('access projection bounds permissions and strips arbitrary connector fields',()=>{
 const path=P+'/'+id+'/agents',body={agents:[{id:'main-agent',name:'Lina',linked:true,missingTools:['ledger'],access:[{id:reqId,name:'Ledger',toolName:null,server:'Accounting MCP',status:'needs_grant',scopes:['finance'],secret:'private'}],secret:'private'}]};
 const projected=templatesResponse(path,200,body);assert.doesNotMatch(JSON.stringify(projected),/private/);assert.equal(projected.agents[0].access[0].status,'needs_grant');assert.throws(()=>templatesResponse(path,200,{agents:[{...body.agents[0],access:[{...body.agents[0].access[0],status:'ready'}]}]}));
 const preview=templatesResponse(P+'/'+id+'/preview',200,{revision:1,confirmation:'a'.repeat(64),agents:[{id:'main-agent',name:'Lina'}],changes:[{field:'instructions',before:'old',after:'new'}],private:'secret'});assert.equal(preview.changes[0].after,'new');assert.doesNotMatch(JSON.stringify(preview),/secret/);
});
test('shared editor renders plain-text sources, safe Markdown and no textarea',()=>{
 const content='# Guide\n<script>alert(1)</script>\n\n```html\n<img src=x onerror=alert(1)>\n```';
 const editor=renderToStaticMarkup(React.createElement(DocumentEditor,{title:'Instructions',files:[{id:'main',name:'SKILL.md',content},{id:'ref',name:'references/policy.md',content:'# Rules'}],onChange(){},onClose(){}}));assert.doesNotMatch(editor,/<textarea/);assert.match(editor,/Document outline/);assert.match(editor,/Markdown preview/);assert.match(editor,/Find and replace/);assert.match(editor,/SKILL.md/);
 const html=renderToStaticMarkup(React.createElement(MarkdownDocument,{text:content}));assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|<img src=x/);assert.match(html,/data-line="0"/);
});


test('planning entries cross the bridge as read-only metadata without fabricated instructions',()=>{
 const planned={id,name:'Life and personal development coach',department:'Coaching',groups:['Coaching','Personal assistance'],kind:'role',planned:true,revision:0,description:'Content coming soon',agents:[],secret:'private'};
 const list=templatesResponse(P,200,{templates:[planned]}).templates;assert.equal(list[0].planned,true);assert.deepEqual(list[0].groups,planned.groups);assert.doesNotMatch(JSON.stringify(list),/private/);
 const detail=templatesResponse(P+'/'+id,200,planned);assert.equal(detail.instructions,undefined);assert.equal(detail.planned,true);
 assert.throws(()=>templatesResponse(P,200,{templates:[{...planned,planned:false}]}));assert.throws(()=>templatesResponse(P,200,{templates:[{...planned,revision:1}]}));
 assert.equal(templatesResponse(P+'/'+id,409,{code:'content_not_ready'}).code,'content_not_ready');
 assert.equal(allowedTemplates('POST',P+'/hire',{templateId:id,revision:0,requestId:reqId,confirmed:true,confirmRisky:false}),false);
 const html=renderToStaticMarkup(React.createElement(SpecialtyLibrary,{client:{}}));assert.match(html,/Content availability/);assert.match(html,/Coming soon/);
});
