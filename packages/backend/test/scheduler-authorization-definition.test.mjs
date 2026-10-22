import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {captureScheduledDefinition,ScheduleDefinitionError} from '../src/scheduler/authorization-definition.ts';
const base=()=>({id:randomUUID(),name:'Reviewed external action',cronExpression:'0 9 * * 1',actionType:'api-call',actionData:{url:'https://example.invalid/task',method:'POST',body:{message:'Reviewed content',flags:[true,null,2]}}});
test('snapshot freezes caller data and normalizes object order, not execution fields',()=>{
 const job=base(),a=captureScheduledDefinition(job,'Europe/Vienna'),b=captureScheduledDefinition({...job,actionData:{body:job.actionData.body,method:'POST',url:job.actionData.url}},'Europe/Vienna');assert.equal(a.definitionHash,b.definitionHash);job.actionData.body.message='Changed later';assert.equal(a.definition.actionData.body.message,'Reviewed content');assert.ok(Object.isFrozen(a.definition.actionData.body.flags));
 for(const change of [{name:'Other display name'},{cronExpression:'0 10 * * 1'},{id:randomUUID()},{actionType:'send-message',actionData:{channelId:'fixture-channel',to:'recipient',content:'Hello'}},{actionData:{...job.actionData,body:{message:'Other content'}}}])assert.notEqual(captureScheduledDefinition({...job,...change},'Europe/Vienna').definitionHash,b.definitionHash);
 assert.notEqual(captureScheduledDefinition(job,'UTC').definitionHash,captureScheduledDefinition(job,'Europe/Vienna').definitionHash);
});
test('pause and run history are operational metadata, never new action authority',()=>{
 const job=base(),hash=captureScheduledDefinition(job,'UTC').definitionHash;assert.equal(captureScheduledDefinition({...job,enabled:false,lastRun:new Date(),nextRun:new Date(),createdAt:new Date(),updatedAt:new Date()},'UTC').definitionHash,hash);assert.equal(captureScheduledDefinition({...job,description:null},'UTC').definitionHash,hash);
 for(const change of [{userId:'owner'},{actor:{role:'owner'}},{authorized:true},{timezone:'UTC'}])assert.throws(()=>captureScheduledDefinition({...job,...change},'UTC'),ScheduleDefinitionError);
});
test('hostile or unbounded definitions fail without evaluating a getter',()=>{
 const job=base();let accessed=false;const payload={};Object.defineProperty(payload,'secret',{enumerable:true,get(){accessed=true;return 'secret';}});
 const array=[];Object.defineProperty(array,'0',{enumerable:true,get(){accessed=true;return 'secret';}});
 let deep={};for(let i=0;i<15;i++)deep={nested:deep};
 for(const data of [payload,{x:array},{x:undefined},{x:NaN},{x:BigInt(1)},{x:new Date()},{x:'a'.repeat(33000)},{x:Array(1001).fill(1)},deep,JSON.parse('{"__proto__":{"bad":true}}')])assert.throws(()=>captureScheduledDefinition({...job,actionData:data},'UTC'),ScheduleDefinitionError);
 assert.equal(accessed,false);assert.throws(()=>captureScheduledDefinition({...job,cronExpression:'bad'},'UTC'),ScheduleDefinitionError);assert.throws(()=>captureScheduledDefinition(job,'Unknown/Zone'),ScheduleDefinitionError);assert.throws(()=>captureScheduledDefinition({...job,actionType:'memory-job'},'UTC'),ScheduleDefinitionError);
});


test('effectful action semantics reject unreviewed identity, invalid network syntax and request framing',()=>{
 const job=base();for(const actionData of [{...job.actionData,actor:{role:'owner'}},{...job.actionData,userId:'owner'},{...job.actionData,url:'file:///private/data'},{...job.actionData,url:'https://user:pass@example.invalid/'},{...job.actionData,url:'https://example.invalid/#hidden'},{...job.actionData,method:'TRACE'},{...job.actionData,method:'GET'},{...job.actionData,headers:{Host:'other.invalid'}},{...job.actionData,headers:{'Content-Length':'0'}},{...job.actionData,headers:{Authorization:'line\r\nInjected: value'}}])assert.throws(()=>captureScheduledDefinition({...job,actionData},'UTC'),ScheduleDefinitionError);
 assert.ok(captureScheduledDefinition({...job,actionData:{url:'https://example.invalid/path',method:'GET',headers:{Accept:'application/json'}}},'UTC'));
});
test('message consent captures exact recipient/content/options and rejects extra authority fields',()=>{
 const job={...base(),actionType:'send-message',actionData:{channelId:'fixture-channel',to:'recipient',content:'Hello\nWorld',options:{silent:true}}};assert.ok(captureScheduledDefinition(job,'UTC'));
 for(const change of [{channelId:''},{to:'recipient\nother'},{content:''},{options:[]},{ownerId:'other'},{verified:true}])assert.throws(()=>captureScheduledDefinition({...job,actionData:{...job.actionData,...change}},'UTC'),ScheduleDefinitionError);
});
