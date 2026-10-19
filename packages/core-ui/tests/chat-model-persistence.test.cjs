require('./load.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ConversationsController}=require('../src/conversations.ts');
const {allowedConversation,conversationResponse}=require('../src/conversation-contract.js');
const id='11111111-1111-4111-8111-111111111111';
function fixture(t){
 const rows=new Map([[id,{id,title:'Trial',agentId:null,projectId:null,pinned:false,preview:'',createdAt:'',updatedAt:''}]]),calls=[];let fail=false;
 const client={getSnapshot:()=>({phase:'authenticated',epoch:1,user:{role:'owner'}}),subscribe:()=>()=>{},request:async r=>{calls.push(r);
 if(r.path==='/api/models')return {status:200,body:{models:[{id:'subscription:codex',provider:'subscription',label:'Codex',size:''},{id:'qwen',provider:'ollama',label:'Qwen',size:''}]}};
 if(r.path.endsWith('/messages'))return {status:200,body:{conversation:{...rows.get(id)},messages:[],activeRunId:null}};
 if(r.method==='PUT'){if(fail)return {status:503};await Promise.resolve();const row=rows.get(id);if(r.body.model)row.model=r.body.model;else delete row.model;return {status:200,body:{conversation:{...row}}};}
 if(r.path==='/api/chat/conversations')return {status:200,body:{conversations:[...rows.values()].map(r=>({...r}))}};
 return {status:200,body:{projects:[],agents:[]}};}};
 const make=()=>{const c=new ConversationsController(client);t.after(()=>c.dispose());return c;};return {make,rows,calls,setFail:()=>{fail=true;}};
}
test('per-conversation selection survives controller recreation and rapid changes preserve last choice',async t=>{
 const f=fixture(t),a=f.make();await a.load();await a.loadModels();await a.open(id);
 a.selectModel('qwen');a.selectModel('subscription:codex');await a.open(id);
 assert.equal(f.rows.get(id).model,'subscription:codex');
 const b=f.make();await b.load();await b.open(id);assert.equal(b.getSnapshot().model,'subscription:codex');
 b.newChat();assert.equal(b.getSnapshot().model,'');assert.equal(f.rows.get(id).model,'subscription:codex');
 await b.open(id);b.selectModel('');await b.open(id);assert.equal(b.getSnapshot().model,'');assert.equal(f.rows.get(id).model,undefined);
});
test('failed model persistence blocks sending instead of silently using another provider',async t=>{
 const f=fixture(t),c=f.make();await c.load();await c.loadModels();await c.open(id);f.setFail();c.selectModel('subscription:codex');await c.send('fictional trial');
 assert.match(c.getSnapshot().notice,/not saved/);assert.equal(f.calls.some(r=>r.path.endsWith('/runs')),false);
});
test('model wire contract accepts bounded ids/default reset and strips unreviewed fields',()=>{
 assert.equal(allowedConversation('PUT',`/api/chat/conversations/${id}`,{model:'subscription:codex'}),true);
 assert.equal(allowedConversation('PUT',`/api/chat/conversations/${id}`,{model:''}),true);
 for(const model of [null,{},'x\nsecret','x'.repeat(101)])assert.equal(allowedConversation('PUT',`/api/chat/conversations/${id}`,{model}),false);
 const conversation={id,title:'Trial',agentId:null,projectId:null,pinned:false,preview:'',createdAt:'',updatedAt:'',model:'subscription:codex',private:'hidden'};
 const out=conversationResponse('/api/chat/conversations',200,{conversations:[conversation]});assert.equal(out.conversations[0].model,'subscription:codex');assert.equal(out.conversations[0].private,undefined);
});
