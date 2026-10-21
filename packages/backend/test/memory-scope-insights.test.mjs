// Memory backend gaps from the memory boards (MEM-GAPS-02):
//  - "used in N replies" per memory (reply trace -> memory_recall_uses), and
//    the drawers a reply did not load and why;
//  - explorer filters: source, agent, importance, date, drawer-kind scope;
//  - memory -> linked graph entities; one memory's detail (usage, entities, readers);
//  - source_agent_id on memories an agent saved (routine and approved);
//  - agents with access to a scope (list + counts), role template detail;
//  - company / department access columns (pinned facts) with role-template caps;
//  - per-scope review rules (routine / important / contradiction, reviewer, weekly time);
//  - review grouping and accept-all-routine (preview -> confirm);
//  - doctor graph-orphan check; agent-view map;
//  - /api/handoffs projectId filter + coding-app handoffs; task runs use the
//    owner's access policies.
// Every new action also as an agent tool with the same owner gates.
// Throwaway DB/keys/HOME; a dead OLLAMA_URL and a stubbed fetch (no real model).
// Run: node --import tsx --test test/memory-scope-insights.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-mem-insights-'));
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
const OWNER = 'mi-owner';
const MEMBER = 'mi-user';
for (const [id, role] of [[OWNER, 'owner'], [MEMBER, 'user']]) {
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, 'active', 1)`).run(id, `${id}@example.test`, id, role);
}
for (const [id, name, primary] of [['ms-main', 'Main', 1], ['ms-writer', 'Writer', 0], ['ms-designer', 'Designer', 0]]) {
  db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES (?, ?, 'ollama', 'qwen-test', ?)`).run(id, name, primary);
}

const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const { chatRuns } = await import(join(backendDir, 'src/services/chat-runs.ts'));
const G = await import(join(backendDir, 'src/memory/graph/index.ts'));
const D = await import(join(backendDir, 'src/memory/drawers.ts'));
const T = await import(join(backendDir, 'src/tools/memory/index.ts'));
const { loadRunPermissions } = await import(join(backendDir, 'src/tools/agent-permissions.ts'));
const { approvalCategory } = await import(join(backendDir, 'src/tools/approvals.ts'));
const { DEFAULT_AGENT_TOOLS } = await import(join(backendDir, 'src/tools/grants.ts'));
const pages = await import(join(backendDir, '../core-ui/src/memory-pages-contract.js'));
const recallContract = await import(join(backendDir, '../core-ui/src/memory-recall-contract.js'));
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
const status = async (method, url, payload, user = OWNER) => (await call(user, method, url, payload)).statusCode;
const ended = (runId) => new Promise((r) => { const run = chatRuns.get(runId); if (run.status !== 'running') r(); else run.emitter.once('end', r); });
const remember = async (body) => {
  const r = await ok('POST', '/api/memory', { type: 'fact', importance: 6, ...body });
  await G.graphIdle();
  return r.memory;
};
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
/** Preview then apply access changes. */
const access = async (changes) => {
  const p = await ok('POST', '/api/memory/access/preview', { changes });
  return ok('POST', '/api/memory/access/apply', { changes, expectedPreviewHash: p.previewHash, confirm: true });
};
const moveProject = async (slug, departmentId) => {
  const p = await ok('POST', `/api/memory/scopes/projects/${slug}/preview`, { action: 'move', departmentId });
  await ok('POST', `/api/memory/scopes/projects/${slug}/apply`, { action: 'move', departmentId, expectedPreviewHash: p.previewHash, confirm: true });
};
const setPerms = (agent, read) => db.prepare(`INSERT INTO agent_permissions (agent_id, memory_read, memory_write, shared_memory, modes, version) VALUES (?, ?, ?, 0, '{}', 1)
  ON CONFLICT (agent_id) DO UPDATE SET memory_read = excluded.memory_read, memory_write = excluded.memory_write`).run(agent, JSON.stringify(read), JSON.stringify(read));

const folder = join(dir, 'work', 'alpha');
mkdirSync(folder, { recursive: true });
const project = (await ok('POST', '/api/chat/projects', { name: 'Alpha', folder }, 201)).project;
const conv = (await ok('POST', '/api/chat/conversations', { title: 'Alpha work', projectId: project.id }, 201)).conversation;
const PD = `project:${project.slug}`;
const mkt = (await ok('POST', '/api/memory/scopes/departments', { name: 'Marketing' }, 201)).department;
await moveProject(project.slug, mkt.id);
/** Every agent (the seeded main agent answers chat turns, plus the three above). */
const TOTAL = db.prepare('SELECT COUNT(*) AS n FROM agents_config').get().n;
const CHAT_AGENT = db.prepare("SELECT id FROM agents_config WHERE id = 'main-agent'").get()?.id ?? 'ms-main';
const ctxFor = (agentId, drawers = D.selectDrawers({ audience: 'owner', project: project.slug })) =>
  ({ workspaceDir: dir, userId: OWNER, agentId, sessionId: conv.id, memoryDrawers: drawers });
const shared = {};

test('1. used in N replies per memory; the drawers a reply did not load and why', async () => {
  const coffee = await remember({ content: 'The owner drinks coffee without sugar.', importance: 10 });
  shared.coffee = coffee;
  await remember({ content: 'Beta notes are kept short.', drawer: { kind: 'project', key: 'beta-notes' } });
  await remember({ content: 'Gamma was the old shop.', drawer: { kind: 'project', key: 'gamma-old' } });
  const pa = await ok('POST', '/api/memory/scopes/projects/gamma-old/preview', { action: 'archive' });
  await ok('POST', '/api/memory/scopes/projects/gamma-old/apply', { action: 'archive', expectedPreviewHash: pa.previewHash, confirm: true });
  setPerms(CHAT_AGENT, ['owner', 'project', 'task', 'people']); // the experience drawer is open but not readable
  let first, second;
  try {
    first = await turn(conv.id, 'How do I take my coffee?');
    second = await turn(conv.id, 'And again: how do I take my coffee?');
  } finally {
    db.prepare('DELETE FROM agent_permissions WHERE agent_id = ?').run(CHAT_AGENT);
  }
  for (const t of [first, second]) assert.ok(t.trace.items.some((i) => i.id === coffee.id), 'the memory is in both replies');
  const tr = second.trace;
  assert.ok(tr.context.drawers.loaded.includes('owner') && tr.context.drawers.loaded.includes(PD), JSON.stringify(tr.context.drawers));
  assert.deepEqual(tr.context.drawers.noAccess, ['experience']);
  const why = Object.fromEntries(tr.notLoaded.drawers.map((d) => [d.drawer, d.why]));
  assert.equal(why.experience, 'no_access');
  assert.equal(why['project:gamma-old'], 'archived');
  assert.equal(why['project:beta-notes'], 'not_open');
  assert.equal(why.owner, undefined, 'a loaded drawer is never "not loaded"');
  // The UI contract keeps it (idempotent: projected twice).
  const projected = recallContract.memoryRecallResponse(`/api/memory/recall/messages/${second.message.id}`, 200, { trace: tr });
  assert.deepEqual(recallContract.memoryRecallResponse(`/api/memory/recall/messages/${second.message.id}`, 200, projected), projected);
  assert.equal(projected.trace.notLoaded.drawers.find((d) => d.drawer === 'experience').why, 'no_access');
  assert.deepEqual(projected.trace.context.drawers.noAccess, ['experience']);

  // A trace stored before migration 121 is indexed on the first read.
  db.prepare(`INSERT INTO memory_recall_traces (run_id, user_id, session_id, agent_id, items, context, created_at, uses_indexed)
    VALUES ('old-run-1', ?, ?, ?, ?, '{}', '2026-10-01T09:00:00.000Z', 0)`).run(OWNER, conv.id, CHAT_AGENT, JSON.stringify([{ kind: 'memory', id: coffee.id, drawer: 'owner', why: 'pinned' }]));
  const page = await ok('GET', `/api/memory/scopes/memories?scope=owner&q=coffee`);
  assert.equal(page.items.find((i) => i.id === coffee.id).usedIn, 3);
  const detail = (await ok('GET', `/api/memory/scopes/memories/${coffee.id}`)).memory;
  assert.equal(detail.usage.usedIn, 3);
  assert.equal(detail.usage.recent.length, 3);
  assert.equal(detail.usage.recent.at(-1).runId, 'old-run-1', 'newest first');
  assert.equal(detail.usage.lastUsedAt, detail.usage.recent[0].at);
  assert.equal(db.prepare("SELECT uses_indexed FROM memory_recall_traces WHERE run_id = 'old-run-1'").get().uses_indexed, 1);
  // A trace keeps ids only; the memory row is never copied into the uses.
  assert.deepEqual(Object.keys(db.prepare('SELECT * FROM memory_recall_uses LIMIT 1').get()).sort(), ['agent_id', 'created_at', 'memory_id', 'run_id', 'user_id']);

  // The agent's own trace names only drawers open in its run; the rest is a count.
  const mine = await T.memoryRecallTool.execute({ op: 'trace', message_id: second.message.id }, { ...ctxFor(CHAT_AGENT, [{ kind: 'owner' }]) });
  assert.ok(mine.data?.success, mine.error);
  assert.ok(mine.data.trace.notLoaded.drawers.every((d) => d.drawer === 'owner'));
  assert.ok(mine.data.trace.notLoaded.more >= 3);
  assert.doesNotMatch(mine.content[0].text, /gamma-old|beta-notes/);
  assert.equal(await status('GET', `/api/memory/scopes/memories/${coffee.id}`, undefined, MEMBER), 403);
});

test('2. explorer filters (source, agent, importance, date, drawer kind) and the saving agent on a memory', async () => {
  const writer = ctxFor('ms-writer');
  const saved = await T.memorySaveTool.execute({ content: 'Writer drafts posts on Mondays', type: 'fact', importance: 3, drawer: PD }, writer);
  assert.ok(saved.data?.memoryId, saved.content[0].text);
  assert.equal(db.prepare('SELECT source_agent_id FROM memories WHERE id = ?').get(saved.data.memoryId).source_agent_id, 'ms-writer');
  const office = await remember({ content: 'The office opens at nine.', importance: 9 });
  assert.equal(db.prepare('SELECT source_agent_id FROM memories WHERE id = ?').get(office.id).source_agent_id, null, 'the owner saved it');
  db.prepare("UPDATE memories SET created_at = '2026-01-05T10:00:00.000Z' WHERE id = ?").run(office.id);

  const q = (params) => ok('GET', `/api/memory/scopes/memories${pages.queryString(params)}`);
  const ids = (p) => p.items.map((i) => i.id);
  const byAgent = await q({ scope: 'company', source: 'agent' });
  assert.ok(ids(byAgent).includes(saved.data.memoryId) && !ids(byAgent).includes(office.id));
  assert.ok((await q({ scope: 'company' })).facets.source.agent >= 1);
  assert.deepEqual(ids(await q({ scope: 'company', agent: 'ms-writer' })), [saved.data.memoryId]);
  assert.deepEqual(ids(await q({ scope: 'agent:ms-writer' })), [saved.data.memoryId]);
  const high = ids(await q({ scope: 'company', importance: '9-10' }));
  assert.ok(high.includes(office.id) && !high.includes(saved.data.memoryId));
  assert.ok(ids(await q({ scope: 'company', importance: '3' })).includes(saved.data.memoryId));
  assert.deepEqual(ids(await q({ scope: 'company', from: '2026-01-01', to: '2026-01-31' })), [office.id]);
  const projects = await q({ scope: 'kind:project' });
  assert.ok(projects.items.length >= 2 && projects.items.every((i) => i.drawerId.startsWith('project:')));
  const item = (await q({ scope: PD })).items.find((i) => i.id === saved.data.memoryId);
  assert.deepEqual([item.source, item.sourceAgentId, item.usedIn], ['agent', 'ms-writer', 0]);
  for (const bad of [{ source: 'bogus' }, { importance: '11' }, { importance: '0' }, { from: '2026-13-01' }, { scope: 'kind:nope' }, { agent: '../x' }]) {
    assert.equal(await status('GET', `/api/memory/scopes/memories${pages.queryString({ scope: 'company', ...bad })}`), 400, JSON.stringify(bad));
  }
  // The UI contract allows the new query keys and keeps the new fields (projected twice).
  const path = `/api/memory/scopes/memories${pages.queryString({ scope: 'kind:project', source: 'agent', agent: 'ms-writer', importance: '1-5', from: '2026-01-01', to: '2026-12-31' })}`;
  assert.ok(pages.memoryPagesPath(path), 'contract allows the filters');
  assert.equal(pages.memoryPagesPath('/api/memory/scopes/memories?scope=company&importance=12'), null);
  const body = await ok('GET', path);
  const once = pages.memoryPagesResponse(path, 200, body);
  assert.deepEqual(pages.memoryPagesResponse(path, 200, once), once);
  assert.equal(once.items[0].usedIn, 0);
  assert.equal(once.items[0].source, 'agent');
  assert.equal(once.facets.source.agent, 1);

  // An agent's important memory waits; once approved, the new memory names the agent that proposed it.
  const money = await T.memorySaveTool.execute({ content: 'The ad budget is 500 euros per month', type: 'fact', drawer: PD }, writer);
  assert.equal(money.data?.pendingApproval, true, money.content[0].text);
  const proposal = await ok('GET', `/api/memory/proposals/${money.data.proposalId}`);
  const approved = await ok('POST', `/api/memory/proposals/${proposal.id}/approve`, { expectedReviewHash: proposal.reviewHash });
  assert.equal(db.prepare('SELECT source_agent_id FROM memories WHERE id = ?').get(approved.applied.added[0]).source_agent_id, 'ms-writer');
  // Tool parity: memory_scopes memories takes the same filters (open drawers only).
  const viaTool = await T.memoryScopesTool.execute({ action: 'memories', scope: PD, agent_id: 'ms-writer', importance: '1-5' }, ctxFor('ms-main'));
  assert.ok(viaTool.data?.items?.some((i) => i.id === saved.data.memoryId), viaTool.error);
});

test('3. memory -> linked entities; one memory with usage, entities and readers (API + tools)', async () => {
  const m = await remember({ content: 'The Ledger Service replaces the Legacy Router.', drawer: { kind: 'project', key: project.slug } });
  shared.ledger = m;
  const g = await ok('GET', `/api/memory/graph/memories/${m.id}`);
  const names = g.entities.map((e) => e.name);
  assert.ok(names.includes('Ledger Service') && names.includes('Legacy Router'), JSON.stringify(names));
  assert.ok(g.links.some((l) => l.type === 'replaces' && l.from.name === 'Ledger Service' && l.to.name === 'Legacy Router'));
  assert.equal(await status('GET', `/api/memory/graph/memories/${m.id}?drawers=owner`), 404, 'outside the asked drawers');
  assert.equal(await status('GET', '/api/memory/graph/memories/nope-1'), 404);
  const memberMemory = (await call(MEMBER, 'POST', '/api/memory', { type: 'fact', content: 'Member note about Zeta Corp.' })).json().memory;
  assert.equal(await status('GET', `/api/memory/graph/memories/${memberMemory.id}`), 404, 'another user\'s memory');
  assert.equal(await status('GET', `/api/memory/scopes/memories/${memberMemory.id}`), 404);

  const detail = (await ok('GET', `/api/memory/scopes/memories/${m.id}`)).memory;
  assert.equal(detail.drawerId, PD);
  assert.equal(detail.content, 'The Ledger Service replaces the Legacy Router.');
  assert.ok(detail.graph.entities.some((e) => e.name === 'Ledger Service'));
  assert.deepEqual(detail.readers, { scope: PD, count: TOTAL, total: TOTAL, all: true, archived: false });

  const open = ctxFor('ms-main');
  const closed = ctxFor('ms-main', [{ kind: 'owner' }]);
  const viaGraph = await T.memoryGraphTool.execute({ op: 'memory', memory_id: m.id }, open);
  assert.ok(viaGraph.data?.entities?.some((e) => e.name === 'Legacy Router'), viaGraph.error);
  assert.ok((await T.memoryGraphTool.execute({ op: 'memory', memory_id: m.id }, closed)).error, 'drawer not open');
  const viaScopes = await T.memoryScopesTool.execute({ action: 'memory', memory_id: m.id }, open);
  assert.match(viaScopes.content[0].text, /Used in 0 replies; names .*Ledger Service.*read by all agents/);
  const hidden = await T.memoryScopesTool.execute({ action: 'memory', memory_id: m.id }, closed);
  assert.ok(hidden.error);
  assert.doesNotMatch(hidden.content[0].text, /Ledger/);
  assert.ok((await T.memoryScopesTool.execute({ action: 'memory', memory_id: m.id }, { ...open, userId: MEMBER })).error);
  assert.ok((await T.memoryGraphTool.execute({ op: 'memory', memory_id: m.id }, { ...open, toolPolicy: { channel: 'telegram', allowedTools: [] } })).error);
});

test('4. company / department access columns gate pinned facts; role templates cap them', async () => {
  await ok('POST', '/api/memory/scopes/pinned', { scope: 'company', text: 'We are Dpro.' }, 201);
  await ok('POST', '/api/memory/scopes/pinned', { scope: `department:${mkt.id}`, text: 'Marketing posts on Tuesdays.' }, 201);
  await ok('POST', '/api/memory/scopes/pinned', { scope: PD, text: 'Alpha uses teal.' }, 201);
  const perms = (agent) => loadRunPermissions(agent, [], { userId: OWNER, project: project.slug });
  assert.deepEqual((await perms('ms-main')).scopeRead, ['company', 'department']);

  // Nobody reads department facts (a scope column rule) -> the reply has company and project facts only.
  await access([{ op: 'set_rule', scope: 'company', drawerKind: 'department', read: 'deny', write: 'deny' }]);
  assert.deepEqual((await perms('ms-main')).scopeRead, ['company']);
  const sys = system((await turn(conv.id, 'What do we pin?')).body);
  assert.match(sys, /We are Dpro\./);
  assert.match(sys, /Alpha uses teal\./);
  assert.doesNotMatch(sys, /Tuesdays/);
  const eff = await ok('GET', `/api/memory/access/effective/ms-main?project=${project.slug}`);
  assert.equal(eff.kinds.department.read, false);
  assert.deepEqual(eff.effective.scopeRead, ['company']);
  assert.ok(eff.kinds.department.readWhy.some((w) => w.layer === 'company' && w.value === 'deny'));
  assert.deepEqual(eff.effective.memoryRead, ['owner', 'project', 'experience', 'task', 'people'], 'drawer kinds unchanged');
  const ov = await ok('GET', '/api/memory/access');
  assert.ok(ov.rules.some((r) => r.drawerKind === 'department' && r.scope === 'company'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_access_scope_rules WHERE drawer_kind = 'department'").get().n, 1, 'kept in its own table');
  // An agent exception lets one agent read them again.
  await access([{ op: 'set_rule', scope: PD, agentId: 'ms-writer', drawerKind: 'department', read: 'allow' }]);
  assert.deepEqual((await perms('ms-writer')).scopeRead, ['company', 'department']);
  await access([{ op: 'clear_rule', scope: 'company', drawerKind: 'department' }, { op: 'clear_rule', scope: PD, agentId: 'ms-writer', drawerKind: 'department' }]);
  assert.match(system((await turn(conv.id, 'And now?')).body), /Tuesdays/);

  // A role template with scope columns caps them; an older template (none named) does not.
  const tpl = await access([{ op: 'save_template', name: 'Designer', memoryRead: ['owner', 'project'], memoryWrite: ['project'], scopeRead: ['department'], scopeWrite: [] },
    { op: 'save_template', name: 'Helper', memoryRead: ['owner', 'project'], memoryWrite: [] },
    { op: 'assign_template', template: 'Designer', agentIds: ['ms-designer'] }, { op: 'assign_template', template: 'Helper', agentIds: ['ms-writer'] }]);
  assert.ok(tpl.version > 0);
  assert.deepEqual((await perms('ms-designer')).scopeRead, ['department']);
  assert.deepEqual((await perms('ms-writer')).scopeRead, ['company', 'department']);
  const templates = (await ok('GET', '/api/memory/access')).templates;
  const designer = templates.find((t) => t.name === 'Designer');
  assert.deepEqual([designer.scopeRead, designer.scopeWrite], [['department'], []]);
  assert.equal(templates.find((t) => t.name === 'Helper').scopeRead, null);
  // Editing a template without naming scope columns keeps them.
  await access([{ op: 'save_template', id: designer.id, name: 'Designer', memoryRead: ['owner', 'project', 'people'], memoryWrite: ['project'] }]);
  assert.deepEqual((await ok('GET', '/api/memory/access')).templates.find((t) => t.id === designer.id).scopeRead, ['department']);
  shared.designerTemplate = designer.id;
  // Template detail with its agents (item 8) — API and tool.
  const td = await ok('GET', `/api/memory/access/templates/${designer.id}`);
  assert.deepEqual([td.template.agents, td.agents.map((a) => a.id)], [1, ['ms-designer']]);
  assert.equal(await status('GET', '/api/memory/access/templates/tpl-missing'), 404);
  const tdTool = await T.memoryScopesTool.execute({ action: 'template', template_id: designer.id }, ctxFor('ms-main'));
  assert.match(tdTool.content[0].text, /Designer.*used by 1 agents/);
  // Writing company / department facts through the agent tool needs the run's write on that column.
  const noCompany = { ...ctxFor('ms-main'), permissions: { ...(await perms('ms-designer')) } };
  const refused = await T.memoryScopeApplyTool.execute({ action: 'pinned_add', scope: 'company', text: 'Agents may not add this.' }, noCompany);
  assert.match(refused.error ?? '', /company pinned facts/);
  const allowed = await T.memoryScopeApplyTool.execute({ action: 'pinned_add', scope: PD, text: 'Alpha ships on Fridays.' }, noCompany);
  assert.ok(allowed.data?.success, allowed.error);
  const pinnedId = db.prepare("SELECT id FROM memory_pinned_facts WHERE scope_kind = 'department' LIMIT 1").get().id;
  assert.ok((await T.memoryScopeApplyTool.execute({ action: 'pinned_remove', fact_id: pinnedId }, { ...noCompany, permissions: { ...noCompany.permissions, scopeWrite: [] } })).error);
  // The UI contract accepts the new columns and template fields (both boundaries' allow-list).
  assert.ok(pages.allowedMemoryPages('POST', '/api/memory/access/preview', { changes: [{ op: 'set_rule', scope: 'company', drawerKind: 'company', read: 'deny' }] }));
  assert.ok(pages.allowedMemoryPages('POST', '/api/memory/access/preview', { changes: [{ op: 'save_template', name: 'X', memoryRead: ['owner'], memoryWrite: [], scopeRead: ['company'], scopeWrite: ['company'] }] }));
  assert.ok(!pages.allowedMemoryPages('POST', '/api/memory/access/preview', { changes: [{ op: 'save_template', name: 'X', memoryRead: ['owner'], memoryWrite: [], scopeRead: ['department'], scopeWrite: ['company'] }] }));
  const effPath = `/api/memory/access/effective/ms-designer?project=${project.slug}`;
  const effOnce = pages.memoryPagesResponse(effPath, 200, await ok('GET', effPath));
  assert.deepEqual(pages.memoryPagesResponse(effPath, 200, effOnce), effOnce);
  assert.deepEqual(effOnce.effective.scopeRead, ['department']);
  assert.equal(effOnce.kinds.company.read, false);
  const accOnce = pages.memoryPagesResponse('/api/memory/access', 200, await ok('GET', '/api/memory/access'));
  assert.deepEqual(accOnce.templates.find((t) => t.id === designer.id).scopeRead, ['department']);
  await access([{ op: 'assign_template', template: null, agentIds: ['ms-designer', 'ms-writer'] }]);
});

test('5. agents with access to a scope: list, counts, readers of a memory (API + tool)', async () => {
  await access([
    { op: 'set_rule', scope: `department:${mkt.id}`, drawerKind: 'project', read: 'deny', write: 'deny' },
    { op: 'set_rule', scope: PD, agentId: 'ms-designer', drawerKind: 'project', read: 'allow', write: 'allow' },
  ]);
  const who = await ok('GET', `/api/memory/access/agents?scope=${PD}&column=project`);
  assert.deepEqual([who.count, who.total, who.agents.map((a) => a.id)], [1, TOTAL, ['ms-designer']]);
  assert.equal(who.agents[0].exception, true);
  assert.equal((await ok('GET', `/api/memory/access/agents?scope=department:${mkt.id}&column=project`)).count, 0);
  assert.equal((await ok('GET', '/api/memory/access/agents?scope=company&column=owner&mode=write')).count, TOTAL);
  const page1 = await ok('GET', `/api/memory/access/agents?scope=company&column=owner&limit=${TOTAL - 1}`);
  assert.equal(page1.agents.length, TOTAL - 1);
  assert.ok(page1.nextCursor);
  const page2 = await ok('GET', `/api/memory/access/agents?scope=company&column=owner&limit=${TOTAL - 1}&cursor=${page1.nextCursor}`);
  assert.deepEqual([page2.agents.length, page2.nextCursor], [1, null]);
  assert.ok(!page1.agents.some((a) => a.id === page2.agents[0].id), 'pages do not overlap');
  const counts = await ok('GET', '/api/memory/access/counts?column=project');
  assert.deepEqual([counts.company, counts.departments[mkt.id], counts.projects[project.slug], counts.total], [TOTAL, 0, 1, TOTAL]);
  assert.equal(counts.projects['beta-notes'], TOTAL, 'General keeps the default');
  assert.equal(counts.projects['gamma-old'], undefined, 'archived projects are not counted');
  const readers = (await ok('GET', `/api/memory/scopes/memories/${shared.ledger.id}`)).memory.readers;
  assert.deepEqual([readers.count, readers.total, readers.all], [1, TOTAL, false]);
  for (const bad of ['scope=company&column=nope', 'scope=company&mode=delete', 'scope=company&cursor=-1', 'scope=project:Bad']) {
    assert.equal(await status('GET', `/api/memory/access/agents?${bad}`), 400, bad);
  }
  assert.equal(await status('GET', '/api/memory/access/agents?scope=project:no-such-project'), 404);
  assert.equal(await status('GET', '/api/memory/access/agents?scope=company', undefined, MEMBER), 403);
  const viaTool = await T.memoryScopesTool.execute({ action: 'who', scope: PD, column: 'project' }, ctxFor('ms-main'));
  assert.match(viaTool.content[0].text, new RegExp(`^1 of ${TOTAL} agents may read project in project:alpha.*Designer`));
  const countsTool = await T.memoryScopesTool.execute({ action: 'access_counts', column: 'project' }, ctxFor('ms-main'));
  assert.equal(countsTool.data.projects[project.slug], 1);
  assert.ok((await T.memoryScopesTool.execute({ action: 'who', scope: PD }, { ...ctxFor('ms-main'), userId: MEMBER })).error);
});

test('6. review rules per scope: routine / important / contradiction, reviewer, weekly time', async () => {
  const company = await ok('GET', '/api/memory/scopes/rules?scope=company');
  assert.deepEqual([company.effective.routine, company.effective.important, company.effective.contradiction, company.effective.from.routine], ['save', 'ask', 'ask', 'default']);
  const writer = ctxFor('ms-writer');
  const save = (content, drawer = 'owner') => T.memorySaveTool.execute({ content, type: 'fact', importance: 4, drawer }, writer);

  await ok('PUT', '/api/memory/scopes/rules', { scope: 'company', routine: 'ask' });
  const asked = await save('The team lunch is on Fridays');
  assert.equal(asked.data?.pendingApproval, true, asked.content[0].text);
  assert.deepEqual(asked.data.reasons, ['scope-rule']);
  // The project overrides the company: routine facts are saved there.
  const rules = await ok('PUT', '/api/memory/scopes/rules', { scope: PD, routine: 'save' });
  assert.deepEqual([rules.effective.routine, rules.effective.from.routine], ['save', PD]);
  assert.ok((await save('Alpha builds run at night', PD)).data?.memoryId, 'saved in the project');
  await ok('PUT', '/api/memory/scopes/rules', { scope: PD, routine: null });
  assert.equal((await ok('GET', `/api/memory/scopes/rules?scope=${PD}`)).effective.from.routine, 'company', 'null = inherit');
  await ok('PUT', '/api/memory/scopes/rules', { scope: 'company', routine: null });

  // Important facts saved at once, except the ones that always ask.
  await ok('PUT', '/api/memory/scopes/rules', { scope: 'company', important: 'save' });
  const money = await save('The coffee machine costs 300 euros');
  assert.ok(money.data?.memoryId && !money.data.pendingApproval, money.content[0].text);
  const secret = await save('The router password is hunter2');
  assert.equal(secret.data?.pendingApproval, true, 'credentials always ask');
  await ok('PUT', '/api/memory/scopes/rules', { scope: 'company', important: null });

  // A standing answer to contradictions: keep both, decided through the normal decision path.
  await ok('PUT', '/api/memory/scopes/rules', { scope: 'company', contradiction: 'keep_both' });
  const on = await save('The build server is online');
  const off = await save('The build server is not online');
  assert.ok(on.data?.memoryId && off.data?.memoryId && !off.data.pendingApproval, off.content[0].text);
  assert.notEqual(on.data.memoryId, off.data.memoryId);
  const decided = db.prepare("SELECT decision, decided_by FROM memory_file_proposals WHERE conflict_with = ? ORDER BY created_at DESC LIMIT 1").get(on.data.memoryId);
  assert.deepEqual([decided.decision, decided.decided_by], ['keep_both', 'rule:company']);
  await ok('PUT', '/api/memory/scopes/rules', { scope: 'company', contradiction: 'keep_new' });
  const replaced = await save('The build server is offline now');
  assert.ok(!replaced.data?.pendingApproval, replaced.content[0].text);
  await ok('PUT', '/api/memory/scopes/rules', { scope: 'company', contradiction: null });

  // Department reviewer and the weekly summary time.
  const dept = await ok('PUT', '/api/memory/scopes/rules', { scope: `department:${mkt.id}`, reviewerAgentId: 'ms-writer' });
  assert.equal(dept.own.reviewerAgentId, 'ms-writer');
  assert.equal((await ok('GET', `/api/memory/scopes/rules?scope=${PD}`)).effective.reviewerAgentId, 'ms-writer');
  await ok('PUT', '/api/memory/scopes/rules', { scope: 'company', weeklyDay: 0, weeklyHour: 19 });
  assert.equal(db.prepare('SELECT cron_expression FROM cron_jobs WHERE name = ?').get(`memory-weekly-summary-${OWNER}`).cron_expression, '0 19 * * 0');
  assert.deepEqual((await ok('GET', '/api/memory/scopes/rules?scope=company')).effective.weekly, { day: 0, hour: 19 });
  for (const [body, code] of [
    [{ scope: PD, reviewerAgentId: 'ms-writer' }, 400], [{ scope: `department:${mkt.id}`, reviewerAgentId: 'nobody' }, 404],
    [{ scope: 'company', weeklyDay: 3 }, 400], [{ scope: PD, weeklyDay: 1, weeklyHour: 2 }, 400], [{ scope: 'company', routine: 'maybe' }, 400],
    [{ scope: 'company', other: 1 }, 400], [{ scope: 'company' }, 409], [{ scope: 'department:nope', routine: 'ask' }, 404],
  ]) assert.equal(await status('PUT', '/api/memory/scopes/rules', body), code, JSON.stringify(body));
  assert.equal(await status('PUT', '/api/memory/scopes/rules', { scope: 'company', routine: 'ask' }, MEMBER), 403);
  assert.equal((await ok('GET', '/api/memory/scopes/rules/all')).rules.length >= 2, true);

  // Tool parity (memory_scope_apply is approval-gated: the approval is the confirm).
  assert.equal(approvalCategory({ name: 'memory_scope_apply' }), 'settings');
  const viaTool = await T.memoryScopeApplyTool.execute({ action: 'rules_set', scope: 'company', important: 'save' }, ctxFor('ms-main'));
  assert.ok(viaTool.data?.success, viaTool.error);
  assert.match((await T.memoryScopesTool.execute({ action: 'rules', scope: PD }, ctxFor('ms-main'))).content[0].text, /important save.*reviewer ms-writer.*day 0 at 19:00/);
  await T.memoryScopeApplyTool.execute({ action: 'rules_set', scope: 'company', important: 'inherit' }, ctxFor('ms-main'));
  assert.equal((await ok('GET', '/api/memory/scopes/rules?scope=company')).own.important, null);
  assert.ok((await T.memoryScopeApplyTool.execute({ action: 'rules_set', scope: 'company', routine: 'ask' }, { ...ctxFor('ms-main'), userId: MEMBER })).error);
});

test('7. review inbox at scale: groups, accept all routine (preview -> confirm), department reviewer', async () => {
  await ok('PUT', '/api/memory/scopes/rules', { scope: 'company', routine: 'ask' });
  const writer = ctxFor('ms-writer');
  const routine = [];
  for (const content of ['Alpha posts use short hooks', 'Alpha posts end with a question']) {
    const r = await T.memorySaveTool.execute({ content, type: 'fact', importance: 4, drawer: PD }, writer);
    assert.equal(r.data?.pendingApproval, true, r.content[0].text);
    routine.push(r.data.proposalId);
  }
  const important = await T.memorySaveTool.execute({ content: 'Alpha pays 40 euros per post', type: 'fact', drawer: PD }, ctxFor('ms-designer'));
  assert.equal(important.data?.pendingApproval, true);

  const byScope = await ok('GET', '/api/memory/proposals/groups?by=scope');
  const g = byScope.groups.find((x) => x.key === PD);
  assert.ok(g.count >= 3 && g.routine >= 2 && g.proposalIds.includes(important.data.proposalId), JSON.stringify(g));
  const byDept = (await ok('GET', '/api/memory/proposals/groups?by=department')).groups.find((x) => x.key === `department:${mkt.id}`);
  assert.equal(byDept.reviewerAgentId, 'ms-writer');
  assert.ok((await ok('GET', '/api/memory/proposals/groups?by=agent')).groups.some((x) => x.key === 'agent:ms-writer' && x.routine >= 2));
  assert.equal(await status('GET', '/api/memory/proposals/groups?by=color'), 400);

  const filter = { scope: PD, agent: 'ms-writer' };
  const preview = await ok('POST', '/api/memory/proposals/accept-routine/preview', filter);
  assert.deepEqual(preview.items.map((i) => i.id).sort(), [...routine].sort(), 'routine only: the money one is not in it');
  assert.equal(await status('POST', '/api/memory/proposals/accept-routine', { ...filter, expectedPreviewHash: preview.previewHash }), 400, 'needs confirm');
  assert.equal(await status('POST', '/api/memory/proposals/accept-routine', { ...filter, expectedPreviewHash: 'f'.repeat(64), confirm: true }), 409);
  const late = await T.memorySaveTool.execute({ content: 'Alpha posts go out at noon', type: 'fact', importance: 4, drawer: PD }, writer);
  assert.equal(await status('POST', '/api/memory/proposals/accept-routine', { ...filter, expectedPreviewHash: preview.previewHash, confirm: true }), 409, 'list changed');
  const fresh = await ok('POST', '/api/memory/proposals/accept-routine/preview', filter);
  assert.equal(fresh.count, 3);
  const done = await ok('POST', '/api/memory/proposals/accept-routine', { ...filter, expectedPreviewHash: fresh.previewHash, confirm: true });
  assert.deepEqual([done.approved.length, done.skipped.length], [3, 0]);
  assert.equal(db.prepare("SELECT status FROM memory_file_proposals WHERE id = ?").get(late.data.proposalId).status, 'approved');
  assert.equal(db.prepare("SELECT status FROM memory_file_proposals WHERE id = ?").get(important.data.proposalId).status, 'pending');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE content = 'Alpha posts use short hooks' AND source_agent_id = 'ms-writer'").get().n, 1);
  assert.equal(await status('POST', '/api/memory/proposals/accept-routine/preview', filter, MEMBER), 403);
  assert.equal(await status('POST', '/api/memory/proposals/accept-routine/preview', { scope: '../x' }), 400);

  // Tools: groups / assigned / preview (read only), memory_review_routine (owner approval).
  assert.equal(approvalCategory({ name: 'memory_review_routine' }), 'other');
  assert.equal(approvalCategory({ name: 'memory_review' }), null);
  assert.ok(DEFAULT_AGENT_TOOLS.includes('memory_review_routine'));
  const groups = await T.memoryReviewTool.execute({ op: 'groups', by: 'department' }, ctxFor('ms-main'));
  assert.match(groups.content[0].text, new RegExp(`department:${mkt.id}: \\d+ waiting .*reviewer ms-writer`));
  const assigned = await T.memoryReviewTool.execute({ op: 'assigned' }, writer);
  assert.deepEqual(assigned.data.groups.map((x) => x.key), [`department:${mkt.id}`]);
  assert.deepEqual((await T.memoryReviewTool.execute({ op: 'assigned' }, ctxFor('ms-main'))).data.groups, []);
  await T.memorySaveTool.execute({ content: 'Alpha posts tag the brand', type: 'fact', importance: 4, drawer: PD }, writer);
  const tp = await T.memoryReviewTool.execute({ op: 'preview_routine', scope: PD }, ctxFor('ms-main'));
  assert.equal(tp.data.count, 1);
  assert.ok((await T.memoryReviewRoutineTool.execute({ scope: PD, preview_hash: tp.data.previewHash }, { ...ctxFor('ms-main'), userId: MEMBER })).error);
  assert.ok((await T.memoryReviewRoutineTool.execute({ scope: PD, preview_hash: tp.data.previewHash }, { ...ctxFor('ms-main'), toolPolicy: { channel: 'telegram', allowedTools: [] } })).error);
  const accepted = await T.memoryReviewRoutineTool.execute({ scope: PD, preview_hash: tp.data.previewHash }, ctxFor('ms-main'));
  assert.deepEqual([accepted.data?.approved?.length, accepted.error], [1, undefined]);
  await ok('PUT', '/api/memory/scopes/rules', { scope: 'company', routine: null });
});

test('8. doctor: graph orphans are reported and removed after a confirm', async () => {
  const m = await remember({ content: 'The Billing App depends on the Payment Gateway.' });
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM memory_graph_mentions WHERE memory_id = ?').get(m.id).n > 0);
  db.prepare('DELETE FROM memories WHERE id = ?').run(m.id); // a row gone without the graph cleanup
  const report = await ok('GET', '/api/memory/doctor');
  assert.ok(report.counts['graph-orphan'] > 0, JSON.stringify(report.counts));
  const issue = report.issues.find((i) => i.kind === 'graph-orphan');
  assert.ok(issue.memoryIds.includes(m.id));
  assert.match(issue.detail, /mentions \d+, link sources \d+, state \d+, links \d+, entities \d+/);
  const once = pages.memoryPagesResponse('/api/memory/doctor', 200, report);
  assert.deepEqual(pages.memoryPagesResponse('/api/memory/doctor', 200, once), once);
  assert.equal(once.counts['graph-orphan'], report.counts['graph-orphan']);
  assert.equal(await status('POST', '/api/memory/doctor/fix', { confirm: true, expectedReportHash: report.reportHash, kinds: ['graph-orphan'] }, MEMBER), 403);
  const fixed = await ok('POST', '/api/memory/doctor/fix', { confirm: true, expectedReportHash: report.reportHash, kinds: ['graph-orphan'] });
  assert.equal(fixed.fixed['graph-orphan'], report.counts['graph-orphan']);
  assert.equal(fixed.report.counts['graph-orphan'], 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_graph_mentions WHERE memory_id = ?').get(m.id).n, 0);
  assert.ok(pages.allowedMemoryPages('POST', '/api/memory/doctor/fix', { confirm: true, expectedReportHash: report.reportHash, kinds: ['graph-orphan'] }));
});

test('9. agent-view map: the graph limited to what one agent may read (API + tool)', async () => {
  // Rules from test 5: Marketing denies project drawers, the designer has an exception in Alpha.
  const designer = await ok('GET', `/api/memory/graph/agent-view/ms-designer?project=${project.slug}`);
  assert.ok(designer.drawers.includes(PD));
  assert.ok(designer.entities.some((e) => e.name === 'Ledger Service'));
  const writer = await ok('GET', `/api/memory/graph/agent-view/ms-writer?project=${project.slug}`);
  assert.ok(!writer.drawers.includes(PD) && writer.readable.includes('owner'));
  assert.ok(!writer.entities.some((e) => e.name === 'Ledger Service'));
  const noProject = await ok('GET', '/api/memory/graph/agent-view/ms-designer');
  assert.ok(!noProject.drawers.some((d) => d.startsWith('project:')));
  assert.equal(await status('GET', '/api/memory/graph/agent-view/nobody'), 404);
  assert.equal(await status('GET', '/api/memory/graph/agent-view/ms-designer?project=Bad'), 400);
  assert.equal(await status('GET', '/api/memory/graph/agent-view/ms-designer?project=no-such'), 404);
  assert.equal(await status('GET', '/api/memory/graph/agent-view/ms-designer', undefined, MEMBER), 403);
  // The tool never shows more than its own run's open drawers.
  const inRun = await T.memoryGraphTool.execute({ op: 'agent_view', agent_id: 'ms-designer', project: project.slug }, ctxFor('ms-main'));
  assert.ok(inRun.data.view.entities.some((e) => e.name === 'Ledger Service'), inRun.error);
  const ownerOnly = await T.memoryGraphTool.execute({ op: 'agent_view', agent_id: 'ms-designer', project: project.slug }, ctxFor('ms-main', [{ kind: 'owner' }]));
  assert.ok(!ownerOnly.data.view.entities.some((e) => e.name === 'Ledger Service'));
  assert.ok((await T.memoryGraphTool.execute({ op: 'agent_view', agent_id: 'ms-designer' }, { ...ctxFor('ms-main'), userId: MEMBER })).error);
});

test('10. handoffs: projectId filter and the coding-app notes (read only), API + tool', async () => {
  const H = await import(join(backendDir, 'src/memory/handoff/store.ts'));
  const B = await import(join(backendDir, 'src/memory/bridge/store.ts'));
  const loose = (await ok('POST', '/api/chat/conversations', { title: 'Loose' }, 201)).conversation;
  await H.saveHandoff({ ownerId: OWNER, agentId: 'ms-main', kind: 'conversation', scopeId: conv.id, projectId: project.id }, { done: ['Drafted posts'], left: [], next: ['Review'], questions: [] }, 'agent');
  await H.saveHandoff({ ownerId: OWNER, agentId: 'ms-main', kind: 'conversation', scopeId: loose.id, projectId: null }, { done: ['Other'], left: [], next: [], questions: [] }, 'agent');
  const inProject = (await ok('GET', `/api/handoffs?projectId=${project.id}`)).handoffs;
  assert.deepEqual(inProject.map((h) => h.scopeId), [conv.id]);
  assert.equal((await ok('GET', '/api/handoffs')).handoffs.length, 2);
  assert.equal(await status('GET', '/api/handoffs?projectId=..%2Fx'), 400);
  const memberProject = (await call(MEMBER, 'POST', '/api/chat/projects', { name: 'Theirs', folder: join(dir, 'work', 'theirs') })).json().project;
  if (memberProject) assert.equal(await status('GET', `/api/handoffs?projectId=${memberProject.id}`), 404, 'not the owner\'s project');
  assert.equal(await status('GET', '/api/handoffs?projectId=unknown-project'), 404);
  assert.ok(pages.memoryPagesPath(`/api/handoffs?projectId=${project.id}&limit=20`));

  await B.saveBridgeHandoff(OWNER, project.id, 'codex', { done: ['Refactored store'], left: ['Tests'], next: ['Run tests'], questions: [] });
  await B.saveBridgeHandoff(OWNER, project.id, 'claude-code', { done: ['Reviewed'], left: [], next: [], questions: ['Ship?'] });
  const apps = (await ok('GET', `/api/handoffs/coding-apps?projectId=${project.id}`)).handoffs;
  assert.deepEqual(apps.map((h) => h.client).sort(), ['claude-code', 'codex']);
  assert.deepEqual((await ok('GET', '/api/handoffs/coding-apps?client=codex')).handoffs.map((h) => h.done), [['Refactored store']]);
  assert.equal(await status('GET', '/api/handoffs/coding-apps?client=bogus'), 400);
  assert.equal(await status('GET', '/api/handoffs/coding-apps?projectId=unknown-project'), 404);
  assert.equal(await status('GET', '/api/handoffs/coding-apps', undefined, MEMBER), 403);
  assert.equal((await call(OWNER, 'PUT', '/api/handoffs/coding-apps', { done: ['x'] })).statusCode >= 400, true, 'read only');
  const viaTool = await T.memoryBridgeTool.execute({ action: 'handoffs', project_id: project.id }, ctxFor('ms-main'));
  assert.match(viaTool.content[0].text, /\[codex\].*done Refactored store \| left Tests \| next Run tests/);
  assert.ok((await T.memoryBridgeTool.execute({ action: 'handoffs' }, { ...ctxFor('ms-main'), userId: MEMBER })).error);
  assert.ok((await T.memoryBridgeTool.execute({ action: 'handoffs', client: 'bogus' }, ctxFor('ms-main'))).error);
});

test('11. task runs: the owner\'s inherited access narrows the run (not policies of a user named like the agent)', async () => {
  const { createAgentToolsRegistry } = await import(join(backendDir, 'src/tools/index.ts'));
  await access([{ op: 'set_rule', scope: 'company', drawerKind: 'experience', read: 'deny', write: 'deny' }]);
  const run = await createAgentToolsRegistry({ workspaceDir: dir, userId: 'ms-writer', agentId: 'ms-writer', accessOwnerId: OWNER, sessionId: 'cron-t1' });
  assert.ok(!run.getContext().permissions.memoryRead.includes('experience'), 'the owner\'s company rule applies');
  const before = await createAgentToolsRegistry({ workspaceDir: dir, userId: 'ms-writer', agentId: 'ms-writer', sessionId: 'cron-t2' });
  assert.ok(before.getContext().permissions.memoryRead.includes('experience'), 'without the owner nothing narrowed it (the old behaviour)');
  const src = readFileSync(join(backendDir, 'src/services/task-run-executor.ts'), 'utf8');
  assert.match(src, /accessOwnerId: accessOwner/, 'the executor passes the run owner');
  await access([{ op: 'clear_rule', scope: 'company', drawerKind: 'experience' }]);
});
