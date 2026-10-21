// MEM-BRIDGE-01: Dpro memory is the one brain for Claude Code, Codex, Gemini CLI and Antigravity.
//  - a fact approved in Dpro appears in the managed AGENTS.md brief and in the MCP read tools;
//  - owner text outside Dpro's markers stays byte for byte; no secret reaches any written file;
//  - the MCP write tools only create review proposals / handoff notes; a note from Codex reaches Claude Code;
//  - nothing for a folder Dpro does not know; kill switch per CLI; loopback + install proof + token;
//  - registration preview -> confirm -> undo restores the CLI config byte for byte (temp HOME only);
//  - back-flow: what a CLI writes in its own memory files comes back as review proposals, once.
// Throwaway HOME, DB and keys; no model is reached (dead OLLAMA_URL, MEMORY_GRAPH_MODEL=off).
// Run: node --import tsx --test test/memory-bridge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-bridge-')));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.MEMORY_GRAPH_MODEL = 'off';
for (const k of ['CODEX_HOME', 'AGENT_PLAYER_DATA_DIR', 'AGENT_EXEC_TOOLS', 'DEFAULT_MODEL']) delete process.env[k];

globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const { getOrchestrator } = await import(join(backendDir, 'src/multi-agent/index.ts'));
await getOrchestrator().initialize(join(dir, '.data', 'multi-agent', 'orchestrator.db'));
for (const [id, role] of [['br-owner', 'owner'], ['br-user', 'user']]) {
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, 'active', 1)`).run(id, `${id}@example.test`, id, role);
}
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('br-main', 'Main', 'ollama', 'qwen-test', 1)`).run();

const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const { createProject } = await import(join(backendDir, 'src/repositories/chat-conversations.ts'));
const { learn } = await import(join(backendDir, 'src/memory/learning.ts'));
const { publishInstanceIdentity, getInstanceIdentity } = await import(join(backendDir, 'src/services/instance-identity.ts'));
const { createBridgeMcpServer, httpBackend } = await import(join(backendDir, 'src/memory/bridge/mcp-server.ts'));
const { sessionProof } = await import(join(backendDir, 'src/memory/bridge/proof.ts'));
const { setBridgeEnv } = await import(join(backendDir, 'src/memory/bridge/service.ts'));
const { syncMemoryBridge } = await import(join(backendDir, 'src/memory/bridge/sync.ts'));
const { MARK_START, MARK_END } = await import(join(backendDir, 'src/memory/bridge/managed-files.ts'));
const { claudeProjectDir } = await import(join(backendDir, 'src/memory/bridge/clients.ts'));
const { memoryBridgeTool, memoryBridgeApplyTool } = await import(join(backendDir, 'src/tools/memory/bridge.ts'));
const { APPROVAL_REQUIRED_TOOLS } = await import(join(backendDir, 'src/tools/approvals.ts'));
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

setBridgeEnv({ home: dir, env: {} });
publishInstanceIdentity();
const app = await buildServer({ logger: false });
await app.ready();

const as = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const call = (user, method, url, payload) => app.inject({ method, url, headers: as(user), ...(payload ? { payload } : {}) });
const OWNER = 'br-owner';
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

/** fetch for the MCP server: the request goes to the in-process backend over app.inject (loopback). */
const injectFetch = async (url, init = {}) => {
  const u = new URL(String(url));
  assert.equal(u.hostname, '127.0.0.1');
  const r = await app.inject({ method: init.method ?? 'GET', url: u.pathname + u.search, headers: init.headers, payload: init.body });
  return new Response(r.body, { status: r.statusCode, headers: { 'Content-Type': 'application/json' } });
};
/** An MCP client connected to the dpro-memory server as `client`, running in `cwd`. */
async function mcp(client, cwd) {
  const server = createBridgeMcpServer(httpBackend({ client, cwd, backendUrl: 'http://127.0.0.1:41522', configDir: process.env.AGENT_PLAYER_CONFIG_DIR, fetchImpl: injectFetch }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: `test-${client}`, version: '1' });
  await c.connect(b);
  return {
    async tool(name, args = {}) { const r = await c.callTool({ name, arguments: args }); return { text: r.content?.[0]?.text ?? '', isError: !!r.isError }; },
    close: () => c.close(),
  };
}

async function approveAll() {
  const list = (await call(OWNER, 'GET', '/api/memory/proposals?status=pending')).json();
  const proposals = list.proposals ?? list.items ?? list;
  for (const p of proposals) {
    const full = (await call(OWNER, 'GET', `/api/memory/proposals/${p.id}`)).json();
    const reviewHash = full.reviewHash ?? full.proposal?.reviewHash;
    const r = await call(OWNER, 'POST', `/api/memory/proposals/${p.id}/approve`, { expectedReviewHash: reviewHash });
    assert.equal(r.statusCode, 200, r.body);
  }
  return proposals.length;
}
const pending = async () => { const l = (await call(OWNER, 'GET', '/api/memory/proposals?status=pending')).json(); return l.proposals ?? l.items ?? l; };

// Project folder with the owner's own files (and a git folder for the exclude list).
const folder = join(dir, 'Projects', 'alpha');
mkdirSync(join(folder, '.git', 'info'), { recursive: true });
mkdirSync(join(folder, 'src'), { recursive: true });
const OWNER_AGENTS = '# Alpha\n\nOwner rule: tabs, not spaces.\n';
const OWNER_CLAUDE = 'My own Claude notes.\nKeep this line.';
writeFileSync(join(folder, 'AGENTS.md'), OWNER_AGENTS);
writeFileSync(join(folder, 'CLAUDE.md'), OWNER_CLAUDE);
const project = await createProject(OWNER, { name: 'Alpha', folder });
const other = join(dir, 'Projects', 'unknown');
mkdirSync(other, { recursive: true });

test('owner API: only the owner; status lists the CLIs (all off) and the project folder', async () => {
  assert.equal((await call('br-user', 'GET', '/api/memory-bridge')).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/memory-bridge' })).statusCode, 401);
  const s = (await call(OWNER, 'GET', '/api/memory-bridge')).json();
  assert.deepEqual(s.clients.map((c) => [c.client, c.enabled]), [['claude-code', false], ['codex', false], ['gemini-cli', false], ['antigravity', false]]);
  assert.equal(s.projects[0].projectId, project.id);
  assert.equal(s.projects[0].filesEnabled, false);
});

test('a fact approved in Dpro appears in the managed brief; owner text outside the markers is untouched', async () => {
  await learn({ userId: OWNER, actor: `owner:${OWNER}`, review: true, candidates: [{ content: 'Alpha deploys with the release script in scripts/release.sh', type: 'fact', drawer: { kind: 'project', key: project.slug }, origin: 'owner' }] });
  assert.equal(await approveAll(), 1);
  const pv = await call(OWNER, 'GET', `/api/memory-bridge/projects/${project.id}/files`);
  assert.equal(pv.statusCode, 200, pv.body);
  const preview = pv.json().preview;
  const byName = Object.fromEntries(preview.files.map((f) => [f.relative, f]));
  assert.equal(byName['AGENTS.md'].action, 'update');
  assert.equal(byName['CLAUDE.md'].action, 'update');
  assert.equal(byName['GEMINI.md'].action, 'create');
  assert.ok(byName[join('.git', 'info', 'exclude')], 'created files are listed for git exclude');
  assert.match(byName['AGENTS.md'].diff, /\+- Alpha deploys with the release script/);
  // Dry run: nothing written yet.
  assert.equal(readFileSync(join(folder, 'AGENTS.md'), 'utf8'), OWNER_AGENTS);
  assert.equal(existsSync(join(folder, 'GEMINI.md')), false);

  assert.equal((await call(OWNER, 'POST', `/api/memory-bridge/projects/${project.id}/files`, { previewHash: preview.previewHash })).statusCode, 400, 'confirm required');
  assert.equal((await call(OWNER, 'POST', `/api/memory-bridge/projects/${project.id}/files`, { previewHash: 'x'.repeat(64), confirm: true })).statusCode, 409, 'stale hash refused');
  const ap = await call(OWNER, 'POST', `/api/memory-bridge/projects/${project.id}/files`, { previewHash: preview.previewHash, confirm: true });
  assert.equal(ap.statusCode, 200, ap.body);

  const agents = readFileSync(join(folder, 'AGENTS.md'), 'utf8');
  assert.ok(agents.startsWith(OWNER_AGENTS), 'owner text kept byte for byte');
  assert.match(agents, /Alpha deploys with the release script/);
  assert.ok(agents.includes(MARK_START) && agents.includes(MARK_END));
  const claude = readFileSync(join(folder, 'CLAUDE.md'), 'utf8');
  assert.ok(claude.startsWith(OWNER_CLAUDE), 'owner CLAUDE.md text kept');
  assert.match(claude, /@AGENTS\.md/);
  assert.match(readFileSync(join(folder, 'GEMINI.md'), 'utf8'), /@\.\/AGENTS\.md/);
  assert.match(readFileSync(join(folder, '.git', 'info', 'exclude'), 'utf8'), /\/GEMINI\.md/);
});

test('the owner edits outside the markers, a new fact (with a secret) is approved: sync rewrites only the section, never the secret', async () => {
  const path = join(folder, 'AGENTS.md');
  const edited = readFileSync(path, 'utf8') + '\nOwner later note.\n';
  writeFileSync(path, edited);
  await learn({ userId: OWNER, actor: `owner:${OWNER}`, review: true, candidates: [{ content: `Alpha CI token is ${SECRET} and runs on push`, type: 'fact', drawer: { kind: 'project', key: project.slug }, origin: 'owner' }] });
  await approveAll();
  const r = await syncMemoryBridge();
  assert.ok(r.written >= 1, JSON.stringify(r));
  const after = readFileSync(path, 'utf8');
  assert.ok(after.startsWith(OWNER_AGENTS), 'text before the section unchanged');
  assert.ok(after.endsWith('\nOwner later note.\n'), 'text after the section unchanged');
  assert.match(after, /runs on push/);
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) assert.ok(!readFileSync(join(folder, f), 'utf8').includes(SECRET), `no secret in ${f}`);
  assert.match(after, /\[REDACTED:/);
  // Nothing changed -> nothing written again.
  assert.equal((await syncMemoryBridge()).written, 0);
});

test('MCP: switched off -> refused; on -> read tools serve the project of the folder the CLI runs in', async () => {
  const claude = await mcp('claude-code', join(folder, 'src'));
  const off = await claude.tool('project_brief');
  assert.ok(off.isError);
  assert.match(off.text, /switched off/);
  assert.equal((await call(OWNER, 'PUT', '/api/memory-bridge/clients/claude-code', { enabled: true })).statusCode, 200);
  const brief = await claude.tool('project_brief');
  assert.equal(brief.isError, false, brief.text);
  assert.match(brief.text, /Alpha deploys with the release script/);
  assert.ok(!brief.text.includes(SECRET));
  // pinned_facts = the owner's scope facts (MEM-SCALE-01), not the drawer's memories.
  assert.match((await claude.tool('pinned_facts')).text, /not pinned facts for this project yet/);
  assert.equal((await call(OWNER, 'POST', '/api/memory/scopes/pinned', { scope: 'company', text: 'We review every change.' })).statusCode, 201);
  assert.equal((await call(OWNER, 'POST', '/api/memory/scopes/pinned', { scope: `project:${project.slug}`, text: `Alpha ships weekly. ${SECRET}` })).statusCode, 201);
  const pinned = (await claude.tool('pinned_facts')).text;
  assert.match(pinned, /We review every change\.[\s\S]*Alpha ships weekly\./);
  assert.ok(!pinned.includes('release script') && !pinned.includes(SECRET));
  assert.match((await claude.tool('project_brief')).text, /### Pinned facts\n- We review every change\.\n- Alpha ships weekly\.[\s\S]*### Approved project memory\n[\s\S]*release script/);
  assert.match((await claude.tool('memory_search', { query: 'release script' })).text, /release script/);
  await claude.close();

  const elsewhere = await mcp('claude-code', other);
  const r = await elsewhere.tool('project_brief');
  assert.ok(r.isError);
  assert.match(r.text, /does not know this folder/);
  await elsewhere.close();
});

test('MCP write tools: a proposal lands in review (not in memory); a Codex handoff reaches Claude Code', async () => {
  await call(OWNER, 'PUT', '/api/memory-bridge/clients/codex', { enabled: true });
  const codex = await mcp('codex', folder);
  const before = (await pending()).length;
  const p = await codex.tool('memory_propose', { content: 'Alpha uses PostgreSQL 17 in production' });
  assert.equal(p.isError, false, p.text);
  assert.match(p.text, /owner reviews it/);
  const list = await pending();
  assert.equal(list.length, before + 1);
  assert.ok(!(await codex.tool('project_brief')).text.includes('PostgreSQL 17'), 'not memory before approval');
  const h = await codex.tool('handoff_write', { done: ['Migrated the users table'], next: [`Run the backfill with ${SECRET}`] });
  assert.equal(h.isError, false, h.text);
  await codex.close();

  const claude = await mcp('claude-code', folder);
  const latest = await claude.tool('latest_handoff');
  assert.match(latest.text, /from Codex/);
  assert.match(latest.text, /Migrated the users table/);
  assert.ok(!latest.text.includes(SECRET), 'handoff secret redacted');
  await claude.close();

  await approveAll();
  const again = await mcp('codex', folder);
  assert.match((await again.tool('project_brief')).text, /PostgreSQL 17/);
  await again.close();
});

test('MCP auth: loopback only, install proof once per nonce, token required, kill switch revokes at once', async () => {
  const ident = getInstanceIdentity();
  const nonce = randomBytes(24).toString('hex');
  const body = { client: 'gemini-cli', nonce, proof: sessionProof(ident.secret, ident.id, 'gemini-cli', nonce) };
  const far = await app.inject({ method: 'POST', url: '/api/memory-bridge/mcp/session', payload: body, remoteAddress: '10.1.2.3' });
  assert.equal(far.statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/memory-bridge/mcp/session', payload: body })).statusCode, 403, 'gemini-cli is off');
  await call(OWNER, 'PUT', '/api/memory-bridge/clients/gemini-cli', { enabled: true });
  const n2 = randomBytes(24).toString('hex');
  const ok = await app.inject({ method: 'POST', url: '/api/memory-bridge/mcp/session', payload: { client: 'gemini-cli', nonce: n2, proof: sessionProof(ident.secret, ident.id, 'gemini-cli', n2) } });
  assert.equal(ok.statusCode, 200, ok.body);
  const token = ok.json().token;
  assert.equal((await app.inject({ method: 'POST', url: '/api/memory-bridge/mcp/session', payload: { client: 'gemini-cli', nonce: n2, proof: sessionProof(ident.secret, ident.id, 'gemini-cli', n2) } })).statusCode, 401, 'nonce works once');
  assert.equal((await app.inject({ method: 'POST', url: '/api/memory-bridge/mcp/session', payload: { client: 'gemini-cli', nonce: randomBytes(24).toString('hex'), proof: 'ab'.repeat(32) } })).statusCode, 401);
  const callWith = (t) => app.inject({ method: 'POST', url: '/api/memory-bridge/mcp/call', headers: { 'x-dpro-bridge-token': t }, payload: { client: 'gemini-cli', cwd: folder, tool: 'pinned_facts' } });
  assert.equal((await callWith(token)).statusCode, 200);
  assert.equal((await callWith('0'.repeat(64))).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/memory-bridge/mcp/call', headers: { 'x-dpro-bridge-token': token }, payload: { client: 'codex', cwd: folder, tool: 'pinned_facts' } })).statusCode, 401, 'token is per CLI');
  await call(OWNER, 'PUT', '/api/memory-bridge/clients/gemini-cli', { enabled: false });
  assert.equal((await callWith(token)).statusCode, 401, 'kill switch deleted the token');
});

test('registration: preview -> confirm -> undo restores each CLI config byte for byte; no secret in any config', async () => {
  const claudeJson = join(dir, '.claude.json');
  const codexToml = join(dir, '.codex', 'config.toml');
  const gemini = join(dir, '.gemini', 'settings.json');
  mkdirSync(join(dir, '.codex'), { recursive: true });
  mkdirSync(join(dir, '.gemini'), { recursive: true });
  const originals = {
    'claude-code': [claudeJson, '{\n  "numStartups": 3,\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n'],
    codex: [codexToml, 'model = "gpt-6"\n\n[mcp_servers.other]\ncommand = "x"\n'],
    'gemini-cli': [gemini, '{\n    "theme": "dark"\n}'],
  };
  for (const [, [file, text]] of Object.entries(originals)) writeFileSync(file, text, { mode: 0o600 });
  const tokens = [];

  for (const client of ['claude-code', 'codex', 'gemini-cli', 'antigravity']) {
    const pv = await call(OWNER, 'GET', `/api/memory-bridge/clients/${client}/registration`);
    assert.equal(pv.statusCode, 200, pv.body);
    const preview = pv.json().preview;
    assert.equal(preview.action, client === 'antigravity' ? 'create' : 'update', client);
    assert.equal(preview.after, undefined, 'the full config text never leaves the server');
    assert.match(preview.diff, /mcp-stdio/);
    assert.equal((await call(OWNER, 'POST', `/api/memory-bridge/clients/${client}/registration`, { previewHash: preview.previewHash })).statusCode, 400, 'confirm required');
    const ap = await call(OWNER, 'POST', `/api/memory-bridge/clients/${client}/registration`, { previewHash: preview.previewHash, confirm: true });
    assert.equal(ap.statusCode, 200, ap.body);
    const reg = ap.json().registration;
    const text = readFileSync(reg.configPath, 'utf8');
    assert.match(text, /dpro-memory/);
    if (client === 'codex') assert.match(text, /\[mcp_servers\.dpro-memory\]/);
    else assert.ok(JSON.parse(text).mcpServers['dpro-memory'].command);
    if (client === 'claude-code') assert.equal(JSON.parse(text).mcpServers.other.command, 'x', 'other servers kept');
    assert.ok(!/[0-9a-f]{64}/.test(text), 'no token in the config');
    assert.ok(!text.includes(process.env.ENCRYPTION_KEY) && !text.includes(process.env.JWT_SECRET));
    assert.equal(statSync(reg.configPath).mode & 0o777, 0o600);
    tokens.push(reg);
  }
  const s = (await call(OWNER, 'GET', '/api/memory-bridge')).json();
  assert.ok(s.clients.every((c) => c.enabled && c.registrationId), 'registration switches the CLI on');

  for (const reg of tokens) {
    const u = await call(OWNER, 'POST', `/api/memory-bridge/registrations/${reg.id}/undo`);
    assert.equal(u.statusCode, 200, u.body);
    assert.equal(u.json().mode, 'restored');
    if (reg.client === 'antigravity') assert.equal(existsSync(reg.configPath), false, 'a file Dpro created is removed again');
    else assert.equal(readFileSync(reg.configPath, 'utf8'), originals[reg.client][1], `${reg.client} restored byte for byte`);
  }
  assert.equal((await call(OWNER, 'POST', `/api/memory-bridge/registrations/${tokens[0].id}/undo`)).statusCode, 409);
});

test('undo after the CLI changed its config removes only Dpro\'s entry', async () => {
  const file = join(dir, '.codex', 'config.toml');
  const original = readFileSync(file, 'utf8');
  const preview = (await call(OWNER, 'GET', '/api/memory-bridge/clients/codex/registration')).json().preview;
  const reg = (await call(OWNER, 'POST', '/api/memory-bridge/clients/codex/registration', { previewHash: preview.previewHash, confirm: true })).json().registration;
  writeFileSync(file, readFileSync(file, 'utf8') + '\n[profiles.fast]\nmodel = "small"\n');
  const u = (await call(OWNER, 'POST', `/api/memory-bridge/registrations/${reg.id}/undo`)).json();
  assert.equal(u.mode, 'entry-removed');
  const now = readFileSync(file, 'utf8');
  assert.ok(!now.includes('dpro-memory'));
  assert.ok(now.startsWith(original.trimEnd()), 'original text kept');
  assert.match(now, /\[profiles\.fast\]/, 'the CLI\'s own change kept');
});

test('back-flow: a CLI\'s own memory files come back as review proposals, each chunk once', async () => {
  const claudeMd = join(folder, 'CLAUDE.md');
  writeFileSync(claudeMd, readFileSync(claudeMd, 'utf8') + '\n\n## Deploy\n\nThe staging server for Alpha is in the Frankfurt region.\n');
  const auto = join(claudeProjectDir(folder, dir), 'memory');
  mkdirSync(auto, { recursive: true });
  writeFileSync(join(auto, 'notes.md'), `# Notes\n\nAlpha release notes are written in docs/CHANGES.md by hand. Token ${SECRET}\n`);
  const before = (await pending()).length;
  const r = await call(OWNER, 'POST', `/api/memory-bridge/projects/${project.id}/backflow`);
  assert.equal(r.statusCode, 200, r.body);
  const res = r.json().result;
  assert.ok(res.proposed >= 2, JSON.stringify(res));
  const list = await pending();
  assert.equal(list.length, before + res.proposed);
  const details = await Promise.all(list.map(async (p) => (await call(OWNER, 'GET', `/api/memory/proposals/${p.id}`)).json()));
  const text = JSON.stringify(details);
  assert.match(text, /Frankfurt/);
  assert.match(text, /CHANGES\.md/);
  assert.ok(!text.includes(SECRET), 'secret scan before review');
  assert.ok(!text.includes('Alpha deploys with the release script'), 'Dpro\'s own section is not imported back');
  const again = (await call(OWNER, 'POST', `/api/memory-bridge/projects/${project.id}/backflow`)).json().result;
  assert.equal(again.proposed, 0, 'each chunk once');
});

test('agent tools: same gates (owner\'s own turn only; apply needs owner approval)', async () => {
  assert.equal(APPROVAL_REQUIRED_TOOLS.memory_bridge_apply, 'settings');
  const outsider = await memoryBridgeTool.execute({ action: 'status' }, { userId: OWNER, agentId: 'br-main', toolPolicy: { channel: 'telegram' } });
  assert.ok(outsider.error);
  const user = await memoryBridgeApplyTool.execute({ action: 'set_client', client: 'codex', enabled: false }, { userId: 'br-user', agentId: 'br-main' });
  assert.ok(user.error, 'not for a non-owner account');
  const ownerRun = await memoryBridgeTool.execute({ action: 'preview_files', project_id: project.id }, { userId: OWNER, agentId: 'br-main' });
  assert.equal(ownerRun.error, undefined, JSON.stringify(ownerRun));
  assert.match(ownerRun.content[0].text, /previewHash/);
});

test('folder settings: files can be stopped, turning them on needs preview + confirm', async () => {
  const on = await call(OWNER, 'PATCH', `/api/memory-bridge/projects/${project.id}`, { filesEnabled: true });
  assert.equal(on.statusCode, 400);
  const off = await call(OWNER, 'PATCH', `/api/memory-bridge/projects/${project.id}`, { filesEnabled: false, backflowEnabled: true });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json().folder.filesEnabled, false);
  const audit = (await call(OWNER, 'GET', '/api/memory-bridge/audit')).json().entries;
  assert.ok(audit.some((e) => e.action === 'registered') && audit.some((e) => e.action === 'mcp-propose'));
  assert.ok(!JSON.stringify(audit).includes(SECRET));
  // M11: reads are in the activity log by tool name only (never the query text), and each app shows its last call.
  const reads = audit.filter((e) => e.action === 'mcp-read' && e.client === 'claude-code');
  assert.ok(reads.some((e) => e.detail === 'memory_search') && reads.some((e) => e.detail === 'project_brief'));
  assert.ok(!JSON.stringify(audit).includes('release script'), 'the search text is not logged');
  const status = (await call(OWNER, 'GET', '/api/memory-bridge')).json();
  const cc = status.clients.find((c) => c.client === 'claude-code');
  assert.ok(cc.lastCallAt && typeof cc.lastTool === 'string', 'Claude Code has a last call');
  assert.equal(status.clients.find((c) => c.client === 'antigravity').lastCallAt, null);
});

test('the real stdio server starts the way a CLI starts it, lists its tools and only talks to loopback', async () => {
  const { serverLaunch } = await import(join(backendDir, 'src/memory/bridge/clients.ts'));
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const launch = serverLaunch('codex');
  const transport = new StdioClientTransport({ command: launch.command, args: launch.args, cwd: folder,
    env: { PATH: process.env.PATH, HOME: dir, AGENT_PLAYER_CONFIG_DIR: process.env.AGENT_PLAYER_CONFIG_DIR, AGENT_PLAYER_URL: 'http://127.0.0.1:9' }, stderr: 'pipe' });
  const c = new Client({ name: 'stdio-test', version: '1' });
  await c.connect(transport);
  const tools = (await c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['handoff_write', 'latest_handoff', 'memory_propose', 'memory_search', 'pinned_facts', 'project_brief']);
  const r = await c.callTool({ name: 'project_brief', arguments: {} });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /Cannot reach Dpro/);
  await c.close();
});

test.after(async () => { await app.close(); });
