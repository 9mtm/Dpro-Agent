// DESIGN-FIND-01 + PROJECT-TECH-01 backend and the discovery split: a scan finds
// a project's design (Tailwind, CSS variables, brand kit, DESIGN.md rules, logos)
// and its local databases (SQLite table names from a copy, .env DB_* names,
// compose services) and adds them to the project on its own; only a real
// conflict waits for the owner; DESIGN.md is written between Dpro's markers;
// never a row, never a password. Each section asks discovery for its own kinds.
// Run: node --import tsx --test test/memory-design-db.test.mjs
// Throwaway DB + HOME, fake files, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const loadFile = (file) => import(pathToFileURL(file).href);
const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-design-db-')));
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

const PW = `pw-${randomBytes(8).toString('hex')}`; // fake, test only
const PW2 = `pw2-${randomBytes(8).toString('hex')}`; // fake, test only
const ROW = `row-value-${randomBytes(6).toString('hex')}`;
const w = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };
const app = join(home, 'work', 'brand-app');
mkdirSync(join(app, '.git'), { recursive: true });
w(join(app, 'tailwind.config.js'), `module.exports = {\n  theme: {\n    extend: {\n      colors: {\n        primary: { DEFAULT: '#003f4d', light: '#e0f4f8' },\n        ink: '#111111',\n      },\n      fontFamily: {\n        sans: ['Inter', 'sans-serif'],\n      },\n    },\n  },\n};\n`);
w(join(app, 'src', 'styles.css'), ':root {\n  --brand: #00a8cd;\n  --surface: rgb(250, 250, 250);\n  --font-heading: "Poppins", sans-serif;\n}\n');
w(join(app, 'docs', 'brand-kit.md'), '# Brand kit\n\nTeal `#003f4d` → cyan `#00A8CD`.\n\n- Always use the teal logo on light backgrounds.\n- Never stretch the logo.\n- A note without a rule word.\n');
w(join(app, 'DESIGN.md'), '# Design\n\nOwner notes stay here.\n\n- Keep buttons rounded.\n');
w(join(app, 'public', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');
w(join(app, 'public', 'favicon.ico'), 'ico');
w(join(app, 'src', 'random.png'), 'not a logo name');
w(join(app, '.env'), `DB_CONNECTION=mysql\nDB_HOST=127.0.0.1\nDB_PORT=3306\nDB_DATABASE=shop\nDB_USERNAME=shopuser\nDB_PASSWORD=${PW}\nAPP_KEY=base64:${PW}\n`);
w(join(app, 'docker-compose.yml'), `services:\n  web:\n    image: nginx:1\n  db:\n    image: postgres:16\n    ports:\n      - "5433:5432"\n    environment:\n      POSTGRES_PASSWORD: ${PW2}\n`);
mkdirSync(join(app, 'database'), { recursive: true });
const sqliteFile = join(app, 'database', 'app.sqlite');
{ const s = new Database(sqliteFile); s.exec('CREATE TABLE users (id INTEGER, email TEXT); CREATE TABLE orders (id INTEGER)'); s.prepare('INSERT INTO users VALUES (1, ?)').run(ROW); s.close(); }
const sqliteBefore = createHash('sha256').update(readFileSync(sqliteFile)).digest('hex');
w(join(app, 'notes.db'), 'not a sqlite file');
// The project is known from a coding agent's memory folder (as on a real computer).
const cc = join(home, '.claude', 'projects', '-work-brand-app');
w(join(cc, 'abc.jsonl'), JSON.stringify({ type: 'user', cwd: app, message: { role: 'user', content: 'hi' } }));
w(join(cc, 'memory', 'fact.md'), '---\nname: release-day\ndescription: Ships on Fridays\ntype: project\n---\n');
w(join(home, '.claude', 'skills', 'writer', 'SKILL.md'), '---\nname: writer\ndescription: "Write posts"\n---\n\nShort posts.\n');
w(join(home, '.ssh', 'config'), 'Host devbox\n  HostName devbox.local\n');

const { getDatabase, closeDatabase } = await loadFile(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const OWNER = 'dd-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, 'dd@example.test', 'dd', 'x', 'owner', 'active')`).run(OWNER);
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES ('dd-user', 'du@example.test', 'du', 'x', 'user', 'active')`).run();
db.prepare(`INSERT INTO agents_config (id, name) VALUES ('dd-agent', 'Dd Agent')`).run();
db.prepare(`INSERT INTO agents_config (id, name) VALUES ('dd-other', 'Dd Other')`).run();
const T = await loadFile(join(backendDir, 'src/tools/memory/project-tech.ts'));
const { discoveryTool } = await loadFile(join(backendDir, 'src/tools/discovery.ts'));
const { approvalCategory } = await loadFile(join(backendDir, 'src/tools/approvals.ts'));
const { registerAuthGate } = await loadFile(join(backendDir, 'src/auth/auth-gate.ts'));
const { discoveryRoutes } = await loadFile(join(backendDir, 'src/api/routes/discovery.ts'));
const { memoryDesktopRoutes } = await loadFile(join(backendDir, 'src/api/routes/memory-desktop.ts'));
const { generateToken } = await loadFile(join(backendDir, 'src/auth/jwt.ts'));
const { default: Fastify } = await import('fastify');
const server = Fastify(); registerAuthGate(server);
await server.register(discoveryRoutes, { home }); await server.register(memoryDesktopRoutes); await server.ready();
test.after(async () => { await server.close(); closeDatabase(); process.chdir(backendDir); rmSync(dir, { recursive: true, force: true }); });
const call = (method, url, payload, who = OWNER) => server.inject({ method, url, headers: { authorization: `Bearer ${generateToken(who, 1)}` }, payload });
const BASE = '/api/memory/import/discovery';
const never = (text) => { for (const s of [PW, PW2, ROW]) assert.ok(!text.includes(s), 'a password or a row leaked'); };
const SLUG = 'brand-app';
const designFile = () => readFileSync(join(app, 'DESIGN.md'), 'utf8');
const ctx = { workspaceDir: dir, userId: OWNER, agentId: 'dd-agent', memoryDrawers: [{ kind: 'owner' }, { kind: 'project', key: SLUG }] };

test('one scan: design and databases are found, shown with their project and added on their own', async () => {
  const r = await call('GET', BASE);
  assert.equal(r.statusCode, 200, r.body);
  never(r.body);
  const v = r.json();
  const design = v.items.find((i) => i.kind === 'design');
  assert.ok(design, JSON.stringify(v.items.map((i) => i.kind)));
  assert.equal(design.state, 'imported', 'added without an import step');
  assert.match(design.to, /Projects · brand-app · Design/);
  const dbs = v.items.filter((i) => i.kind === 'database');
  assert.deepEqual(dbs.map((i) => i.name.split(' · ')[1]).sort(), ['mysql', 'postgres', 'sqlite']);
  assert.ok(!dbs.some((i) => i.from === 'notes.db'), 'a file without the SQLite header is not a database');
  assert.ok(db.prepare('SELECT 1 FROM memory_project_design WHERE owner_id = ? AND slug = ?').get(OWNER, SLUG));
  assert.ok(db.prepare('SELECT 1 FROM memory_project_databases WHERE owner_id = ? AND slug = ?').get(OWNER, SLUG));
  const pr = await call('GET', `${BASE}/items/${dbs.find((i) => /sqlite/.test(i.name)).id}`); assert.equal(pr.statusCode, 200, pr.body); const p = pr.json().item;
  assert.match(p.text, /Tables \(2\): orders, users/);
  never(JSON.stringify(p));
  assert.equal((await call('POST', `${BASE}/items/${design.id}/remove`)).statusCode, 409, 'design is not removable from here');
});

test('discovery split: each section asks for its own kinds', async () => {
  const mem = (await call('GET', `${BASE}?kinds=memory,note,design,database`)).json();
  assert.ok(mem.items.length > 0);
  assert.ok(mem.items.every((i) => ['memory', 'note', 'design', 'database'].includes(i.kind)), JSON.stringify(mem.items.map((i) => i.kind)));
  assert.ok(!mem.roots.some((r) => r.id === 'computer' && r.count > 0 && !mem.items.some((i) => (i.rootId ?? 'computer') === 'computer')), 'counts follow the filter');
  const skills = (await call('GET', `${BASE}?kinds=skill,tool`)).json();
  assert.deepEqual([...new Set(skills.items.map((i) => i.kind))], ['skill']);
  const ssh = (await call('GET', `${BASE}?kinds=ssh`)).json();
  assert.deepEqual(ssh.items.map((i) => i.name), ['devbox']);
  assert.equal((await call('GET', `${BASE}?kinds=memory,bogus`)).statusCode, 400);
  const tool = await discoveryTool.execute({ action: 'list', kinds: ['design', 'database'] }, { userId: OWNER, agentId: 'dd-agent' });
  assert.ok(!tool.error, tool.error);
  assert.ok(tool.data.items.length === 4 && tool.data.items.every((i) => i.kind === 'design' || i.kind === 'database'));
});

test('design view: colours, fonts, logos, rules; the main-colour conflict waits for the owner', async () => {
  const r = await call('GET', `/api/memory/projects/${SLUG}/design`);
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  const colours = Object.fromEntries(d.colours.map((c) => [c.name, c.value]));
  assert.equal(colours.primary, '#003f4d');
  assert.equal(colours['primary-light'], '#e0f4f8');
  assert.equal(colours.brand, '#00a8cd');
  assert.ok(d.colours.length >= 4);
  assert.deepEqual(d.fonts.map((f) => f.name), ['Inter', 'Poppins']);
  assert.deepEqual(d.logos.map((l) => [l.kind, l.path.endsWith('logo.svg') || l.path.endsWith('favicon.ico'), l.main]).sort(), [['favicon', true, false], ['logo', true, true]]);
  assert.ok(!d.logos.some((l) => l.path.includes('random.png')), 'an image without a logo name is not a logo');
  const rules = d.rules.map((x) => x.text);
  assert.ok(rules.includes('Always use the teal logo on light backgrounds.') && rules.includes('Never stretch the logo.') && rules.includes('Keep buttons rounded.'), JSON.stringify(rules));
  assert.ok(!rules.some((x) => /without a rule/.test(x)));
  assert.equal(d.conflicts.length, 1);
  assert.equal(d.conflicts[0].kind, 'main-colour');
  assert.deepEqual(d.conflicts[0].options.map((o) => o.value).sort(), ['#003f4d', '#00a8cd']);
  assert.ok(d.logos.every((l) => l.path.startsWith('~')), 'paths are shown from the home folder');
  const all = (await call('GET', '/api/memory/projects/design-conflicts')).json().conflicts;
  assert.deepEqual(all.map((c) => [c.project, c.kind]), [[SLUG, 'main-colour']]);
  assert.equal((await call('GET', `/api/memory/projects/${SLUG}/design`, undefined, 'dd-user')).statusCode, 403);
  assert.equal((await call('GET', '/api/memory/projects/no-such-project/design')).statusCode, 404);

  // DESIGN.md: Dpro's section between its markers, the owner's text kept.
  const text = designFile();
  assert.ok(text.startsWith('# Design\n\nOwner notes stay here.\n\n- Keep buttons rounded.\n'), 'owner text kept byte for byte');
  assert.match(text, /<!-- dpro-design:start[\s\S]*- primary: `#003f4d`[\s\S]*Open question for the owner[\s\S]*<!-- dpro-design:end -->/);
  assert.equal(d.writeFile, true);
  assert.ok(d.file.writtenAt);

  // The logo is served as an image, never as a page.
  const logo = d.logos.find((l) => l.kind === 'logo');
  const img = await call('GET', `/api/memory/projects/${SLUG}/design/logos/${logo.id}`);
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers['content-type'], 'image/svg+xml');
  assert.match(img.headers['content-security-policy'], /sandbox/);
  assert.equal((await call('GET', `/api/memory/projects/${SLUG}/design/logos/ffffffffffffffff`)).statusCode, 404);
});

test('owner choices: main colour answers the conflict, not a logo, DESIGN.md switch, undo', async () => {
  const d0 = (await call('GET', `/api/memory/projects/${SLUG}/design`)).json();
  const fav = d0.logos.find((l) => l.kind === 'favicon');
  const p = await call('PATCH', `/api/memory/projects/${SLUG}/design`, { mainColour: '#00A8CD', notLogo: fav.id });
  assert.equal(p.statusCode, 200, p.body);
  const d = p.json();
  assert.deepEqual(d.conflicts, []);
  assert.equal(d.colours.find((c) => c.main).value, '#00a8cd');
  assert.ok(!d.logos.some((l) => l.id === fav.id));
  assert.equal(d.hiddenLogos, 1);
  assert.match(designFile(), /- brand: `#00a8cd` \(main\)/);
  assert.ok(!/Open question/.test(designFile()));
  assert.equal((await call('PATCH', `/api/memory/projects/${SLUG}/design`, { mainColour: '#123456' })).statusCode, 404);
  assert.equal((await call('PATCH', `/api/memory/projects/${SLUG}/design`, { bogus: 1 })).statusCode, 400);

  // Switch off: DESIGN.md is left as it is.
  assert.equal((await call('PATCH', `/api/memory/projects/${SLUG}/design`, { writeFile: false })).statusCode, 200);
  const before = designFile();
  w(join(app, 'tailwind.config.js'), readFileSync(join(app, 'tailwind.config.js'), 'utf8').replace("ink: '#111111',", "ink: '#111111',\n        sand: '#f4e3c1',"));
  await call('POST', `${BASE}/scan`);
  assert.equal(designFile(), before, 'switch off: not written');
  const changed = (await call('GET', `/api/memory/projects/${SLUG}/design`)).json();
  assert.ok(changed.colours.some((c) => c.value === '#f4e3c1'), 'the change came in on its own');
  assert.equal(changed.canUndo, true);
  const undone = await call('POST', `/api/memory/projects/${SLUG}/design/undo`);
  assert.equal(undone.statusCode, 200, undone.body);
  assert.ok(!undone.json().colours.some((c) => c.value === '#f4e3c1'), 'undo brings the previous design back');
  assert.equal((await call('POST', `/api/memory/projects/${SLUG}/design/undo`)).statusCode, 409);
  assert.equal((await call('PATCH', `/api/memory/projects/${SLUG}/design`, { writeFile: true })).statusCode, 200);
});

test('databases: metadata and table names only, the original file untouched, levels per agent', async () => {
  const r = await call('GET', `/api/memory/projects/${SLUG}/databases`);
  assert.equal(r.statusCode, 200, r.body);
  never(r.body);
  assert.ok(!r.body.includes('shopuser'), 'no user names either');
  const list = r.json().databases;
  const sqlite = list.find((x) => x.kind === 'sqlite');
  assert.deepEqual(sqlite.tables, ['orders', 'users']);
  const env = list.find((x) => x.kind === 'env');
  assert.deepEqual([env.engine, env.host, env.port, env.database], ['mysql', '127.0.0.1', '3306', 'shop']);
  const compose = list.find((x) => x.kind === 'compose');
  assert.deepEqual([compose.engine, compose.service, compose.image, compose.port], ['postgres', 'db', 'postgres:16', '5433:5432']);
  assert.equal(createHash('sha256').update(readFileSync(sqliteFile)).digest('hex'), sqliteBefore, 'the original SQLite file is unchanged');
  assert.ok(statSync(sqliteFile).isFile());
  assert.equal(r.json().defaultLevel, 'exists');

  // Default level: the agent sees that the databases exist, not their tables.
  const seen = await T.projectDatabasesTool.execute({}, ctx);
  assert.ok(!seen.error, seen.error);
  assert.equal(seen.data.level, 'exists');
  assert.ok(seen.data.databases.every((x) => x.tables === undefined));
  assert.equal(seen.data.databases.find((x) => x.kind === 'sqlite').tableCount, 2);
  const set = await call('PATCH', `/api/memory/projects/${SLUG}/databases`, { agentId: 'dd-agent', level: 'tables' });
  assert.equal(set.statusCode, 200, set.body);
  const more = await T.projectDatabasesTool.execute({}, ctx);
  assert.deepEqual(more.data.databases.find((x) => x.kind === 'sqlite').tables, ['orders', 'users']);
  never(JSON.stringify(more));
  const other = await T.projectDatabasesTool.execute({}, { ...ctx, agentId: 'dd-other' });
  assert.equal(other.data.level, 'exists', 'levels are per agent');
  assert.equal((await call('PATCH', `/api/memory/projects/${SLUG}/databases`, { agentId: 'dd-agent', level: 'everything' })).statusCode, 400);
  assert.equal((await call('PATCH', `/api/memory/projects/${SLUG}/databases`, { agentId: 'nobody', level: 'data' })).statusCode, 404);
  const data = await call('PATCH', `/api/memory/projects/${SLUG}/databases`, { agentId: 'dd-agent', level: 'data' });
  assert.equal(data.statusCode, 200);
  assert.equal((await T.projectDatabasesTool.execute({}, ctx)).data.data, 'ask the owner each time');
  assert.deepEqual((await call('GET', `/api/memory/projects/${SLUG}/databases`)).json().access.map((a) => [a.agentId, a.level]), [['dd-agent', 'data']]);
});

test('agent tools: project open or the owner\'s turn; outsiders never; changes need approval', async () => {
  const d = await T.projectDesignTool.execute({}, ctx);
  assert.ok(!d.error, d.error);
  assert.match(d.content[0].text, /## Design \(found by Dpro\)/);
  assert.ok((await T.projectDesignTool.execute({}, { ...ctx, toolPolicy: { channel: 'telegram' } })).error, 'outsider turn');
  assert.ok((await T.projectDesignTool.execute({}, { ...ctx, userId: 'dd-user' })).error, 'not the owner');
  const boardRun = { ...ctx, userId: 'dd-agent', accessOwnerId: OWNER, memoryDrawers: [{ kind: 'owner' }] };
  assert.ok((await T.projectDesignTool.execute({ project: SLUG }, boardRun)).error, 'a task run without the project open');
  assert.ok(!(await T.projectDesignTool.execute({ project: SLUG }, { ...boardRun, memoryDrawers: [{ kind: 'project', key: SLUG }] })).error, 'a task run on the project');
  assert.equal(approvalCategory({ name: 'project_design_apply' }), 'settings');
  assert.equal(approvalCategory({ name: 'project_databases_apply' }), 'settings');
  assert.equal(approvalCategory({ name: 'project_design' }), null);
  const a = await T.projectDatabasesApplyTool.execute({ project: SLUG, agent_id: 'dd-agent', level: 'default' }, ctx);
  assert.ok(!a.error, a.error);
  assert.equal((await T.projectDatabasesTool.execute({}, ctx)).data.level, 'exists');
  const off = await T.projectDesignApplyTool.execute({ project: SLUG, write_file: false }, ctx);
  assert.ok(!off.error, off.error);
  assert.equal(off.data.design.writeFile, false);
});

test('kinds a scan reads: design and databases can be switched off', async () => {
  const k = await call('PUT', `${BASE}/kinds`, { design: false, databases: false });
  assert.equal(k.statusCode, 200, k.body);
  const v = (await call('POST', `${BASE}/scan`)).json();
  assert.ok(!v.items.some((i) => i.kind === 'design' || i.kind === 'database'));
  assert.ok(db.prepare('SELECT 1 FROM memory_project_design WHERE owner_id = ? AND slug = ?').get(OWNER, SLUG), 'what was added stays');
});
