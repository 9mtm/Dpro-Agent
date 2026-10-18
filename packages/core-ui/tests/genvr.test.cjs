require('./load.cjs');const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {allowedGenVR,genvrResponse}=require('../src/genvr-contract.js'),{allowed}=require('../scripts/application-server.cjs'),{allowedRequest}=require('../src/session.ts'),{createGenVRAssets}=require('../scripts/genvr-assets.cjs');
const project={format:'genvr-studio',version:1,id:'fictional-world',title:'Fictional garden',world:{},play:{}};
test('Studio bridge only accepts bounded private project operations and drops envelope fields',()=>{
 const route='/api/genvr/projects/'+project.id,b={project,revision:0};assert.ok(allowedGenVR('PUT',route,b));assert.ok(allowed('PUT',route,b));assert.ok(allowedRequest('PUT',route,b));
 for(const extra of [{...b,ownerId:'other'},{...b,revision:-1},{...b,project:{...project,id:'other'}}])assert.equal(allowed('PUT',route,extra),false);
 assert.equal(allowed('POST','/api/genvr/publish',{}),false);assert.equal(allowed('GET','/api/genvr/projects/../keys'),false);
 assert.deepEqual(genvrResponse(route,200,{project,revision:1,token:'hidden'}),{project,revision:1,agents:[]});assert.deepEqual(genvrResponse(route,200,{saved:true,revision:2,token:'hidden'}),{saved:true,revision:2});
 assert.throws(()=>genvrResponse(route,200,{project:{...project,id:'other'},revision:1}));
});
test('unprepared SDK returns unavailable without broadening arbitrary static files',()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'genvr-assets-'));try{const serve=createGenVRAssets(folder),responses=[];const res={writeHead:status=>responses.push(status),end:()=>{}};assert.equal(serve({method:'GET'},res,'/genvr/studio.html'),true);assert.equal(responses[0],503);assert.equal(serve({method:'GET'},res,'/private/secrets.env'),false);}finally{fs.rmSync(folder,{recursive:true,force:true});}
});
test('GenVR opens on a spaces library with Create space and no eager Studio frame',()=>{
 const React=require('../node_modules/react'),{renderToStaticMarkup}=require('../node_modules/react-dom/server'),{GenVRPage}=require('../src/GenVRPage.tsx');
 const html=renderToStaticMarkup(React.createElement(GenVRPage,{client:{},active:false}));assert.match(html,/Create space/);assert.match(html,/My spaces/);assert.match(html,/Search spaces/);assert.doesNotMatch(html,/<iframe/);
});

test('space agent contracts reject duplicates, forged grants and invalid avatars',()=>{
 const route='/api/genvr/projects/'+project.id,b={project,revision:0,agents:[{id:'main-agent',avatar:3}]};
 assert.equal(allowed('GET','/api/genvr/agents'),true);assert.equal(allowedRequest('GET','/api/genvr/agents'),true);assert.equal(allowed('PUT',route,b),true);
 for(const agents of [[...b.agents,...b.agents],[{id:'main-agent',avatar:8}],[{id:'main-agent',avatar:0,permissions:['all']}],[{id:'../keys',avatar:0}]])assert.equal(allowed('PUT',route,{...b,agents}),false);
 assert.deepEqual(genvrResponse('/api/genvr/agents',200,{agents:[{id:'main-agent',name:'Fictional agent',avatar:2,systemPrompt:'private'}]}),{agents:[{id:'main-agent',name:'Fictional agent',avatar:2}]});
});
