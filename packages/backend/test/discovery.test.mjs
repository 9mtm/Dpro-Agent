// DISCOVER-01 (board M17): "Found on this computer" — memory files, project notes,
// skills, MCP servers and SSH hosts, grouped by project folder; import / update /
// ignore / remove / keep; private keys, .env files and tokens never leave.
// Run: node --import tsx --test test/discovery.test.mjs
// Throwaway DB + HOME, fake files, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const loadFile = (file) => import(pathToFileURL(file).href);
const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-discovery-')));
const home = join(dir, 'home');
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.MEMORY_GRAPH_MODEL = 'off';
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {};
console.log = quiet; console.warn = quiet; console.info = quiet;

const TOKEN = `ghp_${randomBytes(18).toString('hex')}`; // fake, test only
const KEY = 'TEST-PRIVATE-KEY-NEVER-READ';
const ENV = 'TEST_ENV_VALUE_NEVER_READ';
const w = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };
const shop = join(home, 'work', 'shop');
mkdirSync(join(shop, '.git'), { recursive: true });
w(join(shop, 'CLAUDE.md'), '# Shop\nPrices are in euros.\n');
w(join(shop, 'docs', 'HANDOFF.md'), '# Handoff\nNext: the cart.\n');
w(join(shop, '.env'), `SECRET=${ENV}\n`);
w(join(shop, '.claude', 'skills', 'shop-release', 'SKILL.md'), '---\nname: shop-release\ndescription: "How the shop is released"\n---\n\nRun the checks, then tag.\n');
w(join(shop, '.mcp.json'), JSON.stringify({ mcpServers: { 'shop-admin': { command: 'node', args: ['admin.js'], env: { SHOP_TOKEN: TOKEN } } } }));
const cc = join(home, '.claude', 'projects', `-work-shop`);
w(join(cc, 'abc.jsonl'), JSON.stringify({ type: 'user', cwd: shop, message: { role: 'user', content: 'hello shop' } }));
w(join(cc, 'memory', 'MEMORY.md'), '- [Lang](lang.md)\n');
w(join(cc, 'memory', 'lang.md'), '---\nname: owner-language\ndescription: The owner chats in Arabic\nmetadata:\n  type: user\n---\n\nReplies in simple Arabic.\n');
w(join(cc, 'memory', 'voices.md'), '---\nname: brand-voices\ndescription: Brand voices never mix\ntype: feedback\n---\n\n**Why:** each brand has its own voice.\n');
w(join(cc, 'memory', 'colors.md'), '---\nname: brand-colors\ndescription: Shop colors are teal and cyan\ntype: project\n---\n');
w(join(home, '.claude', 'skills', 'writer', 'SKILL.md'), '---\nname: writer\ndescription: "Write posts"\n---\n\nShort posts.\n');
w(join(home, '.claude', 'CLAUDE.md'), '# Global\nChat in Arabic.\n');
w(join(home, '.codex', 'config.toml'), '[mcp_servers.docs]\ncommand = "node"\nargs = ["docs.js"]\n');
w(join(home, '.ssh', 'config'), 'Host *\n  ServerAliveInterval 30\nHost devbox build\n  HostName devbox.local\n  User mo\n  Port 2222\n  IdentityFile ~/.ssh/id_ed25519\n');
w(join(home, '.ssh', 'id_ed25519'), KEY);
// More of the owner's notes deeper in the project, and copies / other people's code that are left out.
w(join(shop, 'packages', 'api', 'AGENTS.md'), '# API\nUse Fastify.\n');
w(join(shop, '.cursor', 'rules', 'style.mdc'), 'Use tabs.\n');
w(join(shop, '.github', 'copilot-instructions.md'), 'Short answers.\n');
w(join(shop, 'docs', 'code', 'someone-else', 'AGENTS.md'), '# Not ours\n');
w(join(home, 'Documents', 'old-archive', 'shop', 'CLAUDE.md'), '# Old copy\n');
w(join(home, 'Documents', 'tools', 'other-programs', 'x', 'CLAUDE.md'), '# Other program\n');
// DISCOVER-02: a project in an allowed folder, one in a folder never allowed, commands / sub-agents.
w(join(home, 'Documents', 'myshop', 'AGENTS.md'), '# My shop\nShip on Fridays.\n');
w(join(home, 'Documents', 'myshop', 'private', 'CLAUDE.md'), '# Private\n');
w(join(home, 'Other', 'secret-project', 'CLAUDE.md'), '# Never allowed\n');
w(join(shop, '.claude', 'commands', 'deploy.md'), '---\ndescription: Deploy the shop\n---\n\nRun the checks, then deploy.\n');
w(join(shop, '.claude', 'agents', 'reviewer.md'), '# Reviewer\nReview pull requests.\n');

const { getDatabase, closeDatabase } = await loadFile(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES ('dc-owner', 'dc@example.test', 'dc', 'x', 'owner', 'active')`).run();
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES ('dc-user', 'du@example.test', 'du', 'x', 'user', 'active')`).run();
const D = await loadFile(join(backendDir, 'src/discovery/service.ts'));
const { registerAuthGate } = await loadFile(join(backendDir, 'src/auth/auth-gate.ts'));
const { discoveryRoutes } = await loadFile(join(backendDir, 'src/api/routes/discovery.ts'));
const { generateToken } = await loadFile(join(backendDir, 'src/auth/jwt.ts'));
const { default: Fastify } = await import('fastify');
const server = Fastify(); registerAuthGate(server); await server.register(discoveryRoutes, { home }); await server.ready();
test.after(async () => { await server.close(); closeDatabase(); process.chdir(backendDir); rmSync(dir, { recursive: true, force: true }); });
const call = (method, url, payload, who = 'dc-owner') => server.inject({ method, url, headers: { authorization: `Bearer ${generateToken(who, 1)}` }, payload });
const BASE = '/api/memory/import/discovery';
const find = (v, kind, name) => v.items.find((i) => i.kind === kind && i.name === name);
const never = (text) => { for (const s of [KEY, ENV, TOKEN]) assert.ok(!text.includes(s), 'a secret or key leaked'); };

let v;
test('folders: nothing outside the allowed folders is read; several folders are allowed at once', async () => {
  const top = (await call('GET', `${BASE}/places`)).json().places;
  const docs = top.find((p) => p.name === 'Documents'), other = top.find((p) => p.name === 'Other');
  assert.ok(docs && other && docs.state === null, JSON.stringify(top.map((p) => p.name)));
  let first = (await call('GET', BASE)).json();
  assert.ok(!first.items.some((i) => /myshop|Never allowed|secret-project/.test(i.name + i.from)), 'not allowed yet: not read');
  assert.equal(first.allowedFolders, 0);
  assert.equal((await call('PUT', `${BASE}/places`, { allow: [docs.id, other.id] })).statusCode, 200);
  assert.equal((await call('PUT', `${BASE}/places`, { deny: [other.id] })).statusCode, 200, 'taken back');
  const kids = (await call('GET', `${BASE}/places?parent=${docs.id}`)).json().places;
  const myshop = kids.find((p) => p.name === 'myshop'); assert.equal(myshop.inherited, 'allow');
  const priv = (await call('GET', `${BASE}/places?parent=${myshop.id}`)).json().places.find((p) => p.name === 'private');
  assert.equal((await call('PUT', `${BASE}/places`, { exclude: [priv.id] })).statusCode, 200);
  first = (await call('GET', BASE)).json();
  assert.ok(first.items.some((i) => i.name === 'AGENTS.md' && first.roots.find((r) => r.id === i.rootId)?.name === 'myshop'), 'a folder in an allowed folder is its own project');
  assert.ok(!first.items.some((i) => i.from.includes('Never allowed') || first.roots.some((r) => r.name === 'secret-project')), 'a folder taken back is not read');
  assert.ok(!first.items.some((i) => i.name.includes(`private${sep}CLAUDE.md`)), 'a left-out subfolder is not read');
  assert.equal(first.allowedFolders, 1);
  const count = (await call('POST', `${BASE}/places/${docs.id}/count`)).json(); assert.ok(count.files >= 4);
  assert.equal((await call('POST', `${BASE}/places`, { path: '/etc' })).statusCode >= 400, true, 'system folders are refused');
});

test('one scan finds every kind, grouped by project folder, with where each goes', async () => {
  const r = await call('GET', BASE); assert.equal(r.statusCode, 200, r.body); never(r.body);
  v = r.json();
  const shopRoot = v.roots.find((x) => x.name === 'shop'); assert.ok(shopRoot, JSON.stringify(v.roots));
  assert.equal(shopRoot.project, 'Projects · shop');
  assert.equal(v.roots[0].id, 'computer', 'This computer comes first');
  assert.deepEqual([find(v, 'memory', 'owner-language').to, find(v, 'memory', 'brand-voices').to, find(v, 'memory', 'brand-colors').to], ['About you', 'Lessons', 'Projects · shop']);
  assert.equal(find(v, 'memory', 'brand-colors').rootId, shopRoot.id);
  assert.ok(!v.items.some((i) => i.name === 'MEMORY'), 'the index file is not a memory');
  assert.deepEqual(v.items.filter((i) => i.kind === 'note').map((i) => i.name).sort(), ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.md', `docs${sep}HANDOFF.md`, `packages${sep}api${sep}AGENTS.md`, `.cursor${sep}rules${sep}style.mdc`, `.github${sep}copilot-instructions.md`].sort());
  assert.equal(v.leftOut, 3, 'copies, archives and other people\'s code are left out');
  assert.deepEqual(v.items.filter((i) => i.kind === 'tool').map((i) => i.name).sort(), ['deploy (command)', 'reviewer (sub-agent)']);
  for (const n of [`packages${sep}api${sep}AGENTS.md`, `.cursor${sep}rules${sep}style.mdc`, `.github${sep}copilot-instructions.md`, `docs${sep}HANDOFF.md`]) assert.equal(v.items.find((i) => i.name === n).rootId, shopRoot.id, `${n} belongs to the project root`);
  assert.deepEqual(v.items.filter((i) => i.kind === 'skill').map((i) => [i.name, i.state]).sort(), [['shop-release', 'decision'], ['writer', 'decision']]);
  const mcp = find(v, 'mcp', 'shop-admin'); assert.match(mcp.from, /1 secret inside/); assert.equal(mcp.rootId, shopRoot.id); assert.match(mcp.to, /off · secret → Credentials/);
  assert.ok(find(v, 'mcp', 'docs'));
  assert.deepEqual(v.items.filter((i) => i.kind === 'ssh').map((i) => i.name), ['devbox', 'build'], 'wildcard hosts are left out');
  assert.ok(!v.items.some((i) => /(?:^|[\\/])(?:\.env|id_ed25519)$/.test(i.name)), '.env and key files are not items');
});

test('preview is redacted; an MCP token and an SSH key never show', async () => {
  const m = (await call('GET', `${BASE}/items/${find(v, 'mcp', 'shop-admin').id}`)).json().item;
  never(JSON.stringify(m)); assert.deepEqual(m.secrets, ['SHOP_TOKEN']); assert.match(m.text, /SHOP_TOKEN/);
  const s = (await call('GET', `${BASE}/items/${find(v, 'ssh', 'devbox').id}`)).json().item;
  never(JSON.stringify(s)); assert.match(s.text, /IdentityFile id_ed25519 \(name only/); assert.match(s.text, /Port 2222/);
});

const previewOf = async (item) => (await call('GET', `${BASE}/items/${item.id}`)).json().item;
test('import: memory files become memories in their drawers, without the model', async () => {
  const items = [];
  for (const n of ['owner-language', 'brand-voices', 'brand-colors']) { const p = await previewOf(find(v, 'memory', n)); items.push({ id: p.id, previewHash: p.previewHash }); }
  const r = await call('POST', `${BASE}/import`, { items }); assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().results.every((x) => x.ok), r.body);
  const mem = db.prepare("SELECT CASE WHEN COALESCE(drawer_key, '') = '' THEN drawer_kind ELSE drawer_kind || ':' || drawer_key END AS drawer_id, type, content FROM memories WHERE user_id = 'dc-owner' AND (status IS NULL OR status = 'active') ORDER BY content").all();
  assert.deepEqual(mem.map((m) => [m.drawer_id, m.type]).sort(), [['experience', 'insight'], ['owner', 'preference'], ['project:shop', 'fact']].sort());
  assert.ok(mem.some((m) => m.content.startsWith('brand-voices: Brand voices never mix')));
  v = (await call('GET', BASE)).json();
  assert.equal(find(v, 'memory', 'brand-colors').state, 'imported');
});

test('a changed memory file shows as Changed and its update changes the same memory', async () => {
  w(join(cc, 'memory', 'colors.md'), '---\nname: brand-colors\ndescription: Shop colors are teal, cyan and white\ntype: project\n---\n');
  v = (await call('POST', `${BASE}/scan`)).json();
  const it = find(v, 'memory', 'brand-colors'); assert.equal(it.state, 'changed');
  const p = await previewOf(it);
  assert.equal((await call('POST', `${BASE}/import`, { items: [{ id: p.id, previewHash: 'f'.repeat(64) }] })).json().results[0].code, 'preview_changed', 'a stale preview is refused');
  const upd = (await call('POST', `${BASE}/import`, { items: [{ id: p.id, previewHash: p.previewHash }] })).json().results[0]; assert.ok(upd.ok, JSON.stringify(upd));
  const rows = db.prepare("SELECT content FROM memories WHERE user_id = 'dc-owner' AND drawer_kind = 'project' AND drawer_key = 'shop' AND (status IS NULL OR status = 'active')").all();
  assert.deepEqual(rows.map((r) => r.content), ['brand-colors: Shop colors are teal, cyan and white'], 'updated in place, not a second memory');
});

test('skills join the library for no agent; MCP servers are added off, the token left out unless chosen; SSH by name', async () => {
  for (const it of [find(v, 'skill', 'writer'), find(v, 'mcp', 'shop-admin'), find(v, 'ssh', 'devbox')]) {
    const p = await previewOf(it);
    const r = (await call('POST', `${BASE}/import`, { items: [{ id: p.id, previewHash: p.previewHash, ...(it.kind === 'mcp' ? { secret: 'leave' } : {}) }] })).json().results[0];
    assert.ok(r.ok, `${it.name}: ${JSON.stringify(r)}`);
  }
  assert.ok(db.prepare("SELECT id FROM central_skills WHERE name = 'writer'").get());
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM central_agent_skills").get().n, 0, 'no agent got the skill');
  const srv = db.prepare("SELECT * FROM mcp_servers WHERE name = 'shop-admin'").get(); assert.ok(srv);
  never(JSON.stringify(srv));
  assert.deepEqual(db.prepare("SELECT alias, host, login, port, key_name FROM ssh_hosts WHERE user_id = 'dc-owner'").get(), { alias: 'devbox', host: 'devbox.local', login: 'mo', port: 2222, key_name: 'id_ed25519' });
  v = (await call('GET', BASE)).json();
  assert.deepEqual(['writer', 'shop-admin', 'devbox'].map((n) => v.items.find((i) => i.name === n).state), ['imported', 'imported', 'imported']);
});

test('ignore / undo, remove (the file stays), gone → keep', async () => {
  const build = find(v, 'ssh', 'build');
  assert.equal((await call('POST', `${BASE}/items/${build.id}/ignore`, { on: true })).statusCode, 200);
  assert.equal(find((await call('GET', BASE)).json(), 'ssh', 'build').state, 'ignored');
  await call('POST', `${BASE}/items/${build.id}/ignore`, { on: false });
  assert.equal(find((await call('GET', BASE)).json(), 'ssh', 'build').state, 'new');
  const lang = find(v, 'memory', 'owner-language');
  assert.equal((await call('POST', `${BASE}/items/${lang.id}/remove`)).statusCode, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE drawer_kind = 'owner' AND user_id = 'dc-owner' AND (status IS NULL OR status = 'active')").get().n, 0, 'taken out of Dpro');
  assert.equal(find((await call('GET', BASE)).json(), 'memory', 'owner-language').state, 'ignored', 'not offered again');
  rmSync(join(cc, 'memory', 'voices.md'));
  v = (await call('POST', `${BASE}/scan`)).json();
  const gone = v.items.find((i) => i.state === 'gone'); assert.equal(gone?.name, 'brand-voices');
  assert.equal((await call('POST', `${BASE}/items/${gone.id}/keep`)).statusCode, 200);
  assert.equal(find((await call('GET', BASE)).json(), 'memory', 'brand-voices'), undefined, 'kept: no longer shown as gone');
});

test('a project folder can stop being watched; settings are checked', async () => {
  const shopRoot = v.roots.find((x) => x.name === 'shop');
  assert.equal((await call('PUT', `${BASE}/roots/${shopRoot.id}`, { watch: false })).statusCode, 200);
  const after = (await call('GET', BASE)).json();
  assert.ok(!after.items.some((i) => i.rootId === shopRoot.id), 'its items leave the list');
  await call('PUT', `${BASE}/roots/${shopRoot.id}`, { watch: true });
  assert.equal((await call('PUT', `${BASE}/settings`, { watch: true, intervalMinutes: 45 })).statusCode, 400);
  assert.deepEqual((await call('PUT', `${BASE}/settings`, { watch: false, intervalMinutes: 15 })).json().settings, { watch: false, intervalMinutes: 15 });
});

test('only what this page added can be removed; a skill with a taken name is not replaced', async () => {
  // An MCP server that was already in Dpro: importing it again only links it, and Remove refuses.
  const docs = find(v, 'mcp', 'docs'); let p = await previewOf(docs);
  assert.ok((await call('POST', `${BASE}/import`, { items: [{ id: p.id, previewHash: p.previewHash }] })).json().results[0].ok);
  const before = db.prepare('SELECT COUNT(*) AS n FROM mcp_servers').get().n;
  w(join(home, '.codex', 'config.toml'), '[mcp_servers.docs]\ncommand = "node"\nargs = ["docs.js"]\n\n[mcp_servers.docs2]\ncommand = "node"\nargs = ["docs.js"]\n');
  v = (await call('POST', `${BASE}/scan`)).json();
  p = await previewOf(find(v, 'mcp', 'docs2'));
  const dup = (await call('POST', `${BASE}/import`, { items: [{ id: p.id, previewHash: p.previewHash }] })).json().results[0];
  assert.ok(dup.ok, 'same launch configuration: linked, not added twice');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mcp_servers').get().n, before);
  assert.equal((await call('POST', `${BASE}/items/${p.id}/remove`)).json().code, 'not_imported', 'the existing server is never removed from here');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mcp_servers').get().n, before);
  // A different skill named "writer" already in Dpro (added elsewhere): blocked, not replaced.
  db.prepare("UPDATE discovery_items SET ref = NULL WHERE kind = 'skill'").run();
  w(join(home, '.claude', 'skills', 'writer', 'SKILL.md'), '---\nname: writer\ndescription: "Write posts"\n---\n\nLonger posts now.\n');
  db.prepare("DELETE FROM discovery_items WHERE kind = 'skill'").run();
  v = (await call('POST', `${BASE}/scan`)).json();
  p = await previewOf(find(v, 'skill', 'writer'));
  assert.equal(p.blocked, 'skill_name_taken');
  assert.equal((await call('POST', `${BASE}/import`, { items: [{ id: p.id, previewHash: p.previewHash }] })).json().results[0].code, 'skill_name_taken');
});

test('project notes, also a Cursor rules file, go to the project-files import (the local model reads them)', async () => {
  v = (await call('GET', BASE)).json();
  const rule = v.items.find((i) => i.kind === 'note' && i.name.endsWith('style.mdc'));
  const p = await previewOf(rule); assert.match(p.text, /Use tabs/);
  const r = (await call('POST', `${BASE}/import`, { items: [{ id: p.id, previewHash: p.previewHash }] })).json().results[0];
  assert.ok(r.ok && r.jobId, JSON.stringify(r));
});

test('a command becomes a skill for no agent; don\'t show a kind; kinds a scan reads', async () => {
  v = (await call('GET', BASE)).json();
  const deploy = v.items.find((i) => i.name === 'deploy (command)');
  const p = await previewOf(deploy); assert.match(p.text, /Run the checks/);
  const imp = (await call('POST', `${BASE}/import`, { items: [{ id: p.id, previewHash: p.previewHash }] })).json().results[0]; assert.ok(imp.ok, JSON.stringify(imp));
  const sk = db.prepare("SELECT name, description FROM central_skills WHERE name = 'shop-deploy'").get();
  assert.deepEqual(sk, { name: 'shop-deploy', description: 'Deploy the shop' });
  const shopRoot = v.roots.find((r) => r.name === 'shop');
  assert.equal((await call('PUT', `${BASE}/roots/${shopRoot.id}/hidden`, { kind: 'tool', on: true })).statusCode, 200);
  v = (await call('GET', BASE)).json();
  assert.ok(!v.items.some((i) => i.kind === 'tool' && i.rootId === shopRoot.id)); assert.deepEqual(v.roots.find((r) => r.id === shopRoot.id).hidden, ['tool']);
  await call('PUT', `${BASE}/roots/${shopRoot.id}/hidden`, { kind: 'tool', on: false });
  assert.deepEqual((await call('PUT', `${BASE}/kinds`, { ssh: false })).json().kinds, { notes: true, tools: true, skills: true, mcp: true, ssh: false, design: true, databases: true });
  assert.ok(!(await call('GET', BASE)).json().items.some((i) => i.kind === 'ssh'));
  await call('PUT', `${BASE}/kinds`, { ssh: true });
  assert.equal((await call('PUT', `${BASE}/kinds`, { pdf: true })).statusCode, 400);
});

test('merge two project folders into one project (the folders stay), then separate; suggestions', async () => {
  v = (await call('GET', BASE)).json();
  const shopRoot = v.roots.find((r) => r.name === 'shop'), my = v.roots.find((r) => r.name === 'myshop');
  const r = await call('POST', `${BASE}/groups`, { name: 'Shop all', roots: [shopRoot.id, my.id] }); assert.equal(r.statusCode, 200, r.body);
  v = (await call('GET', BASE)).json();
  const g = v.roots.find((x) => x.name === 'Shop all');
  assert.deepEqual(g.group.members.map((m) => m.name).sort(), ['myshop', 'shop']);
  assert.ok(!v.roots.some((x) => x.id === shopRoot.id || x.id === my.id), 'shown once, as the merged project');
  assert.ok(v.items.filter((i) => i.rootId === g.id).length >= 5);
  const mem = find(v, 'memory', 'brand-colors'); assert.equal(mem.to, 'Projects · shop-all', 'no Dpro project among them: the merged project\'s own drawer');
  assert.equal((await call('DELETE', `${BASE}/groups/${g.id}`)).statusCode, 200);
  v = (await call('GET', BASE)).json();
  assert.ok(v.roots.some((x) => x.id === shopRoot.id) && v.roots.some((x) => x.id === my.id));
  const P = await loadFile(join(backendDir, 'src/discovery/places.ts'));
  const s = P.suggestMerges([{ id: 'a', name: 'tel_agent' }, { id: 'b', name: 'telagent' }, { id: 'c', name: 'seo-agent' }, { id: 'd', name: 'seo-ai-Agent' }, { id: 'e', name: 'clinic_agent' }, { id: 'f', name: 'hr_agent' }, { id: 'g', name: 'landdingpage_flowxtra' }, { id: 'h', name: 'flowxtra' }], new Set());
  assert.deepEqual(s.map((x) => `${x.a.name}+${x.b.name}`), ['tel_agent+telagent', 'seo-agent+seo-ai-Agent', 'landdingpage_flowxtra+flowxtra']);
  assert.equal(P.suggestMerges([{ id: 'a', name: 'tel_agent' }, { id: 'b', name: 'telagent' }], new Set([P.pairKey('a', 'b')])).length, 0, '"not the same" is remembered');
});

test('owner only; inputs checked', async () => {
  assert.equal((await call('GET', BASE, undefined, 'dc-user')).statusCode, 403);
  assert.equal((await call('POST', `${BASE}/import`, { items: [] })).statusCode, 400);
  assert.equal((await call('POST', `${BASE}/import`, { items: [{ id: '../x', previewHash: 'a'.repeat(64) }] })).statusCode, 400);
  assert.equal((await call('GET', `${BASE}/items/nope`)).statusCode, 400);
});

test('parsers: memory front matter (also CRLF), ssh config, Claude Desktop path on each system', async () => {
  assert.deepEqual(D.parseMemoryFile('---\r\nname: x\r\ndescription: y\r\ntype: feedback\r\n---\r\nbody'), { name: 'x', description: 'y', type: 'feedback', body: 'body' });
  assert.equal(D.parseMemoryFile('no front matter').type, 'project');
  assert.deepEqual(D.parseSshConfig('Host a\n  IdentityFile C:\\Users\\Me\\.ssh\\id_rsa\nMatch host x\n  User z').map((h) => [h.alias, h.key, h.user]), [['a', 'id_rsa', null]]);
  const { claudeDesktopConfig } = await loadFile(join(backendDir, 'src/mcp-client/local-import.ts'));
  assert.match(claudeDesktopConfig('/h', 'darwin'), /Library.Application Support.Claude.claude_desktop_config\.json$/);
  assert.match(claudeDesktopConfig('/h', 'win32'), /AppData.Roaming.Claude.claude_desktop_config\.json$/);
  assert.match(claudeDesktopConfig('/h', 'linux'), /\.config.Claude.claude_desktop_config\.json$/);
  assert.equal(await D.decodeClaudeFolder(home.replace(/[\\/]/g, '-') + '-work-shop'), shop, 'a Claude folder name maps back to the folder');
  const winRoot = (await call('GET', BASE)).json().roots.find((r) => r.path && r.path.startsWith('C:'));
  if (winRoot) assert.ok(!winRoot.path.includes('~'), 'a path from another system is shown as it is');
});

test('agent tools: listed, owner-only, apply needs approval', async () => {
  const { discoveryTool, discoveryApplyTool } = await loadFile(join(backendDir, 'src/tools/discovery.ts'));
  const { approvalCategory } = await loadFile(join(backendDir, 'src/tools/approvals.ts'));
  assert.equal(approvalCategory(discoveryApplyTool), 'settings');
  assert.equal(approvalCategory(discoveryTool), 'other', 'reading the computer is approved per call too');
  const refused = await discoveryTool.execute({ action: 'list' }, { toolPolicy: {} });
  assert.match(refused.error, /answering someone else/);
});

test('system folders are never allowed, by path or by id, also on a drive', async () => {
  const P = await loadFile(join(backendDir, 'src/discovery/places.ts'));
  for (const p of ['/System/Library', '/usr/local', '/Volumes/Backup/System', '/Volumes/Backup/Library/x', '/mnt/disk/Windows', join(home, 'Library'), join(home, 'AppData', 'Roaming')]) assert.equal(P.isSystemPath(p, home), true, p);
  for (const p of ['/Volumes/Backup', '/Volumes/Backup/Projects', join(home, 'Documents', 'private'), '/mnt/disk/work']) assert.equal(P.isSystemPath(p, home), false, p);
  mkdirSync(join(home, 'Library', 'Mail'), { recursive: true });
  const top = (await call('GET', `${BASE}/places`)).json().places;
  assert.ok(!top.some((p) => p.name === 'Library'), 'never offered');
  const id = P.placeId(join(home, 'Library'));
  assert.notEqual((await call('PUT', `${BASE}/places`, { allow: [id] })).statusCode, 200, 'an id that was never offered is refused');
});
