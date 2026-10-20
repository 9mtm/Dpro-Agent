// INST-09: `agent-player doctor [--fix] [--json]`. Fake install + throwaway
// SQLite DB in a temp folder. fetch (Ollama) and the port listener list are
// stubbed: no network, no port. No secret value or password is printed.
// Run (from the repo root): node --import tsx --test packages/cli/test/doctor.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync, existsSync, realpathSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repoBackend = join(here, '..', '..', 'backend');
const backendRequire = createRequire(join(repoBackend, 'package.json'));
const Database = backendRequire('better-sqlite3');
const bcrypt = backendRequire('bcryptjs');

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ap-cli-doctor-')));
process.env.HOME = join(tmp, 'home');
process.env.AGENT_PLAYER_CONFIG_DIR = join(tmp, 'home', '.config', 'agent-player');

const ir = await import('../src/utils/install-root.ts');
const dc = await import('../src/utils/doctor-checks.ts');
const { doctorCommand } = await import('../src/commands/doctor.ts');

test.after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function fakeInstall() {
  const root = join(tmp, `install-${++n}`);
  mkdirSync(join(root, 'packages', 'backend', 'src', 'db', 'migrations'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'agent-player', scripts: { dev: 'node scripts/next-local.mjs dev', start: 'node scripts/next-local.mjs start' } }));
  writeFileSync(join(root, 'packages', 'backend', 'package.json'), JSON.stringify({ name: '@agent-player/backend' }));
  writeFileSync(join(root, 'scripts', 'next-local.mjs'), "const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' };\n");
  for (const f of ['001_init.sql', '002_more.sql', '003_new.sql']) writeFileSync(join(root, 'packages', 'backend', 'src', 'db', 'migrations', f), '');
  return ir.pathsFor(root, 'env');
}

function makeDb(paths, { applied = ['001', '002', '003'], users = [] } = {}) {
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  const db = new Database(join(paths.dataDir, 'agent-player.db'));
  db.exec('CREATE TABLE migrations (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE users (id TEXT PRIMARY KEY, password_hash TEXT NOT NULL);');
  for (const id of applied) db.prepare('INSERT INTO migrations VALUES (?, ?)').run(id, id);
  for (const [id, pw] of users) db.prepare('INSERT INTO users VALUES (?, ?)').run(id, bcrypt.hashSync(pw, 4));
  db.close();
}

const realDb = (file) => new Database(file, { readonly: true, fileMustExist: true });
function ctx(paths, over = {}) {
  return {
    paths,
    env: {},
    fix: false,
    nodeVersion: 'v22.3.0',
    platform: process.platform,
    fetchFn: async () => new Response(JSON.stringify({ models: [{ name: 'qwen3.5:9b' }] })),
    listListeners: () => [],
    openDbReadOnly: realDb,
    bcryptCompare: (p, h) => bcrypt.compareSync(p, h),
    freeBytes: () => 50 * 1024 ** 3,
    ...over,
  };
}
const byId = (results) => Object.fromEntries(results.map((r) => [r.id, r]));

test('has at least 15 checks', () => {
  assert.ok(dc.CHECKS.length >= 15, String(dc.CHECKS.length));
});

test('healthy install: every check ok (deps check aside), read-only DB open', async () => {
  const paths = fakeInstall();
  makeDb(paths, { users: [['owner-1', 'a-long-' + randomBytes(6).toString('hex')]] });
  for (const d of [paths.logsDir, paths.runDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const env = { JWT_SECRET: randomBytes(64).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'), MASTER_ENCRYPTION_KEY: randomBytes(32).toString('hex'), WORKFLOW_SECRET: randomBytes(32).toString('hex') };
  writeFileSync(join(paths.dataDir, 'secrets.env'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  writeFileSync(join(paths.dataDir, 'instance.json'), '{}', { mode: 0o600 });
  let openedReadOnly = 0;
  const results = await dc.runDoctor(ctx(paths, { openDbReadOnly: (f) => { openedReadOnly++; return realDb(f); } }));
  const r = byId(results);
  for (const [id, res] of Object.entries(r)) {
    if (id === 'deps') continue; // fake install has no node_modules
    assert.equal(res.status, 'ok', `${id}: ${res.detail}`);
  }
  assert.equal(r.deps.status, 'fail');
  assert.ok(openedReadOnly >= 3);
  const text = JSON.stringify(results);
  for (const v of Object.values(env)) assert.ok(!text.includes(v), 'secret value in output');
  assert.match(r.secrets.detail, /JWT_SECRET \(file\)/);
});

test('problems are reported: missing secrets, loose modes, 0.0.0.0 bind, HOST, pending migrations, old Node, low disk, Ollama down', async () => {
  const paths = fakeInstall();
  makeDb(paths, { applied: ['001'] });
  chmodSync(paths.dataDir, 0o755);
  writeFileSync(join(paths.dataDir, 'secrets.env'), `JWT_SECRET=${randomBytes(64).toString('hex')}\n`, { mode: 0o644 });
  chmodSync(join(paths.dataDir, 'secrets.env'), 0o644);
  writeFileSync(join(paths.backendDir, '.env'), 'HOST=0.0.0.0\n', { mode: 0o644 });
  chmodSync(join(paths.backendDir, '.env'), 0o644);
  writeFileSync(join(paths.dataDir, 'instance.json'), '{}');
  chmodSync(join(paths.dataDir, 'instance.json'), 0o644);
  const fetched = [];
  const results = await dc.runDoctor(ctx(paths, {
    nodeVersion: 'v18.19.0',
    listListeners: (port) => (port === 41522 ? [{ command: 'node', pid: 1, address: '*:41522' }] : [{ command: 'node', pid: 2, address: '127.0.0.1:41521' }]),
    fetchFn: async (u) => { fetched.push(String(u)); throw new Error('ECONNREFUSED'); },
    freeBytes: () => 0.5 * 1024 ** 3,
  }));
  const r = byId(results);
  assert.equal(r.node.status, 'fail');
  assert.equal(r['data-dir'].status, 'fail');
  assert.match(r['data-dir'].detail, /0755/);
  assert.equal(r['secrets-file'].status, 'fail');
  assert.equal(r.secrets.status, 'warn');
  assert.match(r.secrets.detail, /ENCRYPTION_KEY, MASTER_ENCRYPTION_KEY, WORKFLOW_SECRET missing/);
  assert.equal(r['env-files'].status, 'fail');
  assert.equal(r.instance.status, 'fail');
  assert.equal(r.host.status, 'fail');
  assert.equal(r.ports.status, 'fail');
  assert.match(r.ports.detail, /41522 listens on \*:41522/);
  assert.match(r.ports.detail, /41521 in use on loopback/);
  assert.equal(r.migrations.status, 'warn');
  assert.match(r.migrations.detail, /2 pending \(002, 003\)/);
  assert.equal(r.ollama.status, 'warn');
  assert.deepEqual(fetched, ['http://127.0.0.1:11434/api/tags']);
  assert.equal(r.disk.status, 'fail');
  assert.equal(await doctorCommand({}, { paths, context: ctx(paths, { nodeVersion: 'v18.0.0' }), log: () => {} }), 1, 'exit code 1 on failures');
});

test('placeholder secrets fail and are not "fixed"; published passwords are found by hash, never printed', async () => {
  const paths = fakeInstall();
  makeDb(paths, { users: [['u-admin', 'admin123'], ['u-ok', 'fine-' + randomBytes(6).toString('hex')]] });
  writeFileSync(join(paths.backendDir, '.env'), 'JWT_SECRET=your-secret-key-here-CHANGE-THIS-IMMEDIATELY\nENCRYPTION_KEY=xyz\n', { mode: 0o600 });
  const results = await dc.runDoctor(ctx(paths, { fix: true }));
  const r = byId(results);
  assert.equal(r.secrets.status, 'fail');
  assert.match(r.secrets.detail, /JWT_SECRET is a known placeholder \(\.env\)/);
  assert.match(r.secrets.detail, /ENCRYPTION_KEY has the wrong format/);
  assert.equal(existsSync(join(paths.dataDir, 'secrets.env')), false, 'no secrets generated next to a placeholder');
  assert.equal(r.passwords.status, 'fail');
  assert.match(r.passwords.detail, /1 account\(s\).*u-admin/);
  const text = JSON.stringify(results);
  assert.ok(!text.includes('admin123'));
  assert.ok(!text.includes('CHANGE-THIS'));
  assert.equal(readFileSync(join(paths.backendDir, '.env'), 'utf-8').includes('CHANGE-THIS'), true, '.env content untouched');
});

test('--fix: chmod, create folders, generate missing secrets; never deletes; second run is clean', async () => {
  const paths = fakeInstall();
  mkdirSync(paths.dataDir, { recursive: true });
  chmodSync(paths.dataDir, 0o755);
  writeFileSync(join(paths.dataDir, 'keep-me.txt'), 'x');
  const jwt = randomBytes(64).toString('hex');
  writeFileSync(join(paths.dataDir, 'secrets.env'), `JWT_SECRET=${jwt}\n`);
  chmodSync(join(paths.dataDir, 'secrets.env'), 0o640);
  writeFileSync(join(paths.root, '.env'), 'X=1\n');
  chmodSync(join(paths.root, '.env'), 0o644);
  const before = readdirSync(paths.dataDir).sort();

  const out = [];
  const code = await doctorCommand({ fix: true, json: true }, { paths, context: ctx(paths), log: (m) => out.push(m) });
  const report = JSON.parse(out.at(-1));
  const r = byId(report.results);
  assert.equal(statSync(paths.dataDir).mode & 0o777, 0o700);
  for (const d of [paths.logsDir, paths.runDir]) assert.equal(statSync(d).mode & 0o777, 0o700);
  const file = join(paths.dataDir, 'secrets.env');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const text = readFileSync(file, 'utf-8');
  assert.ok(text.startsWith(`JWT_SECRET=${jwt}\n`), 'existing value kept');
  for (const k of ['ENCRYPTION_KEY', 'MASTER_ENCRYPTION_KEY', 'WORKFLOW_SECRET']) assert.match(text, new RegExp(`^${k}=[0-9a-f]{64}$`, 'm'));
  assert.equal(statSync(join(paths.root, '.env')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(paths.root, '.env'), 'utf-8'), 'X=1\n');
  assert.match(r.secrets.fixed, /generated ENCRYPTION_KEY, MASTER_ENCRYPTION_KEY, WORKFLOW_SECRET/);
  assert.equal(r.secrets.status, 'ok');
  for (const name of before) assert.ok(existsSync(join(paths.dataDir, name)), `${name} kept`);
  const all = out.join('\n');
  for (const line of text.split('\n').filter(Boolean)) assert.ok(!all.includes(line.split('=')[1]), 'secret value printed');
  assert.equal(code, 1, 'deps still fail in the fake install');

  const again = byId(await dc.runDoctor(ctx(paths, { fix: true })));
  for (const id of ['data-dir', 'secrets', 'secrets-file', 'env-files']) assert.equal(again[id].fixed, undefined, id);
});

test('doctor only contacts Ollama on loopback; a remote OLLAMA_URL is skipped', async () => {
  const paths = fakeInstall();
  const fetched = [];
  const fetchFn = async (u) => { fetched.push(String(u)); return new Response(JSON.stringify({ models: [{ name: 'llama3:8b' }] })); };
  let r = byId(await dc.runDoctor(ctx(paths, { env: { OLLAMA_URL: 'http://ollama.example.com:11434' }, fetchFn })));
  assert.equal(r.ollama.status, 'skip');
  assert.deepEqual(fetched, []);
  r = byId(await dc.runDoctor(ctx(paths, { env: { OLLAMA_URL: 'http://localhost:11434/' }, fetchFn })));
  assert.equal(r.ollama.status, 'warn');
  assert.match(r.ollama.detail, /qwen3\.5:9b not pulled/);
  r = byId(await dc.runDoctor(ctx(paths, { env: { DEFAULT_MODEL: 'llama3:8b' }, fetchFn })));
  assert.equal(r.ollama.status, 'ok');
  assert.ok(fetched.every((u) => /^http:\/\/(127\.0\.0\.1|localhost):11434\/api\/tags$/.test(u)), fetched.join(','));
});

test('telemetry check fails when a script calls next directly', async () => {
  const paths = fakeInstall();
  writeFileSync(join(paths.root, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev' } }));
  const r = byId(await dc.runDoctor(ctx(paths)));
  assert.equal(r.telemetry.status, 'fail');
  assert.match(r.telemetry.detail, /dev/);
});

test('helpers: loopback detection and lsof parsing; published password list matches the backend', () => {
  for (const a of ['127.0.0.1:41522', '[::1]:41522', 'localhost', '::1', '127.0.0.1']) assert.equal(dc.isLoopbackAddress(a), true, a);
  for (const a of ['*:41522', '0.0.0.0', '[::]:41522', '192.168.1.5:41522', '0.0.0.0:41521']) assert.equal(dc.isLoopbackAddress(a), false, a);
  const parsed = dc.parseLsof('COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 123 me 20u IPv4 0x1 0t0 TCP 127.0.0.1:41522 (LISTEN)\nnode 124 me 21u IPv6 0x2 0t0 TCP *:41521 (LISTEN)\n');
  assert.deepEqual(parsed, [{ command: 'node', pid: 123, address: '127.0.0.1:41522' }, { command: 'node', pid: 124, address: '*:41521' }]);
  const src = readFileSync(join(repoBackend, 'src', 'auth', 'default-accounts.ts'), 'utf-8');
  const block = /PUBLISHED_DEFAULT_PASSWORDS[^[]*\[([^\]]*)\]/.exec(src)[1];
  const backendList = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...dc.PUBLISHED_DEFAULT_PASSWORDS].sort(), backendList.sort());
});
