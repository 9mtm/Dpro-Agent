// Preloaded into the MCP server child process (node --import) by
// test/mcp-server.test.mjs. Replaces fetch with an in-process fake of the
// backend's small-agent API: no port, no network. Every call is appended to
// $FAKE_LOG as one JSON line (the token itself is never written, only whether
// it matched).
import { appendFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';

const LOG = process.env.FAKE_LOG;
const EXPECTED = process.env.FAKE_EXPECTED_TOKEN || '';
const SCENARIO = process.env.FAKE_SCENARIO || 'ok';
const BASE = 'http://127.0.0.1:41522';
const RUN = '11111111-2222-3333-4444-555555555555';
// Backend identity (MCP-01b): the real backend answers GET /api/instance with
// an HMAC of the nonce under the per-install secret. 'rogue' = a different
// local program on the port (wrong secret); 'noinstance' = no such endpoint.
const INSTANCE_ID = process.env.FAKE_INSTANCE_ID || '';
const INSTANCE_SECRET = SCENARIO === 'rogue' ? randomBytes(32).toString('hex') : (process.env.FAKE_INSTANCE_SECRET || '');
let cardCalls = 0;
let handoffVersion = 1;
let handoffBody = { done: ['Set up the repository'], left: ['Release notes'], next: ['Write the release notes'], questions: [] };

const log = (entry) => { if (LOG) appendFileSync(LOG, `${JSON.stringify(entry)}\n`); };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const capacity = (active) => ({ active, running: Math.min(active, 1), queued: Math.max(0, active - 1), waiting: 0, limit: 2, available: Math.max(0, 2 - active) });

const card = (status) => ({
  run_id: RUN, status, kind: 'lookup',
  summary: status === 'completed' ? 'Release is on Friday.' : 'Running.',
  outputs: status === 'completed' ? [{ type: 'text', text: 'Release is on Friday.\nFound in the project notes.' }] : [],
  steps_used: status === 'completed' ? 3 : 1, max_steps: 15, duration_ms: 1234, max_duration_ms: 300000,
  model: 'qwen3.8:27b', agent: 'small-local-agent', tools_granted: ['memory_search'], tools_used: status === 'completed' ? ['memory_search'] : [],
  drawers: ['project:alpha'],
  needs_review: status !== 'completed', review_reason: status === 'completed' ? null : 'the run has not finished',
  warnings: [], created_at: '2026-10-14 10:00:00', finished_at: status === 'completed' ? '2026-10-14 10:00:02' : null,
});

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
  if (url.startsWith(`${BASE}/api/instance?`)) {
    log({ instance: true, url, hasAuth: !!auth, redirect: init.redirect });
    if (SCENARIO === 'noinstance') return json(404, { error: 'not found' });
    const nonce = new URL(url).searchParams.get('nonce') || '';
    const proof = createHmac('sha256', Buffer.from(INSTANCE_SECRET, 'hex')).update(`agent-player-instance-v1:${INSTANCE_ID}:${nonce}`).digest('hex');
    return json(200, { id: INSTANCE_ID, proof, version: 1 });
  }
  const entry = { url, method: init.method || 'GET', authOk: auth === `Bearer ${EXPECTED}`, hasAuth: !!auth, redirect: init.redirect };
  if (init.body) entry.body = JSON.parse(init.body);
  log(entry);
  if (!url.startsWith(`${BASE}/`)) throw new Error('unexpected host');
  if (!entry.authOk) return json(401, { error: 'Authentication required' });
  const path = url.slice(BASE.length);
  if (entry.method === 'POST' && path === '/api/small-agent/runs') {
    if (SCENARIO === 'busy') return json(429, { error: 'busy', capacity: capacity(2) });
    if (SCENARIO === 'notowner') return json(403, { error: 'This action requires the owner account' });
    return json(201, {
      run_id: RUN, status: 'queued', kind: entry.body.kind ?? 'other',
      granted_tools: (entry.body.tools ?? ['memory_search', 'storage_search']).filter((t) => ['memory_search', 'storage_search', 'read'].includes(t)),
      drawers: entry.body.drawers ?? [], budget: { max_steps: Math.min(entry.body.max_steps ?? 15, 15), max_duration_ms: 300000 },
      model: 'qwen3.8:27b', warnings: (entry.body.tools ?? []).includes('exec') ? ['tool "exec" not given: not in the small-agent safe set'] : [],
      capacity: capacity(1),
    });
  }
  if (entry.method === 'GET' && path === `/api/small-agent/runs/${RUN}`) {
    cardCalls++;
    return json(200, { card: card(cardCalls >= 2 ? 'completed' : 'running') });
  }
  if (entry.method === 'GET' && path.startsWith('/api/small-agent/runs')) {
    return json(200, { runs: [{ run_id: RUN, status: 'running', kind: 'lookup', summary: null, steps_used: 1, max_steps: 15, created_at: '2026-10-14 10:00:00', finished_at: null }], capacity: capacity(2) });
  }
  // Agent handoff notes (owner only, CORE-MEM-HANDOFF).
  if (path.startsWith('/api/handoffs')) {
    if (SCENARIO === 'notowner') return json(403, { error: 'This action requires the owner account' });
    const note = { id: 'h-1', agentId: 'main-agent', kind: 'conversation', scopeId: 'conv-1', projectId: null, version: handoffVersion, source: handoffVersion > 1 ? 'owner' : 'agent', runId: null, createdAt: '2026-10-21 09:00:00', ...handoffBody };
    if (entry.method === 'GET' && path.startsWith('/api/handoffs?') || path === '/api/handoffs') return json(200, { handoffs: [note] });
    if (path.startsWith('/api/handoffs/conversation/conv-1')) {
      if (entry.method === 'GET') return new URL(url).searchParams.get('agentId') === 'main-agent' ? json(200, { handoff: note, history: [note] }) : json(404, { error: 'Not found', code: 'not_found' });
      if (entry.method === 'PUT') {
        handoffVersion++;
        handoffBody = { done: entry.body.done ?? [], left: entry.body.left ?? [], next: entry.body.next ?? [], questions: entry.body.questions ?? [] };
        return json(200, { handoff: { ...note, version: handoffVersion, source: 'owner', ...handoffBody } });
      }
    }
    return json(404, { error: 'Not found', code: 'not_found' });
  }
  return json(404, { error: 'not found' });
};
