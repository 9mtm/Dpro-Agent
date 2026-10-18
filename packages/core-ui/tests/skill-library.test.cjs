require('./load.cjs');const {test}=require('node:test'),assert=require('node:assert/strict');
const {allowedSkillLibrary,skillLibraryResponse,SKILLS_PATH}=require('../src/skill-library-contract.js'),{allowed}=require('../scripts/application-server.cjs'),{allowedRequest}=require('../src/session.ts');
const id='11111111-1111-4111-8111-111111111111',hash='a'.repeat(64),assignment=SKILLS_PATH+'/agents/main-agent';
test('central skills bridge is narrow and rejects filesystem, grant and duplicate injection',()=>{
 for(const [method,url,body] of [['GET',SKILLS_PATH,undefined],['POST',SKILLS_PATH+'/scan',{}],['POST',SKILLS_PATH+'/preview',{scanId:id,sourceId:id}],['POST',SKILLS_PATH+'/import',{scanId:id,sourceId:id,hash}],['PUT',assignment,{revision:0,selected:[id]}]]){assert.ok(allowedSkillLibrary(method,url,body));assert.ok(allowed(method,url,body));assert.ok(allowedRequest(method,url,body));}
 for(const [method,url,body] of [['POST',SKILLS_PATH+'/scan',{root:'/etc'}],['POST',SKILLS_PATH+'/import',{scanId:id,sourceId:id,hash,grant:'all'}],['PUT',assignment,{revision:0,selected:[id,id]}],['PUT',assignment,{revision:-1,selected:[]}],['GET',SKILLS_PATH+'/agents/../keys',undefined],['GET',SKILLS_PATH+'/agents/small-local-agent',undefined]])assert.equal(allowed(method,url,body),false);
});
test('catalog and source projections discard private paths, raw secrets and internal fields',()=>{
 const row={id,name:'fictional-skill',description:'Fictional',version:'1',revision:1,content_hash:hash,origin:'claude',rawSecret:'hidden',directory:'/private'};
 assert.deepEqual(skillLibraryResponse(SKILLS_PATH,200,{skills:[row]}),{skills:[{id,name:row.name,description:row.description,version:'1',revision:1,content_hash:hash,origin:'claude'}]});
 const scan={id,status:'done',visited:1,skipped:0,limited:false,sources:[{id,name:'example',description:'test',origin:'codex',location:'.codex/skills/example',directory:'/private',secret:'hidden'}]};assert.ok(!JSON.stringify(skillLibraryResponse(SKILLS_PATH+'/scan',200,scan)).includes('hidden'));
 assert.throws(()=>skillLibraryResponse(assignment,200,{revision:0,selected:['../keys']}));assert.equal(skillLibraryResponse(SKILLS_PATH,500,{error:'private secret'}),null);
});
test('settings and agent skill views show honest unassigned loading states',()=>{
 const React=require('../node_modules/react'),{renderToStaticMarkup}=require('../node_modules/react-dom/server'),{SkillLibrary,AgentSkills}=require('../src/SkillLibrary.tsx');
 const html=renderToStaticMarkup(React.createElement(SkillLibrary,{client:{}}));assert.match(html,/Scan local skills/);assert.match(html,/Loading skills/);assert.doesNotMatch(html,/dangerouslySetInnerHTML/);
 const agent=renderToStaticMarkup(React.createElement(AgentSkills,{client:{},agentId:'main-agent'}));assert.match(agent,/Assigned skills/);assert.match(agent,/Tool and MCP permissions stay separate/);assert.match(agent,/Loading skills/);
});
