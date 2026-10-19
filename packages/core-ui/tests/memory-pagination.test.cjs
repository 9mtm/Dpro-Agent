require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MemoryItemsController } = require('../src/memory-items.ts');
const { allowedRequest } = require('../src/session.ts');
const { allowed } = require('../scripts/application-server.cjs');
const { agentCardResponse } = require('../src/agent-card-contract.js');
const item = n => ({ id: `00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`, type: 'fact', content: `Fictional memory ${n}`, createdAt: '2026-01-01T00:00:00.000Z', drawer: {kind:'owner'}, embedding: [1,2], userId:'private-owner' });

test('all 5003 memories load through the real request/response contracts without truncation', async () => {
 const rows=Array.from({length:5003},(_,i)=>item(i));let calls=0,progress=[];
 const c=new MemoryItemsController({request:async r=>{
  assert.ok(allowedRequest(r.method,r.path));assert.ok(allowed(r.method,r.path));
  if(r.path==='/api/memory/drawers')return {status:200,body:{drawers:[]}};
  if(r.path==='/api/agents')return {status:200,body:{agents:[]}};
  const offset=r.path.includes('?')?Number(r.path.split('cursor=')[1]):0;calls++;
  const body={memories:rows.slice(offset,offset+100),nextCursor:offset+100<rows.length?String(offset+100):null,total:rows.length};
  return {status:200,body:agentCardResponse(r.path,200,agentCardResponse(r.path,200,body))};
 }});c.subscribe(()=>progress.push(c.getSnapshot().loaded));await c.load();
 assert.equal(c.getSnapshot().phase,'ready');assert.equal(c.visible().length,5003);assert.equal(new Set(c.visible().map(m=>m.id)).size,5003);assert.equal(calls,51);assert.ok(progress.includes(100));assert.ok(!JSON.stringify(c.getSnapshot().items).includes('embedding'));assert.ok(!JSON.stringify(c.getSnapshot().items).includes('private-owner'));c.dispose();
});
test('overlap is deduplicated and a repeated cursor cannot loop forever or report partial success',async()=>{
 let n=0;const c=new MemoryItemsController({request:async r=>r.path==='/api/memory/drawers'?{status:200,body:{drawers:[]}}:r.path==='/api/agents'?{status:200,body:{agents:[]}}:{status:200,body:{memories:n++?[item(1),item(2)]:[item(1)],total:2,nextCursor:n===1?'next':null}}});await c.load();assert.equal(c.getSnapshot().items.length,2);c.dispose();
 const bad=new MemoryItemsController({request:async()=>({status:200,body:{memories:[item(1)],total:10,nextCursor:'repeat'}})});await bad.load();assert.equal(bad.getSnapshot().phase,'error');assert.equal(bad.getSnapshot().items.length,0);bad.dispose();
});
test('disposal stops pagination and malformed cursor requests stay blocked at both boundaries',async()=>{
 let release,calls=0;const c=new MemoryItemsController({request:()=>{calls++;return new Promise(r=>release=r)}});const loading=c.load();c.dispose();release({status:200,body:{memories:[item(1)],total:2,nextCursor:'next'}});await loading;assert.equal(calls,1);assert.equal(c.getSnapshot().items.length,0);
 for(const path of ['/api/memory/page?cursor=','/api/memory/page?cursor=abc&owner=other','/api/memory/page?cursor=%2F','/api/memory/page?limit=9999','/api/memory/page?cursor='+ 'a'.repeat(1025)]){assert.equal(allowedRequest('GET',path),false);assert.equal(allowed('GET',path),false)}
 assert.equal(allowedRequest('POST','/api/memory/page',{}),false);
});

test('background refresh adds unique memories without loading flicker or losing drawer/search/draft', async()=>{
 let rows=[{...item(1),importance:5}], fail=false;
 const c=new MemoryItemsController({request:async r=>{
  if(r.path==='/api/memory/drawers')return {status:200,body:{drawers:[]}};
  if(r.path==='/api/agents')return {status:200,body:{agents:[]}};
  if(fail)throw Error('offline');
  return {status:200,body:{memories:rows,nextCursor:null,total:rows.length}};
 }});
 await c.load();c.openDrawer('owner');c.setQuery('Fictional');
 const phases=[];c.subscribe(()=>phases.push(c.getSnapshot().phase));
 rows=[...rows,item(2),item(2)];await c.load(true);
 assert.equal(c.getSnapshot().items.length,2);assert.ok(phases.every(x=>x==='ready'));
 assert.equal(c.getSnapshot().query,'Fictional');assert.equal(c.getSnapshot().open,'owner');
 c.startEdit(item(1).id);c.editDraft('unsaved text');rows=[...rows,item(3)];await c.load(true);
 assert.equal(c.getSnapshot().items.length,2);assert.equal(c.getSnapshot().draft,'unsaved text');
 c.cancelEdit();fail=true;await c.load(true);assert.equal(c.getSnapshot().phase,'ready');assert.equal(c.getSnapshot().items.length,2);
 fail=false;await c.load(true);assert.equal(c.getSnapshot().items.length,3);c.dispose();
});

test('background refresh cannot overlap or replace an edit started during a request',async()=>{
 let release,hold=false,calls=0;
 const c=new MemoryItemsController({request:async r=>{
  if(r.path==='/api/memory/drawers')return {status:200,body:{drawers:[]}};
  if(r.path==='/api/agents')return {status:200,body:{agents:[]}};
  calls++;if(hold)return new Promise(resolve=>release=resolve);
  return {status:200,body:{memories:[item(1)],nextCursor:null,total:1}};
 }});
 await c.load();hold=true;const pending=c.load(true);await c.load(true);assert.equal(calls,2);
 c.startEdit(item(1).id);c.editDraft('keep this');release({status:200,body:{memories:[item(1),item(2)],nextCursor:null,total:2}});await pending;
 assert.equal(c.getSnapshot().items.length,1);assert.equal(c.getSnapshot().draft,'keep this');c.dispose();
});

test('5003 memories render in bounded windows; every item and a late search result remain reachable',async()=>{
 const React=require('../node_modules/react');const {renderToStaticMarkup}=require('../node_modules/react-dom/server');const {ItemsView}=require('../src/MemoryViews.tsx');
 const rows=Array.from({length:5003},(_,i)=>({...item(i),importance:5}));
 const c=new MemoryItemsController({request:async r=>r.path==='/api/memory/drawers'?{status:200,body:{drawers:[]}}:r.path==='/api/agents'?{status:200,body:{agents:[]}}:{status:200,body:{memories:rows,nextCursor:null,total:rows.length}}});
 await c.load();const seen=new Set();
 for(let page=0;page<101;page++){
  const html=renderToStaticMarkup(React.createElement(ItemsView,{c}));const ids=[...html.matchAll(/id="memory-([^"]+)"/g)].map(m=>m[1]);
  assert.ok(ids.length<=50);ids.forEach(id=>seen.add(id));assert.match(html,/Showing/);c.movePage(1);
 }
 assert.equal(seen.size,5003);c.setQuery('Fictional memory 5002');assert.equal(c.getSnapshot().offset,0);
 assert.match(renderToStaticMarkup(React.createElement(ItemsView,{c})),/Fictional memory 5002/);
 c.setQuery('');c.reveal(item(4999).id);assert.equal(c.getSnapshot().offset,4950);c.startEdit(item(4999).id);c.editDraft('Keep my draft');c.movePage(-1);assert.equal(c.getSnapshot().offset,4950);assert.equal(c.getSnapshot().draft,'Keep my draft');c.dispose();
});

test('background insertion keeps the first memory of a later window anchored',async()=>{
 let rows=Array.from({length:151},(_,i)=>({...item(i),importance:5}));
 const c=new MemoryItemsController({request:async r=>r.path==='/api/memory/drawers'?{status:200,body:{drawers:[]}}:r.path==='/api/agents'?{status:200,body:{agents:[]}}:{status:200,body:{memories:rows,nextCursor:null,total:rows.length}}});
 await c.load();c.movePage(1);const anchor=c.visible()[c.getSnapshot().offset].id;
 rows=[{...item(999),importance:10},...rows];await c.load(true);
 assert.equal(c.getSnapshot().offset,51);assert.equal(c.visible()[51].id,anchor);assert.equal(c.getSnapshot().items.length,152);c.dispose();
});
