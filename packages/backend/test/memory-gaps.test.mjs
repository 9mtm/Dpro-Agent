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
//  - bridge: activity log filters and the "hide from Git" option (API + tools);
//  - owner-only "clear cache" with confirm.
// (The owner handoff tools of packages/mcp-server are tested there.)
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

test('4. agent tools: decide a conflict, review a pending link, read its own reply trace; owner gates and approvals', async () => {
  const D = await import(join(backendDir, 'src/memory/drawers.ts'));
  const T = await import(join(backendDir, 'src/tools/memory/index.ts'));
  const { approvalCategory } = await import(join(backendDir, 'src/tools/approvals.ts'));
  const { DEFAULT_AGENT_TOOLS } = await import(join(backendDir, 'src/tools/grants.ts'));
  const ctx = { workspaceDir: dir, userId: OWNER, agentId: 'mg-main', sessionId: conv.id, memoryDrawers: D.selectDrawers({ audience: 'owner', project: project.slug }) };
  const member = { ...ctx, userId: 'mg-user' };
  const outsider = { ...ctx, toolPolicy: { channel: 'telegram', allowedTools: [] } };
  for (const name of ['memory_review_decide', 'memory_graph_review']) assert.ok(approvalCategory({ name }), `${name} needs owner approval`);
  for (const name of ['memory_review', 'memory_recall']) assert.equal(approvalCategory({ name }), null);
  for (const name of ['memory_review', 'memory_review_decide', 'memory_graph_review', 'memory_recall']) assert.ok(DEFAULT_AGENT_TOOLS.includes(name));

  // Conflicts: list (read only) -> decide with the review hash.
  const a = await T.memorySaveTool.execute({ content: 'The staging server is online', type: 'fact', drawer: `project:${project.slug}` }, ctx);
  const b = await T.memorySaveTool.execute({ content: 'The staging server is not online', type: 'fact', drawer: `project:${project.slug}` }, ctx);
  assert.equal(b.data?.conflict, true, b.content?.[0]?.text);
  const list = await T.memoryReviewTool.execute({}, ctx);
  const c = list.data.conflicts.find((x) => x.id === b.data.proposalId);
  assert.ok(c, list.content[0].text);
  assert.equal(c.memoryId, a.data.memoryId);
  assert.match(c.oldText, /is online/);
  assert.match(c.newText, /not online/);
  for (const bad of [member, outsider]) {
    assert.ok((await T.memoryReviewTool.execute({}, bad)).error);
    assert.ok((await T.memoryReviewDecideTool.execute({ proposal_id: c.id, decision: 'keep_new', review_hash: c.reviewHash }, bad)).error);
  }
  // Not in the open drawers -> not listed, not decided.
  const elsewhere = { ...ctx, memoryDrawers: D.selectDrawers({ audience: 'owner' }) };
  assert.ok(!(await T.memoryReviewTool.execute({}, elsewhere)).data.conflicts.some((x) => x.id === c.id));
  assert.ok((await T.memoryReviewDecideTool.execute({ proposal_id: c.id, decision: 'keep_new', review_hash: c.reviewHash }, elsewhere)).error);
  assert.ok((await T.memoryReviewDecideTool.execute({ proposal_id: c.id, decision: 'keep_new', review_hash: 'wrong' }, ctx)).error, 'review hash binds the decision');
  assert.ok((await T.memoryReviewDecideTool.execute({ proposal_id: c.id, decision: 'maybe', review_hash: c.reviewHash }, ctx)).error);
  const decided = await T.memoryReviewDecideTool.execute({ proposal_id: c.id, decision: 'keep_new', review_hash: c.reviewHash }, ctx);
  assert.ok(decided.data?.success, decided.error);
  assert.equal(db.prepare('SELECT content FROM memories WHERE id = ?').get(a.data.memoryId).content, 'The staging server is not online');
  assert.equal(db.prepare('SELECT decision FROM memory_file_proposals WHERE id = ?').get(c.id).decision, 'keep_new');
  assert.ok((await T.memoryReviewDecideTool.execute({ proposal_id: c.id, decision: 'keep_old', review_hash: c.reviewHash }, ctx)).error, 'decided once');

  // Graph: an important link learned by an agent waits; listed by memory_graph op pending; reviewed with approval.
  const saved = await T.memorySaveTool.execute({ content: 'The Ledger Service replaces the Legacy Router.', type: 'fact', importance: 5, drawer: `project:${project.slug}` }, ctx);
  assert.ok(!saved.error, saved.error);
  await G.graphIdle();
  const pending = await T.memoryGraphTool.execute({ op: 'pending' }, ctx);
  const link = pending.data.links.find((l) => l.type === 'replaces');
  assert.ok(link, pending.content[0].text);
  assert.ok((await T.memoryGraphReviewTool.execute({ link_id: link.id, decision: 'approve' }, member)).error);
  assert.ok((await T.memoryGraphReviewTool.execute({ link_id: link.id, decision: 'approve' }, outsider)).error);
  assert.ok((await T.memoryGraphReviewTool.execute({ link_id: link.id, decision: 'approve' }, elsewhere)).error, 'link of a closed drawer');
  const approved = await T.memoryGraphReviewTool.execute({ link_id: link.id, decision: 'approve' }, ctx);
  assert.ok(approved.data?.success, approved.error);
  assert.equal(db.prepare('SELECT status FROM memory_graph_links WHERE id = ?').get(link.id).status, 'active');
  assert.ok((await T.memoryGraphReviewTool.execute({ link_id: link.id, decision: 'reject' }, ctx)).error, 'no longer pending');

  // Reply trace: its own newest reply in this conversation, by message id, never another agent's.
  const replyAgent = db.prepare('SELECT agent_id FROM memory_recall_traces WHERE session_id = ? LIMIT 1').get(conv.id).agent_id;
  Object.assign(ctx, { agentId: replyAgent });
  Object.assign(member, { agentId: replyAgent });
  Object.assign(outsider, { agentId: replyAgent });
  const latest = await T.memoryRecallTool.execute({ op: 'trace' }, ctx);
  assert.ok(latest.data?.success, latest.error);
  assert.ok(latest.data.trace.items.some((i) => i.kind === 'fact' && i.id === facts.company.id));
  assert.match(latest.content[0].text, /pinned fact \[company\]: We are Dpro\./);
  const msg = db.prepare("SELECT m.id FROM chat_messages m WHERE m.session_id = ? AND m.role = 'assistant' ORDER BY m.created_at ASC LIMIT 1").get(conv.id);
  assert.ok((await T.memoryRecallTool.execute({ op: 'trace', message_id: msg.id }, ctx)).data?.success);
  assert.ok((await T.memoryRecallTool.execute({ op: 'trace', message_id: msg.id }, { ...ctx, agentId: 'other-agent' })).error, 'not its reply');
  // A run with fewer drawers open sees the items but not their text.
  const narrow = await T.memoryRecallTool.execute({ op: 'trace', message_id: msg.id }, { ...ctx, memoryDrawers: [{ kind: 'experience' }] });
  assert.ok(narrow.data.trace.items.length > 0);
  assert.ok(narrow.data.trace.items.filter((i) => i.kind !== 'handoff').every((i) => i.preview === undefined && i.hidden === true));
  assert.doesNotMatch(narrow.content[0].text, /We are Dpro|PostgreSQL|short answers/);
  // Another project open: its own department's facts only, never this one's.
  const otherDept = (await ok('POST', '/api/memory/scopes/departments', { name: 'Sales' }, 201)).department;
  await remember({ content: 'Beta is the sales project.', drawer: { kind: 'project', key: 'beta-sales' } });
  const pb = await ok('POST', '/api/memory/scopes/projects/beta-sales/preview', { action: 'move', departmentId: otherDept.id });
  await ok('POST', '/api/memory/scopes/projects/beta-sales/apply', { action: 'move', departmentId: otherDept.id, expectedPreviewHash: pb.previewHash, confirm: true });
  const viaBeta = await T.memoryRecallTool.execute({ op: 'trace', message_id: msg.id }, { ...ctx, memoryDrawers: [{ kind: 'project', key: 'beta-sales' }] });
  const deptItem = viaBeta.data.trace.items.find((i) => i.kind === 'fact' && i.drawer === `department:${dept.id}`);
  assert.ok(deptItem && deptItem.hidden === true && deptItem.preview === undefined, JSON.stringify(deptItem));
  assert.ok((await T.memoryRecallTool.execute({ op: 'trace' }, member)).error);
  assert.ok((await T.memoryRecallTool.execute({ op: 'trace' }, outsider)).error);
  assert.ok((await T.memoryRecallTool.execute({ op: 'summaries' }, ctx)).data?.success);
  assert.ok((await T.memoryRecallTool.execute({ op: 'summaries' }, { ...ctx, sessionId: 'not-a-conversation' })).error);
  const m = await T.memoryRecallTool.execute({ op: 'metrics' }, ctx);
  assert.ok(m.data.recent.turns >= 3);
});

test('6. bridge: activity log and "hide managed files from Git" through the API and the agent tools', async () => {
  const D = await import(join(backendDir, 'src/memory/drawers.ts'));
  const T = await import(join(backendDir, 'src/tools/memory/index.ts'));
  const { approvalCategory } = await import(join(backendDir, 'src/tools/approvals.ts'));
  const ctx = { workspaceDir: dir, userId: OWNER, agentId: 'mg-main', sessionId: conv.id, memoryDrawers: D.selectDrawers({ audience: 'owner', project: project.slug }) };
  mkdirSync(join(folder, '.git', 'info'), { recursive: true });
  assert.equal(approvalCategory({ name: 'memory_bridge_apply' }), 'settings');
  assert.equal(approvalCategory({ name: 'memory_bridge' }), null);

  // Default: the files Dpro would create are listed in .git/info/exclude.
  const before = await T.memoryBridgeTool.execute({ action: 'preview_files', project_id: project.id }, ctx);
  assert.ok(before.data.files.some((f) => f.relative.endsWith('exclude')), before.content[0].text);
  const off = await T.memoryBridgeApplyTool.execute({ action: 'set_git_exclude', project_id: project.id, enabled: false }, ctx);
  assert.ok(off.data?.success, off.error);
  assert.equal(off.data.gitExclude, false);
  const after = await T.memoryBridgeTool.execute({ action: 'preview_files', project_id: project.id }, ctx);
  assert.ok(!after.data.files.some((f) => f.relative.endsWith('exclude')));
  assert.equal((await ok('GET', '/api/memory-bridge')).projects.find((p) => p.projectId === project.id).gitExclude, false);
  assert.ok((await T.memoryBridgeApplyTool.execute({ action: 'set_git_exclude', project_id: project.id, enabled: 'yes' }, ctx)).error);
  assert.ok((await T.memoryBridgeApplyTool.execute({ action: 'set_git_exclude', project_id: project.id, enabled: true }, { ...ctx, userId: 'mg-user' })).error);
  assert.ok((await T.memoryBridgeApplyTool.execute({ action: 'set_git_exclude', project_id: project.id, enabled: true }, { ...ctx, toolPolicy: { channel: 'telegram', allowedTools: [] } })).error);
  await ok('PATCH', `/api/memory-bridge/projects/${project.id}`, { gitExclude: true });

  // Activity log: the settings changes, filtered by project or CLI; owner only.
  const log = await T.memoryBridgeTool.execute({ action: 'activity', project_id: project.id }, ctx);
  assert.ok(log.data.entries.length >= 2, log.content[0].text);
  assert.ok(log.data.entries.every((e) => e.projectId === project.id));
  assert.match(log.content[0].text, /folder-settings project .*gitExclude.*false.*agent:mg-main/);
  await ok('PUT', '/api/memory-bridge/clients/codex', { enabled: false });
  const codexOnly = (await ok('GET', '/api/memory-bridge/audit?client=codex&limit=5')).entries;
  assert.ok(codexOnly.length >= 1 && codexOnly.every((e) => e.client === 'codex'));
  const byProject = (await ok('GET', `/api/memory-bridge/audit?projectId=${project.id}`)).entries;
  assert.ok(byProject.length >= 2 && byProject.every((e) => e.projectId === project.id));
  assert.equal((await call(OWNER, 'GET', '/api/memory-bridge/audit?client=nope')).statusCode, 400);
  assert.equal((await call(OWNER, 'GET', '/api/memory-bridge/audit?projectId=nope')).statusCode, 404);
  assert.equal((await call(OWNER, 'GET', '/api/memory-bridge/audit?limit=0')).statusCode, 400);
  assert.equal((await call('mg-user', 'GET', '/api/memory-bridge/audit')).statusCode, 403);
  assert.ok((await T.memoryBridgeTool.execute({ action: 'activity' }, { ...ctx, userId: 'mg-user' })).error);
});

test('7. graph clusters -> topic suggestions: preview changes nothing, apply after confirm, never renames, dismiss', async () => {
  const T = await import(join(backendDir, 'src/tools/memory/index.ts'));
  const { approvalCategory } = await import(join(backendDir, 'src/tools/approvals.ts'));
  const C = await import(join(backendDir, 'src/memory/graph/clusters.ts'));
  const orion = { kind: 'project', key: 'orion' };
  const m1 = await remember({ content: 'Lina Saleh works with Omar Haddad on Project Orion.', drawer: orion });
  const m2 = await remember({ content: 'Omar Haddad ships the beta in May.', drawer: orion });
  const keyed = await remember({ content: 'Lina Saleh leads the launch.', drawer: orion, topicKey: 'orion-lead' });
  const lunch = await remember({ content: 'Unrelated note about lunch for Project Orion.', drawer: orion });
  const list = (await ok('GET', '/api/memory/graph/clusters?drawers=project:orion')).clusters;
  const c = list.find((x) => x.memoryIds.includes(m1.id));
  assert.ok(c, JSON.stringify(list));
  assert.equal(c.drawer, 'project:orion');
  assert.ok(c.entities.length >= 2 && c.memoryIds.includes(m2.id) && c.memoryIds.includes(keyed.id));
  assert.ok(!c.entities.some((e) => e.name === 'Owner' || e.name === 'Project Orion'), 'hub entities left out');
  assert.ok(!c.memoryIds.includes(lunch.id), 'the drawer project does not join everything');
  assert.ok(c.suggestedTopicKey);
  assert.equal((await call('mg-user', 'GET', '/api/memory/graph/clusters')).statusCode, 403);

  // Preview: read only.
  const snapshot = () => JSON.stringify(db.prepare('SELECT id, topic_key, content FROM memories ORDER BY id').all());
  const before = snapshot();
  const { preview } = await ok('POST', `/api/memory/graph/clusters/${c.id}/topic-preview`, { topicKey: 'Orion Status' });
  assert.equal(preview.topicKey, 'orion-status');
  assert.equal(preview.blocked, null);
  assert.equal(preview.target.memoryId, m2.id, 'the newest memory without a key');
  assert.deepEqual(preview.keepKey, [{ memoryId: keyed.id, topicKey: 'orion-lead' }]);
  assert.equal(snapshot(), before, 'preview changes nothing');
  // Taken key in the drawer -> blocked; bad key / unknown cluster -> 400 / 404.
  await remember({ content: 'Orion budget is fixed.', drawer: orion, topicKey: 'orion-budget' });
  const taken = (await ok('POST', `/api/memory/graph/clusters/${c.id}/topic-preview`, { topicKey: 'orion-budget' })).preview;
  assert.equal(taken.blocked.code, 'key_taken');
  assert.equal((await call(OWNER, 'POST', `/api/memory/graph/clusters/${c.id}/topic`, { topicKey: 'orion-budget', expectedPreviewHash: taken.previewHash, confirm: true })).statusCode, 409);
  assert.equal((await call(OWNER, 'POST', `/api/memory/graph/clusters/${c.id}/topic-preview`, { topicKey: '---' })).statusCode, 400);
  assert.equal((await call(OWNER, 'POST', `/api/memory/graph/clusters/${'0'.repeat(32)}/topic-preview`, {})).statusCode, 404);
  // Apply: confirm + the preview's hash; a stale hash changes nothing.
  assert.equal((await call(OWNER, 'POST', `/api/memory/graph/clusters/${c.id}/topic`, { topicKey: 'orion-status', expectedPreviewHash: preview.previewHash })).statusCode, 400, 'confirm required');
  assert.equal((await call(OWNER, 'POST', `/api/memory/graph/clusters/${c.id}/topic`, { topicKey: 'orion-status', expectedPreviewHash: 'x'.repeat(64), confirm: true })).statusCode, 409);
  assert.equal((await call('mg-user', 'POST', `/api/memory/graph/clusters/${c.id}/topic`, { topicKey: 'orion-status', expectedPreviewHash: preview.previewHash, confirm: true })).statusCode, 403);
  const { result } = await ok('POST', `/api/memory/graph/clusters/${c.id}/topic`, { topicKey: 'orion-status', expectedPreviewHash: preview.previewHash, confirm: true });
  assert.equal(result.memoryId, preview.target.memoryId);
  assert.equal(db.prepare('SELECT topic_key FROM memories WHERE id = ?').get(result.memoryId).topic_key, 'orion-status');
  assert.equal(db.prepare('SELECT topic_key FROM memories WHERE id = ?').get(keyed.id).topic_key, 'orion-lead', 'never renamed');
  assert.ok(db.prepare("SELECT 1 FROM memory_versions WHERE memory_id = ? AND reason = 'topic-key:orion-status'").get(result.memoryId), 'versioned');
  assert.equal((await ok('POST', `/api/memory/graph/clusters/${c.id}/topic-preview`, { topicKey: 'orion-status' })).preview.blocked.code, 'already_topic');

  // Agent tools: read ops are free, apply / dismiss need the owner's approval; owner's own turns only.
  assert.ok(approvalCategory({ name: 'memory_graph_topic' }));
  const ctx = { workspaceDir: dir, userId: OWNER, agentId: 'mg-main', memoryDrawers: [orion] };
  const tl = await T.memoryGraphTool.execute({ op: 'clusters' }, ctx);
  assert.ok(tl.data.clusters.some((x) => x.id === c.id), tl.content[0].text);
  const tp = await T.memoryGraphTool.execute({ op: 'topic_preview', cluster_id: c.id, topic_key: 'orion-history' }, ctx);
  assert.ok(tp.data.preview, tp.error);
  assert.ok((await T.memoryGraphTool.execute({ op: 'clusters' }, { ...ctx, memoryDrawers: [{ kind: 'owner' }] })).data.clusters.every((x) => x.id !== c.id), 'closed drawer');
  assert.ok((await T.memoryGraphTopicTool.execute({ action: 'dismiss', cluster_id: c.id }, { ...ctx, userId: 'mg-user' })).error);
  assert.ok((await T.memoryGraphTopicTool.execute({ action: 'dismiss', cluster_id: c.id }, { ...ctx, toolPolicy: { channel: 'telegram', allowedTools: [] } })).error);
  const dismissed = await T.memoryGraphTopicTool.execute({ action: 'dismiss', cluster_id: c.id }, ctx);
  assert.ok(dismissed.data?.success, dismissed.error);
  assert.ok(!(await ok('GET', '/api/memory/graph/clusters?drawers=project:orion')).clusters.some((x) => x.id === c.id), 'not suggested again');

  // M14 "Rebuild map" for an agent: approval-gated, owner's own turns only, never for an outsider.
  assert.ok(approvalCategory({ name: 'memory_graph_sync' }));
  assert.ok((await T.memoryGraphSyncTool.execute({}, { ...ctx, userId: 'mg-user' })).error);
  assert.ok((await T.memoryGraphSyncTool.execute({}, { ...ctx, toolPolicy: { channel: 'telegram', allowedTools: [] } })).error);
  const synced = await T.memoryGraphSyncTool.execute({ limit: 50 }, ctx);
  assert.ok(synced.data?.success && Number.isInteger(synced.data.indexed), synced.error);

  // Scale: the map never gets more than 150 entities.
  const insEnt = db.prepare('INSERT INTO memory_graph_entities (id, user_id, kind, name, norm_name) VALUES (?, ?, ?, ?, ?)');
  const insMem = db.prepare(`INSERT INTO memories (id, user_id, type, content, created_at, drawer_kind, drawer_key, memory_layer, importance_score) VALUES (?, ?, 'fact', ?, ?, 'project', 'big', 'factual', 0.5)`);
  const insMention = db.prepare('INSERT INTO memory_graph_mentions (memory_id, entity_id, user_id) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  for (let i = 0; i < 120; i++) {
    insEnt.run(`e-a-${i}`, OWNER, 'topic', `Alpha ${i}`, `alpha ${i}`);
    insEnt.run(`e-b-${i}`, OWNER, 'topic', `Beta ${i}`, `beta ${i}`);
    for (const j of [0, 1]) {
      insMem.run(`big-${i}-${j}`, OWNER, `Alpha ${i} and Beta ${i}, note ${j}`, new Date().toISOString());
      insMention.run(`big-${i}-${j}`, `e-a-${i}`, OWNER);
      insMention.run(`big-${i}-${j}`, `e-b-${i}`, OWNER);
    }
  }
  db.exec('COMMIT');
  const big = await C.graphClusters({ userId: OWNER, drawers: [{ kind: 'project', key: 'big' }] }, { limit: 200 });
  assert.equal(big.reduce((n, x) => n + x.entities.length, 0), C.MAX_CLUSTER_NODES);
});

test('8. "Clear cache": owner only, needs confirm, drops only this owner\'s cached context; the next turn rebuilds it', async () => {
  const warm = await turn(conv.id, 'Status of Alpha?');
  const again = await turn(conv.id, 'Status of Alpha?');
  assert.equal(again.trace.context.fromCache.pack, true, warm.trace.context.fromCache.pack ? 'warm' : 'built then reused');
  assert.equal((await call('mg-user', 'POST', '/api/memory/cache/clear', { confirm: true })).statusCode, 403);
  assert.equal((await call(OWNER, 'POST', '/api/memory/cache/clear', {})).statusCode, 400);
  assert.equal((await call(OWNER, 'POST', '/api/memory/cache/clear', { confirm: 'yes' })).statusCode, 400);
  const before = db.prepare('SELECT COUNT(*) AS n FROM memories').get().n;
  const { cleared } = await ok('POST', '/api/memory/cache/clear', { confirm: true });
  assert.ok(cleared >= 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, before, 'no stored memory touched');
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'memory_cache.clear'").get());
  const fresh = await turn(conv.id, 'Status of Alpha?');
  assert.equal(fresh.trace.context.fromCache.pack, false);
  assert.match(system(fresh.body), /We are Dpro\./);
});
