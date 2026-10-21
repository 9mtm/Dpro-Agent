require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedLocalImport, localImportResponse } = require('../src/local-import-contract.js');
const { allowed } = require('../scripts/application-server.cjs');
const { LocalImportController } = require('../src/local-import.ts');
const { SessionClient } = require('../src/session.ts');
const { createLoginMock } = require('../src/session-mock.ts');

const SID = 'a'.repeat(32), JOB = '0f8fad5b-d9cb-469f-a165-70867728950e';
test('local import contract: opaque ids only, at most 400; no paths beyond the folder', () => {
  for (const [b, ok] of [[{ sessionIds: [SID] }, true], [{ sessionIds: ['../x'] }, false], [{ sessionIds: [] }, false], [{ sessionIds: [SID, SID] }, false],
    [{ sessionIds: Array.from({ length: 401 }, (_, i) => i.toString(16).padStart(32, '0')) }, false], [{ sessionIds: [SID], path: '/etc' }, false]]) {
    assert.equal(allowedLocalImport('POST', '/api/memory/import/local', b), ok, JSON.stringify(b).slice(0, 60));
    assert.equal(allowed('POST', '/api/memory/import/local', b), ok, 'bridge');
  }
  const body = { archive: '~/.dpro/imports', sessions: [{ id: SID, source: 'codex', cwd: '/w/app', title: 'Deploy rules', updatedAt: 'u', bytes: 10, turns: 3, imported: null, file: '/secret/path.jsonl' }, { id: 'bad', source: 'codex' }] };
  const once = localImportResponse('/api/memory/import/local', 200, body);
  assert.equal(once.sessions.length, 1); assert.ok(!JSON.stringify(once).includes('/secret/path'));
  assert.deepEqual(localImportResponse('/api/memory/import/local', 200, once), once, 'stable twice');
});

test('local import: choose conversations, start, follow the job to the end', async t => {
  const base = createLoginMock(); let polls = 0; const posts = [];
  const live = async r => {
    if (!r.path.startsWith('/api/memory/import/local')) return base(r);
    if (r.method === 'POST') { posts.push(r.body); return { status: 202, body: { job: { id: JOB, total: 1, done: 0, proposed: 0, errors: 0, status: 'running' } } }; }
    if (r.path.endsWith(JOB)) { polls++; return { status: 200, body: { job: { id: JOB, total: 1, done: 1, proposed: 4, errors: 0, status: 'done', notice: '4 memories are waiting for your approval.' } } }; }
    return { status: 200, body: { archive: '~/.dpro/imports', sessions: [{ id: SID, source: 'claude-code', cwd: '/w/app', title: 'Always answer in Arabic', updatedAt: '2026-10-16T10:00:00Z', bytes: 9, turns: 4, imported: null }] } };
  };
  const client = new SessionClient({ live }); client.selectMode('live'); await client.login('demo@example.invalid', 'mock-only');
  const c = new LocalImportController(client, 5); t.after(() => c.dispose());
  await c.load();
  assert.equal(c.getSnapshot().sessions.length, 1);
  c.toggle(SID); await c.start();
  assert.deepEqual(posts, [{ sessionIds: [SID] }]);
  for (let i = 0; i < 50 && c.getSnapshot().job?.status === 'running'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(c.getSnapshot().job.proposed, 4); assert.ok(polls >= 1);
  const { LocalImport } = require('../src/LocalImport.tsx');
  const html = renderToStaticMarkup(React.createElement(LocalImport, { client, active: false, onReview: () => {} }));
  assert.match(html, /Import from other agents/); assert.match(html, /Manual imports wait for your approval/);
});

async function batchFixture(t, count=45) {
 const base=createLoginMock(),posts=[];let serial=0;const jobs=new Map();
 const sessions=Array.from({length:count},(_,i)=>({id:i.toString(16).padStart(32,'0'),source:i%2?'codex':'claude-code',title:'Fictional '+i,updatedAt:'2026-10-17',turns:2,bytes:10,imported:null}));
 const client=new SessionClient({live:async r=>{
  if(!r.path.startsWith('/api/memory/import/local'))return base(r);
  if(r.method==='POST') {posts.push(r.body.sessionIds);const id=`0f8fad5b-d9cb-469f-a165-${(++serial).toString().padStart(12,'0')}`;const job={id,total:r.body.sessionIds.length,done:r.body.sessionIds.length,proposed:r.body.sessionIds.length,errors:0,status:'done'};jobs.set(id,job);return {status:202,body:{job:{...job,status:'running',done:0,proposed:0}}};}
  const id=r.path.split('/').at(-1);if(jobs.has(id))return {status:200,body:{job:jobs.get(id)}};
  return {status:200,body:{sessions,archive:'~/.dpro/imports'}};
 }});client.selectMode('live');await client.login('demo@example.invalid','mock-only');
 const c=new LocalImportController(client,5);t.after(()=>c.dispose());await c.load();return {c,posts,sessions};
}
test('select all imports 45 conversations as one durable server job, exactly once',async t=>{
 const {c,posts,sessions}=await batchFixture(t);c.selectAll(sessions.map(x=>x.id));assert.equal(c.getSnapshot().selected.length,45);
 await Promise.all([c.start(),c.start()]);
 for(let i=0;i<100&&c.getSnapshot().busy;i++)await new Promise(r=>setTimeout(r,10));
 assert.deepEqual(posts.map(x=>x.length),[45]);assert.equal(new Set(posts.flat()).size,45);
 assert.deepEqual(c.getSnapshot().progress,{total:45,done:45,proposed:45});assert.equal(c.getSnapshot().busy,false);
});
test('source-filtered select-all excludes unknown ids and imports only that source',async t=>{
 const {c,sessions}=await batchFixture(t);const codex=sessions.filter(x=>x.source==='codex');c.selectAll([...codex.map(x=>x.id),'f'.repeat(32)]);assert.deepEqual(c.getSnapshot().selected,codex.map(x=>x.id));
 const {LocalImportView}=require('../src/LocalImport.tsx');const html=renderToStaticMarkup(React.createElement(LocalImportView,{controller:c,active:false,onReview(){}}));assert.match(html,/Select all matching/);assert.match(html,/22 selected/);
});
test('disposing stops view polling without sending cancellation',async t=>{
 const {c,posts,sessions}=await batchFixture(t);c.selectAll(sessions.map(x=>x.id));await c.start();c.dispose();await new Promise(r=>setTimeout(r,25));assert.equal(posts.length,1);
});

test('preview does not select or import, and closing discards a late response', async t => {
 const base=createLoginMock();let resolvePreview;let posts=0;
 const client=new SessionClient({live:async r=>{
  if(!r.path.startsWith('/api/memory/import/local'))return base(r);
  if(r.method==='POST'){posts++;throw Error('unexpected import');}
  if(r.path.includes('/sessions/'))return new Promise(resolve=>{resolvePreview=resolve;});
  return {status:200,body:{sessions:[{id:SID,source:'codex',title:'Fictional',imported:null}]}};
 }});client.selectMode('live');await client.login('demo@example.invalid','mock-only');
 const c=new LocalImportController(client,5);t.after(()=>c.dispose());await c.load();
 const pending=c.preview(SID);c.closePreview();resolvePreview({status:200,body:{id:SID,source:'codex',messages:[{role:'user',text:'Fictional preference'}],truncated:false}});await pending;
 assert.equal(c.getSnapshot().preview,undefined);assert.deepEqual(c.getSnapshot().selected,[]);assert.equal(posts,0);
});
test('preview and resume contract restrict routes and transcript size',()=>{
 const path='/api/memory/import/local/sessions/'+SID;
 assert.equal(allowedLocalImport('GET',path),true);
 assert.equal(allowedLocalImport('POST',path),false);
 assert.equal(allowedLocalImport('POST','/api/memory/import/local/jobs/'+JOB+'/resume'),true);
 const body={id:SID,source:'codex',messages:[{role:'user',text:'Safe text'}],file:'/private/source'};
 assert.ok(!JSON.stringify(localImportResponse(path,200,body)).includes('/private'));
 assert.throws(()=>localImportResponse(path,200,{...body,messages:[{role:'user',text:'x'.repeat(2001)}]}));
});
test('a fresh page reattaches to a running server job without a new POST',async t=>{
 const base=createLoginMock();let posts=0;
 const job={id:JOB,total:45,done:12,proposed:3,errors:0,status:'running'};
 const client=new SessionClient({live:async r=>{
  if(!r.path.startsWith('/api/memory/import/local'))return base(r);
  if(r.method==='POST')posts++;
  return {status:200,body:{sessions:[],job}};
 }});client.selectMode('live');await client.login('demo@example.invalid','mock-only');
 const first=new LocalImportController(client,1000);await first.load();first.dispose();
 const second=new LocalImportController(client,1000);t.after(()=>second.dispose());await second.load();
 assert.equal(second.getSnapshot().job.id,JOB);assert.equal(second.getSnapshot().progress.done,12);assert.equal(second.getSnapshot().busy,true);assert.equal(posts,0);
});

test('project document contract accepts explicit folders and bounded redacted previews only',()=>{
 const scan='/api/memory/import/local/documents',preview=scan+'/'+SID;
 assert.equal(allowedLocalImport('POST',scan,{auto:true}),true);assert.equal(allowedLocalImport('POST',scan,{auto:true,roots:['/x']}),false);
 for(const roots of [['/project'],['/one','/two']])assert.equal(allowedLocalImport('POST',scan,{roots}),true);
 for(const roots of [[],['relative'],Array(9).fill('/x'),['/x\0y']])assert.equal(allowedLocalImport('POST',scan,{roots}),false);
 assert.equal(allowedLocalImport('GET',scan),false);assert.equal(allowedLocalImport('GET',preview),true);
 const once=localImportResponse(preview,200,{id:SID,name:'CLAUDE.md',text:'[REDACTED:secret]',truncated:false,file:'/private/original'});
 assert.deepEqual(localImportResponse(preview,200,once),once);assert.ok(!JSON.stringify(once).includes('/private'));
 assert.throws(()=>localImportResponse(preview,200,{id:SID,name:'CLAUDE.md',text:'x'.repeat(20001)}));
 assert.deepEqual(localImportResponse(preview,409,{code:'document_changed',text:'private'}),{code:'document_changed'});
});
test('project-file import uses the same durable server job without selecting conversations',async t=>{
 const {c,posts}=await batchFixture(t,1);await c.importDocuments([SID]);assert.deepEqual(posts,[[SID]]);assert.deepEqual(c.getSnapshot().selected,[]);
 const {ProjectFilesImport}=require('../src/ProjectFilesImport.tsx');
 const html=renderToStaticMarkup(React.createElement(ProjectFilesImport,{client:{},controller:c,busy:false}));
 assert.match(html,/Choose folders/);assert.match(html,/Find project files/);assert.match(html,/CLAUDE.md/);assert.match(html,/Secrets are masked/);
});


test('automatic import settings are narrow and never expose owner ids',()=>{
 const p='/api/memory/import/local/automatic';assert.equal(allowedLocalImport('GET',p),true);
 assert.equal(allowedLocalImport('PUT',p,{enabled:true,intervalMinutes:60}),true);
 for(const body of [{enabled:true,intervalMinutes:1},{enabled:true,intervalMinutes:60,autoApprove:true}])assert.equal(allowedLocalImport('PUT',p,body),false);
 const body={settings:{enabled:true,intervalMinutes:60,nextRun:123,lastRun:null,status:'idle',lastImported:1,lastProposed:1,notice:'Saved.',userId:'private-owner'}};
 const projected=localImportResponse(p,200,body);assert.ok(!JSON.stringify(projected).includes('private-owner'));assert.deepEqual(localImportResponse(p,200,projected),projected);
 const {AutomaticProjectImport}=require('../src/AutomaticProjectImport.tsx');const html=renderToStaticMarkup(React.createElement(AutomaticProjectImport,{client:{}}));
 assert.match(html,/Automatic import/);assert.match(html,/Every hour/);assert.match(html,/Every 15 minutes/);assert.match(html,/without an approval prompt/);
});

test('pause is owner-only wire action with stable paused projection and explicit resume',async()=>{
 const path='/api/memory/import/local/jobs/'+JOB+'/pause';
 assert.equal(allowedLocalImport('POST',path),true);assert.equal(allowed('POST',path),true);
 for(const [method,body] of [['GET',undefined],['DELETE',undefined],['POST',{owner:'other'}]])assert.equal(allowedLocalImport(method,path,body),false);
 const job={id:JOB,total:400,done:276,proposed:1493,errors:0,status:'paused',notice:'Paused.',userId:'private'};
 const projected=localImportResponse(path,202,{job});assert.equal(projected.job.status,'paused');assert.equal(projected.job.done,276);assert.ok(!JSON.stringify(projected).includes('private'));
 assert.deepEqual(localImportResponse(path,202,projected),projected);
 let state='running',pauseCalls=0,resumeCalls=0;
 const c=new LocalImportController({request:async r=>{
  if(r.path.endsWith('/pause')){pauseCalls++;state='paused';return {status:202,body:{job:{...job,status:state}}};}
  if(r.path.endsWith('/resume')){resumeCalls++;state='running';return {status:202,body:{job:{...job,status:state}}};}
  return {status:200,body:{sessions:[],archive:'~/.dpro/imports',job:{...job,status:state}}};
 }},10000);
 await c.load();await c.pause();assert.equal(c.getSnapshot().job.status,'paused');assert.equal(c.getSnapshot().busy,false);assert.equal(pauseCalls,1);
 await c.resume();assert.equal(c.getSnapshot().job.id,JOB);assert.equal(c.getSnapshot().job.done,276);assert.equal(c.getSnapshot().job.status,'running');assert.equal(resumeCalls,1);c.dispose();
});

test('a late progress poll cannot undo a confirmed pause',async()=>{
 let release,polled;const entered=new Promise(r=>polled=r);
 const running={id:JOB,total:3,done:1,proposed:0,errors:0,status:'running'};
 const c=new LocalImportController({request:async r=>{
  if(r.path.endsWith('/pause'))return {status:202,body:{job:{...running,status:'paused'}}};
  if(r.path.endsWith('/'+JOB)){polled();return new Promise(resolve=>release=resolve);}
  return {status:200,body:{sessions:[],archive:'',job:running}};
 }},1);
 await c.load();await entered;await c.pause();release({status:200,body:{job:running}});await new Promise(r=>setTimeout(r,10));
 assert.equal(c.getSnapshot().job.status,'paused');assert.equal(c.getSnapshot().busy,false);c.dispose();
});

// ---- MEM-IMPORT-03 ----
test('conversations are grouped by project folder, with where project facts go; large logs show their size', async t => {
  const base = createLoginMock();
  const row = (i, extra) => ({ id: i.toString(16).padStart(32, '0'), source: 'claude-code', cwd: '/Users/me/htdocs/shop', root: '/Users/me/htdocs/shop', rootName: 'shop', title: `Shop talk ${i}`, startedAt: null, updatedAt: '2026-10-20T10:00:00Z', bytes: 2048, turns: 4, imported: null, project: { slug: 'shop', name: 'Shop', linked: true }, ...extra });
  const sessions = [
    ...Array.from({ length: 30 }, (_, i) => row(i, i === 1 ? { cwd: '/Users/me/htdocs/shop-wt/fix' } : {})),
    row(40, { root: 'C:\\MAMP\\htdocs\\rare-pals', rootName: 'rare-pals', cwd: 'C:\\MAMP\\htdocs\\rare-pals', title: 'Old computer', project: { slug: 'rare-pals', name: 'rare-pals', linked: false }, turns: null, bytes: 3 * 1024 * 1024 }),
    row(41, { root: null, rootName: null, cwd: null, title: 'No folder at all', project: null }),
  ];
  const client = new SessionClient({ live: async r => (r.path.startsWith('/api/memory/import/local') ? { status: 200, body: { archive: '~/.dpro/imports', sessions } } : base(r)) });
  client.selectMode('live'); await client.login('demo@example.invalid', 'mock-only');
  const c = new LocalImportController(client, 5); t.after(() => c.dispose()); await c.load();
  assert.equal(c.getSnapshot().sessions[30].turns, null, 'unknown message count stays unknown');
  assert.equal(c.getSnapshot().sessions[0].project.linked, true);
  const { LocalImportView } = require('../src/LocalImport.tsx');
  const html = renderToStaticMarkup(React.createElement(LocalImportView, { controller: c, active: false, onReview: () => {} }));
  for (const words of ['<b dir="ltr">shop</b> · 30 conversations · Dpro project Shop', '~/htdocs/shop', 'Showing the newest 25 of 30', '~/htdocs/shop-wt/fix',
    '<b dir="ltr">rare-pals</b> · 1 conversation · project facts go to Projects · rare-pals', '3.0 MB', '<b dir="ltr">No folder</b> · 1 conversation · project facts go to About you'])
    assert.ok(html.includes(words), words);
  assert.equal((html.match(/Select Shop talk/g) ?? []).length, 25, 'at most 25 rows per project');
});

test('a new import while another is unfinished says so plainly', async t => {
  const base = createLoginMock();
  const client = new SessionClient({ live: async r => {
    if (!r.path.startsWith('/api/memory/import/local')) return base(r);
    if (r.method === 'POST') return { status: 409, body: { error: 'x', code: 'import_running' } };
    return { status: 200, body: { archive: '~/.dpro/imports', sessions: [{ id: SID, source: 'codex', cwd: null, root: null, rootName: null, project: null, title: 'T', startedAt: null, updatedAt: 'u', bytes: 1, turns: 1, imported: null }] } };
  } });
  client.selectMode('live'); await client.login('demo@example.invalid', 'mock-only');
  const c = new LocalImportController(client, 5); t.after(() => c.dispose()); await c.load();
  c.toggle(SID); await c.start();
  assert.match(c.getSnapshot().notice, /Another import is not finished yet/);
  assert.equal(c.getSnapshot().busy, false);
});
