require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { allowedRequest } = require('../src/session.ts');
const { allowed, createApplicationServer } = require('../scripts/application-server.cjs');
const { conversationResponse, projectRunEvent, RunEventParser } = require('../src/conversation-contract.js');

const CID = '3f0c2b6e-1d2a-4f4e-9b1a-6c7d8e9f0a1b';
const RID = 'run-0123456789ab';
const enc = s => new TextEncoder().encode(s);

test('conversation contract (browser and bridge): exact paths, strict bodies', () => {
  for (const allow of [allowedRequest, allowed]) {
    assert.equal(allow('GET', '/api/chat/conversations', undefined), true);
    assert.equal(allow('POST', '/api/chat/conversations', {}), true);
    assert.equal(allow('POST', '/api/chat/conversations', { title: 'Plan', agentId: 'agent-1' }), true);
    assert.equal(allow('POST', '/api/chat/conversations', { title: 'x', extra: 1 }), false);
    assert.equal(allow('PUT', `/api/chat/conversations/${CID}`, { pinned: true }), true);
    assert.equal(allow('PUT', `/api/chat/conversations/${CID}`, { title: null }), true);
    assert.equal(allow('PUT', `/api/chat/conversations/${CID}`, {}), false);
    assert.equal(allow('PUT', `/api/chat/conversations/${CID}`, { pinned: 'yes' }), false);
    assert.equal(allow('DELETE', `/api/chat/conversations/${CID}`, undefined), true);
    assert.equal(allow('DELETE', `/api/chat/conversations/${CID}/messages`, undefined), false);
    assert.equal(allow('DELETE', '/api/boards/b1', undefined), false);
    assert.equal(allow('GET', `/api/chat/conversations/${CID}/messages`, undefined), true);
    assert.equal(allow('GET', '/api/chat/conversations/../x/messages', undefined), false);
    assert.equal(allow('POST', `/api/chat/conversations/${CID}/runs`, { runId: RID, message: 'Hello' }), true);
    assert.equal(allow('POST', `/api/chat/conversations/${CID}/runs`, { runId: RID, message: '  ' }), false);
    assert.equal(allow('POST', `/api/chat/conversations/${CID}/runs`, { runId: 'short', message: 'x' }), false);
    assert.equal(allow('POST', `/api/chat/conversations/${CID}/runs`, { runId: RID, message: 'x', agentId: 'a' }), true, 'another agent may write the reply (CHAT-PRO-02 I)');
    assert.equal(allow('POST', `/api/chat/conversations/${CID}/runs`, { runId: RID, message: 'x', agentId: '../x' }), false);
    assert.equal(allow('POST', `/api/chat/conversations/${CID}/runs`, { runId: RID, message: 'x'.repeat(100001) }), false);
    assert.equal(allow('GET', `/api/chat/runs/${RID}/events`, undefined), true);
    assert.equal(allow('GET', `/api/chat/runs/${RID}/events?after=42`, undefined), true);
    assert.equal(allow('GET', `/api/chat/runs/${RID}/events?after=042`, undefined), false);
    assert.equal(allow('GET', `/api/chat/runs/${RID}/events?after=1&x=2`, undefined), false);
    assert.equal(allow('POST', `/api/chat/runs/${RID}/stop`, undefined), true);
    assert.equal(allow('POST', `/api/chat/runs/${RID}/stop`, {}), false);
  }
});

test('responses keep reviewed fields only; error text never passes', () => {
  const list = conversationResponse('/api/chat/conversations', 200, { conversations: [{ id: CID, title: 'T', agentId: 'a1', pinned: true, preview: 'p', createdAt: 'c', updatedAt: 'u', user_id: 'secret' }] });
  assert.deepEqual(list, { conversations: [{ id: CID, title: 'T', agentId: 'a1', projectId: null, pinned: true, preview: 'p', createdAt: 'c', updatedAt: 'u' }] });
  assert.deepEqual(conversationResponse(`/api/chat/conversations/${CID}/runs`, 409, { code: 'conversation_busy', runId: RID, error: 'stack trace /Users/x' }), { code: 'conversation_busy', runId: RID });
  assert.equal(conversationResponse(`/api/chat/conversations/${CID}/runs`, 500, { code: 'boom', error: 'trace' }), null);
  const msgs = conversationResponse(`/api/chat/conversations/${CID}/messages`, 200, {
    conversation: { id: CID, title: null }, activeRunId: RID,
    messages: [{ id: 'm1', role: 'assistant', content: 'Hi', status: 'stopped', runId: RID, durationMs: 1200, createdAt: 'c', extra: 1,
      parts: [{ kind: 'reasoning', text: 'think' }, { kind: 'tools', step: 1, calls: [{ id: 'c1', name: 'exec', input: '{}', output: 'ok', isError: false, ms: 5, secret: 'x' }] }, { kind: 'weird' }] }],
  });
  assert.equal(msgs.activeRunId, RID);
  assert.deepEqual(msgs.messages[0].parts, [{ kind: 'reasoning', text: 'think' }, { kind: 'tools', step: 1, calls: [{ id: 'c1', name: 'exec', input: '{}', output: 'ok', isError: false, ms: 5 }] }]);
  assert.equal(msgs.messages[0].status, 'stopped');
  assert.throws(() => conversationResponse('/api/chat/conversations', 200, { conversations: 'x' }));
});

test('run events: projected, in order, duplicates after a re-attach dropped, nothing after end', () => {
  assert.equal(projectRunEvent({ seq: 1, type: 'note', text: 'x' }), undefined);
  assert.deepEqual(projectRunEvent({ seq: 2, type: 'end', status: 'error', ms: 9, code: 'model_unavailable', error: 'trace' }), { seq: 2, type: 'end', status: 'error', ms: 9, code: 'model_unavailable' });
  assert.throws(() => projectRunEvent({ type: 'text', content: 'x' }));
  const p = new RunEventParser(1);
  const out = p.push(enc('id: 1\ndata: {"seq":1,"type":"text","content":"old"}\n\n: ping\n\ndata: {"seq":2,"type":"text","content":"Hel"}\n\ndata: {"seq":3,"type":"te'));
  assert.deepEqual(out.map(e => e.content), ['Hel']);
  const more = p.push(enc('xt","content":"lo"}\n\ndata: {"seq":4,"type":"end","status":"complete","ms":5}\n\n'));
  assert.deepEqual(more.map(e => e.type), ['text', 'end']);
  assert.equal(p.ended, true); assert.equal(p.last, 4);
  assert.throws(() => p.push(enc('data: {"seq":5,"type":"text","content":"late"}\n\n')));
});

test('bridge: run event stream passes projected frames, ends with the run, re-attach sends after=', async t => {
  const calls = [];
  const backend = http.createServer((req, res) => {
    calls.push({ url: req.url, accept: req.headers.accept, method: req.method });
    if (req.url.startsWith(`/api/chat/runs/${RID}/events`)) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': ping\n\n');
      res.write(`id: 1\ndata: ${JSON.stringify({ seq: 1, type: 'tool_start', step: 1, tools: [{ id: 'c1', name: 'exec', input: '{"cmd":"ls"}', secret: 'x' }] })}\n\n`);
      res.write(`id: 2\ndata: ${JSON.stringify({ seq: 2, type: 'end', status: 'complete', ms: 10 })}\n\n`);
      return; // the backend keeps the socket open; the bridge ends on the end event
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'DELETE') return res.end(JSON.stringify({ ok: true }));
    res.end(JSON.stringify({ conversations: [] }));
  });
  await new Promise(r => backend.listen(0, '127.0.0.1', r));
  const app = createApplicationServer({ channel: 'candidate', upstreamPort: backend.address().port });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  t.after(() => { app.close(); app.closeAllConnections(); backend.close(); backend.closeAllConnections(); });
  const port = app.address().port, origin = `http://127.0.0.1:${port}`;
  const get = (path, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { Origin: origin, Accept: 'text/event-stream', Authorization: 'Bearer fiction-token' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], text }));
    }); req.on('error', reject); req.end();
  });
  const r = await get(`/api/chat/runs/${RID}/events?after=0`);
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/event-stream/);
  const frames = r.text.split('\n\n').filter(b => b.startsWith('data:')).map(b => JSON.parse(b.slice(5)));
  assert.deepEqual(frames, [{ seq: 1, type: 'tool_start', step: 1, tools: [{ id: 'c1', name: 'exec', input: '{"cmd":"ls"}' }] }, { seq: 2, type: 'end', status: 'complete', ms: 10 }]);
  assert.equal(calls[0].accept, 'text/event-stream');
  assert.equal((await get(`/api/chat/runs/${RID}/events?after=0&x=1`)).status, 400);
  const del = await get(`/api/chat/conversations/${CID}`, 'DELETE');
  assert.equal(del.status, 200);
  assert.equal((await get('/api/boards/b1', 'DELETE')).status, 400);
});

test('bridge: a reader connection is capped; the run keeps going on the server', async t => {
  let closed = false;
  const backend = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ seq: 5, type: 'text', content: 'still working' })}\n\n`);
    req.on('close', () => { closed = true; });
  });
  await new Promise(r => backend.listen(0, '127.0.0.1', r));
  const app = createApplicationServer({ channel: 'candidate', upstreamPort: backend.address().port, runStreamMs: 150, runIdleMs: 5000 });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  t.after(() => { app.close(); app.closeAllConnections(); backend.close(); backend.closeAllConnections(); });
  const port = app.address().port, origin = `http://127.0.0.1:${port}`;
  const text = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: `/api/chat/runs/${RID}/events?after=4`, headers: { Origin: origin, Accept: 'text/event-stream', Authorization: 'Bearer fiction-token' } }, res => {
      let s = ''; res.setEncoding('utf8'); res.on('data', c => { s += c; }); res.on('end', () => resolve(s));
    }); req.on('error', reject); req.end();
  });
  assert.match(text, /still working/);
  for (let i = 0; i < 50 && !closed; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(closed, true, 'the bridge closed its upstream reader (the server run is unaffected)');
  assert.throws(() => createApplicationServer({ channel: 'candidate', runStreamMs: 10 * 60 * 1000 }));
});

test('browser transport: a 202 run start is a success with its projected body', async () => {
  const { createSameOriginTransport } = require('../src/session.ts');
  const origin = 'http://127.0.0.1:42522';
  const fetcher = async (url) => ({ status: 202, url, redirected: false, type: 'basic', headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ runId: RID, userMessage: { id: 'm1', role: 'user', content: 'hi', parts: null, status: 'complete', runId: RID, durationMs: null, createdAt: 'c' }, internal: 'x' }) });
  const transport = createSameOriginTransport(origin, fetcher);
  const r = await transport({ method: 'POST', path: `/api/chat/conversations/${CID}/runs`, body: { runId: RID, message: 'hi' }, headers: { Authorization: 'Bearer token' }, signal: new AbortController().signal });
  assert.equal(r.status, 202);
  assert.equal(r.body.runId, RID);
  assert.equal(r.body.internal, undefined);
});

test('folder picker contract bounds requests and strips filesystem metadata',()=>{
 for(const allow of [allowedRequest,allowed]){
  assert.equal(allow('POST','/api/chat/project-folders',{}),true);
  assert.equal(allow('POST','/api/chat/project-folders',{path:'/fiction/work'}),true);
  assert.equal(allow('POST','/api/chat/project-folders',{path:'/fiction',execute:true}),false);
  assert.equal(allow('GET','/api/chat/project-folders'),false);
 }
 const path='/api/chat/project-folders';const row={path:'/fiction',parent:null,selectable:false,truncated:false,entries:[{name:'Work',path:'/fiction/Work',private:'hidden'}],private:'hidden'};
 assert.ok(!JSON.stringify(conversationResponse(path,200,row)).includes('hidden'));
 assert.throws(()=>conversationResponse(path,200,{...row,entries:[{name:'../secret',path:'/secret'}]}));
});
