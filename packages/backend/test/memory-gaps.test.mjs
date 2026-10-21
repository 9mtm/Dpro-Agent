// Memory backend gaps after the phase-2 merge (MEM-SCALE-01, MEM-BRIDGE-01,
// CORE-MEM-GRAPH, CORE-MEM-HANDOFF, MEM-CACHE-01):
//  - one source of pinned facts in a reply: the owner's scope facts are in the
//    cached context pack and in the reply trace (kind 'fact');
//  - the bridge's pinned_facts / project_brief read the per-scope pinned facts;
//  - board task runs get the pinned facts of their scope, same access checks;
//  - agent tools: decide a conflict, review a pending graph link, read the
//    recall trace of its own replies (approval-gated where they change memory);
//  - graph clusters -> topic suggestions (preview changes nothing, apply only
//    after confirm, never renames a key; dismiss);
//  - owner-only "clear cache" with confirm.
// Throwaway DB/keys/HOME; a dead OLLAMA_URL and a stubbed fetch (no real model).
// Run: node --import tsx --test test/memory-gaps.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-mem-gaps-'));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
const DEAD = 'http://127.0.0.1:9'; // nothing listens here; fetch is stubbed anyway
process.env.OLLAMA_URL = DEAD;
process.env.MEMORY_GRAPH_MODEL = 'off';
for (const k of ['AGENT_EXEC_TOOLS', 'OLLAMA_THINK', 'DEFAULT_MODEL', 'CHAT_NUM_CTX', 'CHAT_CONTEXT_TOKENS', 'CHAT_SUMMARY_TOKENS', 'OLLAMA_KEEP_ALIVE', 'CHAT_SUMMARY_MODEL', 'OUTSIDER_AGENT_MEMORY']) delete process.env[k];

const bodies = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u !== `${DEAD}/api/chat`) throw new Error(`unexpected network call in test: ${u}`);
  const body = JSON.parse(init.body);
  bodies.push(body);
  if (body.stream === false) return new Response(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }), { status: 200 });
  const enc = new TextEncoder();
  return new Response(new ReadableStream({ start(c) { for (const l of [{ message: { content: 'ok' } }, { done: true }]) c.enqueue(enc.encode(JSON.stringify(l) + '\n')); c.close(); } }), { status: 200 });
};
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const { getOrchestrator } = await import(join(backendDir, 'src/multi-agent/index.ts'));
await getOrchestrator().initialize(join(dir, '.data', 'multi-agent', 'orchestrator.db'));
const OWNER = 'mg-owner';
for (const [id, role] of [[OWNER, 'owner'], ['mg-user', 'user']]) {
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, 'active', 1)`).run(id, `${id}@example.test`, id, role);
}
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('mg-main', 'Main', 'ollama', 'qwen-test', 1)`).run();

const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const { chatRuns } = await import(join(backendDir, 'src/services/chat-runs.ts'));
const S = await import(join(backendDir, 'src/memory/scopes/index.ts'));
const G = await import(join(backendDir, 'src/memory/graph/index.ts'));
const contract = await import(join(backendDir, '../core-ui/src/memory-recall-contract.js'));
const app = await buildServer({ logger: false });
await app.ready();

test.after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const as = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const call = (user, method, url, payload) => app.inject({ method, url, headers: as(user), ...(payload ? { payload } : {}) });
const ok = async (method, url, payload, status = 200) => {
  const r = await call(OWNER, method, url, payload);
  assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`);
  return r.json();
};
const ended = (runId) => new Promise((r) => { const run = chatRuns.get(runId); if (run.status !== 'running') r(); else run.emitter.once('end', r); });
const remember = async (body) => {
  const r = await ok('POST', '/api/memory', { type: 'fact', importance: 6, ...body });
  await G.graphIdle();
  return r.memory;
};
/** One saved-conversation turn: the model request, the reply message and its trace. */
const turn = async (conversationId, message) => {
  const runId = `run-${randomBytes(6).toString('hex')}`;
  const r = await call(OWNER, 'POST', `/api/chat/conversations/${conversationId}/runs`, { runId, message });
  assert.equal(r.statusCode, 202, r.body);
  await ended(runId);
  const msg = db.prepare("SELECT id FROM chat_messages WHERE run_id = ? AND role = 'assistant'").get(runId);
  const tr = await ok('GET', `/api/memory/recall/messages/${msg.id}`);
  return { body: bodies.at(-1), message: msg, trace: tr.trace, runId };
};
const system = (body) => body.messages[0].content;

const folder = join(dir, 'work', 'alpha');
mkdirSync(folder, { recursive: true });
const project = (await ok('POST', '/api/chat/projects', { name: 'Alpha', folder }, 201)).project;
const conv = (await ok('POST', '/api/chat/conversations', { title: 'Alpha work', projectId: project.id }, 201)).conversation;
const dept = (await ok('POST', '/api/memory/scopes/departments', { name: 'Engineering' }, 201)).department;
const facts = {};

test('1. one source of pinned facts: scope facts are in the cached pack and in the reply trace', async () => {
  await ok('POST', `/api/memory/scopes/projects/${project.slug}/preview`, { action: 'move', departmentId: dept.id }).then((p) =>
    ok('POST', `/api/memory/scopes/projects/${project.slug}/apply`, { action: 'move', departmentId: dept.id, expectedPreviewHash: p.previewHash, confirm: true }));
  facts.company = (await ok('POST', '/api/memory/scopes/pinned', { scope: 'company', text: 'We are Dpro.' }, 201)).fact;
  facts.dept = (await ok('POST', '/api/memory/scopes/pinned', { scope: `department:${dept.id}`, text: 'Engineering ships on Fridays.' }, 201)).fact;
  facts.project = (await ok('POST', '/api/memory/scopes/pinned', { scope: `project:${project.slug}`, text: 'Alpha runs on PostgreSQL 16.' }, 201)).fact;
  const important = await remember({ content: 'The owner likes short answers.', importance: 10 });

  const first = await turn(conv.id, 'Which database does Alpha use?');
  const sys = system(first.body);
  assert.equal(sys.match(/Pinned facts/g)?.length, 1, 'one "Pinned facts" block in the reply');
  assert.match(sys, /## Pinned facts[\s\S]*Company:\n- We are Dpro\.[\s\S]*Department "Engineering":\n- Engineering ships on Fridays\.[\s\S]*Project "Alpha":\n- Alpha runs on PostgreSQL 16\./);
  assert.match(sys, /Important memories:\n- The owner likes short answers\./);
  const byId = (t, id) => t.items.find((i) => i.id === id);
  for (const [f, scope] of [[facts.company, 'company'], [facts.dept, `department:${dept.id}`], [facts.project, `project:${project.slug}`]]) {
    const item = byId(first.trace, f.id);
    assert.ok(item, `fact ${f.text} in the trace`);
    assert.deepEqual([item.kind, item.why, item.drawer, item.state], ['fact', 'pinned', scope, 'active']);
    assert.equal(item.preview, f.text);
  }
  assert.equal(byId(first.trace, important.id).why, 'pinned');
  // The UI contract keeps fact items (scope, preview) and drops nothing it should show.
  const projected = contract.memoryRecallResponse(`/api/memory/recall/messages/${first.message.id}`, 200, { trace: first.trace });
  assert.equal(projected.trace.items.filter((i) => i.kind === 'fact').length, 3);
  assert.equal(projected.trace.items.find((i) => i.id === facts.project.id).drawer, `project:${project.slug}`);

  // Same facts -> the pack comes from the cache; a fact edit -> a fresh pack and 'changed' in the old trace.
  const second = await turn(conv.id, 'And which day do we ship?');
  assert.equal(second.trace.context.fromCache.pack, true);
  await ok('PATCH', `/api/memory/scopes/pinned/${facts.project.id}`, { text: 'Alpha runs on PostgreSQL 17.' });
  const third = await turn(conv.id, 'Which database again?');
  assert.equal(third.trace.context.fromCache.pack, false);
  assert.match(system(third.body), /PostgreSQL 17/);
  assert.doesNotMatch(system(third.body), /PostgreSQL 16/);
  const old = (await ok('GET', `/api/memory/recall/messages/${first.message.id}`)).trace;
  assert.equal(byId(old, facts.project.id).state, 'changed');
  // A removed fact shows as deleted, without text.
  await ok('DELETE', `/api/memory/scopes/pinned/${facts.dept.id}`);
  const gone = byId((await ok('GET', `/api/memory/recall/messages/${first.message.id}`)).trace, facts.dept.id);
  assert.equal(gone.state, 'deleted');
  assert.equal(gone.preview, undefined);
  facts.dept = (await ok('POST', '/api/memory/scopes/pinned', { scope: `department:${dept.id}`, text: 'Engineering ships on Fridays.' }, 201)).fact;
});

test('3. board task runs get the pinned facts of their scope, with the same access checks', async () => {
  const { taskRunPinnedFacts } = await import(join(backendDir, 'src/memory/scopes/task-facts.ts'));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const finalCard = async (id) => {
    for (let i = 0; i < 500; i++) {
      const c = (await ok('GET', `/api/small-agent/runs/${id}`)).card;
      if (['completed', 'failed', 'cancelled', 'waiting_approval'].includes(c.status)) return c;
      await sleep(20);
    }
    throw new Error('run did not finish');
  };
  const runWith = async (drawers) => {
    const before = bodies.length;
    const res = await ok('POST', '/api/small-agent/runs', { task: 'Summarise the project status.', drawers }, 201);
    const card = await finalCard(res.run_id);
    assert.equal(card.status, 'completed', JSON.stringify(card));
    const calls = bodies.slice(before);
    assert.ok(calls.length >= 1);
    return calls[0].messages[0].content;
  };
  // A run in the project: company, department and project facts.
  const inProject = await runWith(['owner', `project:${project.slug}`]);
  assert.match(inProject, /## Pinned facts[\s\S]*We are Dpro\.[\s\S]*Engineering ships on Fridays\.[\s\S]*Alpha runs on PostgreSQL 17\./);
  // Only the project drawer open: no company facts (they follow the owner drawer).
  const projectOnly = await runWith([`project:${project.slug}`]);
  assert.doesNotMatch(projectOnly, /We are Dpro\./);
  assert.match(projectOnly, /Alpha runs on PostgreSQL 17\./);
  // No drawers at all: no facts.
  assert.doesNotMatch(await runWith([]), /Pinned facts/);

  // A board card made from the project's conversation gives the run its project.
  const board = db.prepare('SELECT id FROM boards LIMIT 1').get()?.id ?? 'b-mg';
  if (board === 'b-mg') {
    db.prepare("INSERT INTO boards (id, owner_id, name) VALUES ('b-mg', ?, 'Board')").run(OWNER);
    db.prepare("INSERT INTO board_columns (id, board_id, name, position) VALUES ('col-mg', 'b-mg', 'To do', 0)").run();
  }
  const col = db.prepare('SELECT id FROM board_columns WHERE board_id = ? LIMIT 1').get(board).id;
  db.prepare(`INSERT INTO board_cards (id, board_id, column_id, title, position, task_id, created_by, conversation_id) VALUES ('card-mg', ?, ?, 'Status', 0, 'task-mg', ?, ?)`).run(board, col, OWNER, conv.id);
  const base = { ownerId: OWNER, agentId: 'mg-main', taskId: 'task-mg' };
  const viaCard = await taskRunPinnedFacts({ ...base, drawers: [{ kind: 'owner' }] });
  assert.match(viaCard, /We are Dpro\.[\s\S]*Alpha runs on PostgreSQL 17\./);
  // A contract that narrowed the drawers to no project drawer: company facts only.
  const narrowed = await taskRunPinnedFacts({ ...base, drawers: [{ kind: 'owner' }], drawersNarrowed: true });
  assert.match(narrowed, /We are Dpro\./);
  assert.doesNotMatch(narrowed, /PostgreSQL/);
  // Another owner's task: nothing. The agent may not read project drawers: no project facts.
  assert.equal(await taskRunPinnedFacts({ ...base, ownerId: 'mg-user', drawers: [{ kind: 'owner' }] }), '');
  db.prepare(`INSERT INTO agent_permissions (agent_id, memory_read, memory_write, shared_memory, modes, version) VALUES ('mg-main', '["owner"]', '[]', 0, '{}', 1)
    ON CONFLICT (agent_id) DO UPDATE SET memory_read = excluded.memory_read`).run();
  const noProject = await taskRunPinnedFacts({ ...base, drawers: [{ kind: 'owner' }, { kind: 'project', key: project.slug }] });
  assert.match(noProject, /We are Dpro\./);
  assert.doesNotMatch(noProject, /PostgreSQL|Fridays/);
  db.prepare("DELETE FROM agent_permissions WHERE agent_id = 'mg-main'").run();
  // An archived project adds nothing; the company still applies.
  const pv = await ok('POST', `/api/memory/scopes/projects/${project.slug}/preview`, { action: 'archive' });
  await ok('POST', `/api/memory/scopes/projects/${project.slug}/apply`, { action: 'archive', expectedPreviewHash: pv.previewHash, confirm: true });
  const archived = await taskRunPinnedFacts({ ...base, drawers: [{ kind: 'owner' }] });
  assert.match(archived, /We are Dpro\./);
  assert.doesNotMatch(archived, /PostgreSQL/);
  const pu = await ok('POST', `/api/memory/scopes/projects/${project.slug}/preview`, { action: 'unarchive' });
  await ok('POST', `/api/memory/scopes/projects/${project.slug}/apply`, { action: 'unarchive', expectedPreviewHash: pu.previewHash, confirm: true });
});
