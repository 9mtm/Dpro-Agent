require('./load.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {allowedRequest}=require('../src/session.ts');
const {teamResourcesResponse}=require('../src/team-resources-contract.js');
const path='/api/onboarding/team-resources';
test('resource review accepts 72 departments but rejects grants and unselected roles',()=>{
 assert.equal(allowedRequest('POST',path,{departments:Array.from({length:72},(_,i)=>`department${i}`)}),true);
 for(const body of [{departments:['education'],grant:true},{departments:['education'],roles:[{department:'finance',name:'Analyst'}]},{departments:Array.from({length:73},(_,i)=>`department${i}`)}])assert.equal(allowedRequest('POST',path,body),false);
});
test('resource projection strips privileges, source data and hidden fields',()=>{
 const d={department:'education',label:'Education',board:{name:'Teaching',columns:['Prepare','Done']},needs:['Course design'],pendingRoles:['Teacher'],skills:[{id:'course',name:'Course',reason:'Review required',source:'private',grants:['all']}],connections:[{id:'mcp',name:'MCP',reason:'Review required',state:'disabled',token:'private'}],owner:'private'};
 const result=teamResourcesResponse(200,{departments:[d],private:'hidden'});
 assert.deepEqual(Object.keys(result),['departments']);assert.equal(result.departments[0].owner,undefined);assert.equal(result.departments[0].skills[0].grants,undefined);assert.equal(result.departments[0].connections[0].token,undefined);
 assert.throws(()=>teamResourcesResponse(200,{departments:[{...d,connections:[{...d.connections[0],state:'certified'}]}]}));
});
