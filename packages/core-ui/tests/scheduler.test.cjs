require('./load.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict');
const {allowedScheduler,schedulerResponse}=require('../src/scheduler-contract.js');
const {allowedRequest}=require('../src/session.ts');
const {allowed}=require('../scripts/application-server.cjs');
const paths=['/api/scheduler/jobs','/api/scheduler/jobs/job-1','/api/scheduler/jobs/job-1/history'];
test('scheduler bridge permits only exact metadata reads and empty explicit control calls',()=>{
 for(const path of paths){assert.ok(allowedRequest('GET',path));assert.ok(allowed('GET',path));assert.equal(allowedScheduler('GET',path,{}),false);}
 for(const suffix of ['enable','disable','execute']){const path='/api/scheduler/jobs/job-1/'+suffix;assert.ok(allowedRequest('POST',path,{}));assert.ok(allowed('POST',path,{}));assert.equal(allowedRequest('POST',path,{actionData:{command:'unsafe'}}),false);assert.equal(allowedRequest('POST',path),false);}
 for(const path of ['/api/scheduler/jobs?fresh=1','/api/scheduler/queue/clear','/api/scheduler/jobs/../private','/api/scheduler/jobs/%2e%2e','/api/scheduler/jobs/job-1/run','/api/scheduler/jobs/job-1/delete'])assert.equal(allowedScheduler('POST',path,{}),false);
 assert.equal(allowedRequest('POST','/api/scheduler/jobs',{}),false);assert.equal(allowedRequest('DELETE','/api/scheduler/jobs/job-1'),false);
});
const job={id:'job-1',name:'Fictional schedule',description:'Fictional description',enabled:false,cronExpression:'0 9 * * *',actionType:'memory-job',lastRun:null,nextRun:null,actionData:{apiKey:'fixture-private'},ownerId:'hidden'};
test('metadata projection strips action settings and run output on both sides of the bridge',()=>{
 const p=paths[0],first=schedulerResponse(p,200,{success:true,jobs:[job],stats:{secret:'hidden'}});
 assert.deepEqual(schedulerResponse(p,200,first),first);assert.ok(!JSON.stringify(first).includes('fixture-private'));assert.ok(!JSON.stringify(first).includes('ownerId'));
 const history=schedulerResponse(paths[2],200,{success:true,history:[{success:false,executedAt:'2026-10-22T01:00:00Z',duration:10,output:'private output',error:'private failure'}]});
 assert.deepEqual(schedulerResponse(paths[2],200,history),history);assert.ok(!JSON.stringify(history).includes('private'));
 assert.throws(()=>schedulerResponse(paths[1],200,{job:{...job,id:'other'}}));
 assert.deepEqual(schedulerResponse(paths[1]+'/execute',200,{success:false,error:'private'}),{success:false});
});
test('page uses a searchable list and selected inspector; non-owner render sends no requests',()=>{
 const React=require('../node_modules/react'),{renderToStaticMarkup}=require('../node_modules/react-dom/server'),{ScheduledTasks,scheduleLabel}=require('../src/ScheduledTasks.tsx');
 let calls=0;const client={getSnapshot:()=>({user:{role:'owner'}}),request:()=>{calls++;throw Error('no automatic server-render calls')}};
 const html=renderToStaticMarkup(React.createElement(ScheduledTasks,{client}));assert.match(html,/Search scheduled tasks/);assert.match(html,/Filter schedules/);assert.match(html,/Selected schedule/);assert.equal(calls,0);
 const denied=renderToStaticMarkup(React.createElement(ScheduledTasks,{client:{...client,getSnapshot:()=>({user:{role:'user'}})}}));assert.match(denied,/Only the workspace owner/);assert.doesNotMatch(denied,/Run now/);
 assert.equal(scheduleLabel('*/10 * * * *'),'Every 10 minutes');assert.equal(scheduleLabel('0 9 * * *'),'Daily at 09:00');assert.equal(scheduleLabel('0 9 * * 1'),'Custom schedule');
});
