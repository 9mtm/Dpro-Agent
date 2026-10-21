// MEM-UX-02 backend: exported memory files follow the database in the
// background (never over the owner's edits), and coding apps + project folders
// connect on their own once the owner allowed reading this computer (backup and
// Undo kept; an app the owner switched off or undid stays off).
// Run: node --import tsx --test test/memory-desktop-sync.test.mjs
// Throwaway DB + HOME + data folder, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-memsync-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.MEMORY_GRAPH_MODEL = 'off';
for (const k of ['CODEX_HOME', 'AGENT_PLAYER_DATA_DIR']) delete process.env[k];
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const OWNER = 'ms-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, 'ms@example.test', 'ms', 'x', 'owner', 'active')`).run(OWNER);
db.prepare('UPDATE agents_config SET is_primary = 0').run();
db.prepare(`INSERT INTO agents_config (id, name, is_primary) VALUES ('ms-agent', 'Ms Agent', 1)`).run();

const { getMemoryStorage } = await import(join(backendDir, 'src/memory/storage.ts'));
await getMemoryStorage().initialize();
const { newMemory, saveVersioned } = await import(join(backendDir, 'src/memory/learning.ts'));
const MF = await import(join(backendDir, 'src/memory/memory-files.ts'));
const FS = await import(join(backendDir, 'src/memory/files-sync.ts'));
const B = await import(join(backendDir, 'src/memory/bridge/service.ts'));
const { syncMemoryBridge } = await import(join(backendDir, 'src/memory/bridge/sync.ts'));
const { MARK_START } = await import(join(backendDir, 'src/memory/bridge/managed-files.ts'));
const P = await import(join(backendDir, 'src/discovery/places.ts'));
const { createProject } = await import(join(backendDir, 'src/repositories/chat-conversations.ts'));
const { getMemoryIndexer } = await import(join(backendDir, 'src/memory/indexer.ts'));
B.setBridgeEnv({ home: dir, env: {} });

test.after(() => { try { getMemoryIndexer().close(); } catch { /* not opened */ } closeDatabase(); process.chdir(backendDir); rmSync(dir, { recursive: true, force: true }); });

const save = (content) => saveVersioned(newMemory(OWNER, { kind: 'owner' }, { type: 'fact', importance: 5, content }, {}), OWNER, 'test');
const exported = () => readFileSync(MF.drawerFilePath('ms-agent', OWNER, { kind: 'owner' }), 'utf8');

test('background re-export: an exported file follows the database, never over the owner\'s edits', async () => {
  await save('The office opens at nine.');
  await MF.exportDrawerFile(OWNER, 'ms-agent', { kind: 'owner' });
  FS.resetMemoryFilesSync();
  assert.equal((await FS.syncMemoryFiles(OWNER)).reexported, 0, 'up to date: nothing to do');

  await save('Lunch is at one.');
  assert.ok(!exported().includes('Lunch is at one.'));
  const r = await FS.syncMemoryFiles(OWNER);
  assert.equal(r.reexported, 1);
  assert.ok(exported().includes('Lunch is at one.'), 're-exported with the new memory');
  assert.equal((await FS.syncMemoryFiles(OWNER)).drawers, 0, 'nothing changed since the last round');

  // The owner edits the file; a later change in the database leaves it alone.
  const edited = exported().replace('Lunch is at one.', 'Lunch is at half past one.');
  writeFileSync(MF.drawerFilePath('ms-agent', OWNER, { kind: 'owner' }), edited);
  await save('Meetings end by five.');
  const r2 = await FS.syncMemoryFiles(OWNER);
  assert.equal(r2.reexported, 0);
  assert.equal(r2.edited, 1);
  assert.equal(exported(), edited, 'the owner\'s edit is kept');
});

test('coding apps and project folders connect on their own only after the owner allowed reading this computer', async () => {
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ theme: 'dark' }));
  mkdirSync(join(dir, '.codex'), { recursive: true });
  writeFileSync(join(dir, '.codex', 'config.toml'), 'model = "test"\n');
  const folder = join(dir, 'work', 'alpha');
  mkdirSync(folder, { recursive: true });
  const project = await createProject(OWNER, { name: 'Alpha', folder });

  // Not allowed yet: nothing is touched.
  assert.deepEqual(await B.autoConnect(OWNER, false), { registered: [], folders: [], conflicts: 0 });
  await syncMemoryBridge();
  assert.ok(!readFileSync(join(dir, '.claude.json'), 'utf8').includes('dpro-memory'));
  assert.ok(!existsSync(join(folder, 'AGENTS.md')));

  // The owner allows a folder: the next round connects what is on this computer.
  await P.setPlaces(OWNER, { allow: [join(dir, 'work')] });
  await syncMemoryBridge();
  const claude = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'));
  assert.ok(claude.mcpServers['dpro-memory'], 'Claude Code registered');
  assert.equal(claude.theme, 'dark', 'the rest of the config is kept');
  assert.match(readFileSync(join(dir, '.codex', 'config.toml'), 'utf8'), /dpro-memory/);
  assert.ok(!existsSync(join(dir, '.gemini')), 'an app that is not on this computer is left alone');
  assert.ok(readFileSync(join(folder, 'AGENTS.md'), 'utf8').includes(MARK_START), 'managed files written (default on)');
  const status = await B.bridgeStatus(OWNER);
  const cc = status.clients.find((c) => c.client === 'claude-code');
  assert.equal(cc.enabled, true);
  assert.ok(cc.registrationId, 'registration kept for Undo');
  assert.equal(status.projects.find((p) => p.projectId === project.id).filesEnabled, true);
  const reg = status.registrations.find((r) => r.client === 'claude-code');
  assert.ok(reg.backupPath && existsSync(reg.backupPath), 'the original config was backed up first');
  const audit = db.prepare(`SELECT action, detail FROM memory_bridge_audit WHERE owner_id = ? AND action = 'registered'`).all(OWNER);
  assert.ok(audit.every((a) => /automatic/.test(a.detail ?? '')));

  // Undo: the original comes back and the app is never registered again by itself.
  await B.registrationUndo(OWNER, cc.registrationId);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')), { theme: 'dark' });
  const again = await B.autoConnect(OWNER, true);
  assert.deepEqual(again.registered, []);
  assert.ok(!readFileSync(join(dir, '.claude.json'), 'utf8').includes('dpro-memory'));

  // A folder the owner turned off stays off.
  await B.setFolder(OWNER, project.id, { filesEnabled: false });
  const before = readFileSync(join(folder, 'AGENTS.md'), 'utf8');
  assert.deepEqual((await B.autoConnect(OWNER, true)).folders, []);
  assert.equal(readFileSync(join(folder, 'AGENTS.md'), 'utf8'), before);
  assert.ok(readdirSync(join(dir, '.codex')).includes('config.toml'));
});
