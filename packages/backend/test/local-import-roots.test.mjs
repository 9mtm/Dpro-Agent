// MEM-IMPORT-03: every conversation belongs to its project root (git root; a
// worktree folder belongs to its repository; a folder from an older computer
// joins the same project by its last folder names), every conversation is
// listed (no newest-400 cap, large files read from the start only), ids survive
// a moved home folder, and project facts reach the owner's project drawer.
// Run: node --import tsx --test test/local-import-roots.test.mjs
// Throwaway DB + HOME, fake logs, fake model, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const loadFile = (file) => import(pathToFileURL(file).href);
const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-import-roots-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {};
console.log = quiet; console.warn = quiet;

const { getDatabase, closeDatabase } = await loadFile(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES ('rt-owner', 'rt@example.test', 'rt', 'x', 'owner', 'active')`).run();

// A repository, a linked worktree of it, a worktree folder that is gone, and the same shop project from an old Windows computer.
const shop = join(dir, 'htdocs', 'shop'); mkdirSync(join(shop, '.git', 'worktrees', 'fix'), { recursive: true }); mkdirSync(join(shop, 'api'), { recursive: true });
const linked = join(dir, 'htdocs', 'shop-wt', 'fix'); mkdirSync(linked, { recursive: true });
writeFileSync(join(linked, '.git'), `gitdir: ${join(shop, '.git', 'worktrees', 'fix')}\n`);
const elsewhere = join(dir, 'tools', 'linked-elsewhere'); mkdirSync(elsewhere, { recursive: true });
writeFileSync(join(elsewhere, '.git'), `gitdir: ${join(shop, '.git', 'worktrees', 'fix')}\n`);
const gone = join(dir, 'htdocs', 'shop-wt', 'removed');
const windows = 'C:\\MAMP\\htdocs\\shop\\api';
const blog = join(dir, 'htdocs', 'blog'); mkdirSync(blog, { recursive: true });

const line = (o) => JSON.stringify(o);
const claude = (folder, file, cwd, text, extra = []) => {
  const d = join(dir, '.claude', 'projects', folder); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, file), [...extra, line({ type: 'user', ...(cwd ? { cwd } : {}), timestamp: '2026-10-20T10:00:00Z', message: { role: 'user', content: text } }), line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'OK.' }] } })].join('\n'));
};
claude('-htdocs-shop', 'a1.jsonl', join(shop, 'api'), 'Shop: prices are in euros.');
claude('-htdocs-shop', 'a2.jsonl', null, 'Shop log without a folder.');
claude('-htdocs-shop-wt-fix', 'a3.jsonl', linked, 'Shop worktree: the fix branch.');
claude('-tools-linked-elsewhere', 'a3b.jsonl', elsewhere, 'Shop worktree outside the shop folder.');
claude('-htdocs-shop-wt-removed', 'a4.jsonl', gone, 'Shop worktree that was removed.');
claude('C--MAMP-htdocs-shop', 'a5.jsonl', windows, 'Shop on the old Windows computer.');
claude('-htdocs-blog', 'a6.jsonl', blog, 'Blog: posts go out on Mondays.');
// A large log: only its start is read for the list.
claude('-htdocs-blog', 'big.jsonl', blog, 'Blog: the big conversation.', []);
writeFileSync(join(dir, '.claude', 'projects', '-htdocs-blog', 'big.jsonl'), [line({ type: 'user', cwd: blog, message: { role: 'user', content: 'Blog: the big conversation.' } }),
  ...Array.from({ length: 300 }, (_, i) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `reply ${i} ${'x'.repeat(5000)}` }] } }))].join('\n'));
// Codex: 450 small sessions (more than the old cap) and one archived, compressed session.
const codexDay = join(dir, '.codex', 'sessions', '2026', '10', '20'); mkdirSync(codexDay, { recursive: true });
for (let i = 0; i < 450; i++) writeFileSync(join(codexDay, `rollout-2026-10-20T10-00-00-${String(i).padStart(4, '0')}.jsonl`), [line({ type: 'session_meta', payload: { cwd: blog } }), line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Codex note ${i}` }] } })].join('\n'));
const archived = join(dir, '.codex', 'archived_sessions'); mkdirSync(archived, { recursive: true });
writeFileSync(join(archived, 'rollout-2026-09-01T10-00-00-old.jsonl.zst'), zlib.zstdCompressSync(Buffer.from([line({ type: 'session_meta', payload: { cwd: shop } }), line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Archived: the shop ships on Fridays.' }] } })].join('\n'))));

const A = await loadFile(join(backendDir, 'src/memory/import/local-agents.ts'));
const L = await loadFile(join(backendDir, 'src/memory/import/local-import.ts'));
const { createProject } = await loadFile(join(backendDir, 'src/repositories/chat-conversations.ts'));
test.after(async () => { await L.stopLocalImports(); closeDatabase(); process.chdir(backendDir); const fs = await import('node:fs/promises'); await fs.rm(dir, { recursive: true, force: true }); });

const list = await A.listLocalSessions(dir);
const by = (words) => list.find((s) => s.title.startsWith(words));

test('every conversation is listed, archived Codex sessions included; a large log is read from its start only', () => {
  assert.equal(list.filter((s) => s.source === 'codex').length, 451, 'no newest-400 cap; the compressed archive is read');
  assert.equal(by('Archived:').root, shop);
  const big = by('Blog: the big');
  assert.equal(big.turns, null, 'a large log is not read in full for the list');
  assert.equal(big.cwd, blog);
  assert.equal(by('Blog: posts').turns, 2);
});

test('a conversation belongs to its project root: git root, worktrees, a gone worktree, the old Windows folder', () => {
  for (const words of ['Shop: prices', 'Shop worktree: the fix', 'Shop worktree outside', 'Shop worktree that was removed', 'Shop on the old Windows']) {
    assert.equal(by(words).root, shop, words);
    assert.equal(by(words).rootName, 'shop', words);
  }
  assert.equal(by('Shop log without').cwd, join(shop, 'api'), 'a Claude log without a folder takes the folder of its Claude project');
  assert.equal(by('Shop log without').root, shop);
  assert.equal(by('Blog: posts').root, blog);
  assert.ok(!JSON.stringify(list.map(({ id, legacyId, source, title }) => ({ id, legacyId, source, title }))).includes('.claude/projects'), 'no log path in ids or titles');
});

test('ids are named by the session file, not its path; the earlier path id still finds the conversation', async () => {
  const s = by('Blog: posts');
  const file = join(dir, '.claude', 'projects', '-htdocs-blog', 'a6.jsonl');
  assert.equal(s.id, A.sessionId('claude-code', join('/somewhere/else', 'a6.jsonl')), 'the same session file elsewhere keeps its id');
  assert.equal(s.legacyId, A.legacySessionId('claude-code', file));
  assert.equal((await A.findSession(s.legacyId, dir)).file, file);
  assert.equal((await A.findSession(s.id, dir)).file, file);
});

test('matching a root to the owner\'s projects: folder, folder on another computer, project name', () => {
  const P = [{ slug: 'shop', name: 'Shop', folder: shop }, { slug: 'blog-site', name: 'Blog', folder: null }, { slug: 'api', name: 'API', folder: join(shop, 'api') }];
  assert.equal(A.matchProject(join(shop, 'api', 'src'), shop, P).slug, 'api', 'the deepest folder that holds the conversation');
  assert.equal(A.matchProject(shop, shop, P).slug, 'shop');
  assert.equal(A.matchProject('D:\\work\\htdocs\\shop', 'D:\\work\\htdocs\\shop', P.slice(0, 2)).slug, 'shop', 'same last two folder names');
  assert.equal(A.matchProject(blog, blog, P).slug, 'blog-site', 'a project named like the folder');
  assert.equal(A.matchProject('/x/unknown', '/x/unknown', P), undefined);
  assert.equal(A.worktreeOwner('C:\\MAMP\\htdocs\\dpro\\agent_player-wt\\claude'), 'C:\\MAMP\\htdocs\\dpro\\agent_player');
  assert.equal(A.worktreeOwner('/u/p/agent_player/.claude/worktrees/mem-x/packages'), '/u/p/agent_player');
  assert.equal(A.worktreeOwner('/u/p/agent_player-wt/claude/.local-runtime/home/work/shop-wt/gone'), '/u/p/agent_player-wt/claude/.local-runtime/home/work/shop', 'the innermost worktree');
});

test('a folder that exists inside another repository\'s worktree folder keeps its own git root', async () => {
  const inner = join(dir, 'outer-wt', 'one', 'inner'); mkdirSync(join(inner, '.git'), { recursive: true }); mkdirSync(join(inner, 'src'), { recursive: true });
  assert.equal((await A.projectRoot(join(inner, 'src'), dir)).root, inner);
  const plain = join(dir, 'outer-wt', 'one', 'plain'); mkdirSync(plain, { recursive: true });
  assert.equal((await A.projectRoot(plain, dir)).root, plain, 'not a git folder: the folder itself');
});

test('import: project facts from a worktree conversation go to the project drawer; one imported under its earlier id is skipped', async () => {
  await createProject('rt-owner', { name: 'Shop', folder: shop });
  const extract = async () => [{ title: 'Branch', content: 'The shop fix is on its own branch.', scope: 'project', evidence: 'Shop worktree: the fix branch' }];
  const already = by('Blog: posts');
  db.prepare("INSERT INTO local_agent_imports (user_id, session_id, source, batch_id, proposed, archive_name) VALUES ('rt-owner', ?, 'claude-code', NULL, 0, 'x.md')").run(already.legacyId);
  let job = await L.startImport('rt-owner', [by('Shop worktree: the fix').id, already.id], { extract, home: dir });
  for (let i = 0; i < 200 && job.status === 'running'; i++) { await new Promise((r) => setTimeout(r, 20)); job = await L.getJob('rt-owner', job.id); }
  assert.equal(job.status, 'done', job.notice);
  assert.match(job.notice, /1 already imported/);
  const drawers = db.prepare("SELECT drawer_kind, drawer_key FROM memory_file_proposals WHERE status = 'pending'").all().map((r) => `${r.drawer_kind}:${r.drawer_key}`);
  assert.deepEqual(drawers, ['project:shop']);
});

test('a folder no project claims keeps its project facts in a project drawer named after it, never in the owner drawer', async () => {
  assert.equal(A.rootDrawerKey(join(dir, 'htdocs', 'Rare-Pals'), dir), 'rare-pals');
  assert.equal(A.rootDrawerKey('C:\\MAMP\\htdocs\\dpro\\telagent', dir), 'telagent');
  for (const r of [dir, '/private/tmp/x/scratchpad/merge-try', 'C:\\Users\\Me', null]) assert.equal(A.rootDrawerKey(r, dir), null, String(r));
  db.prepare("UPDATE memory_file_proposals SET status = 'rejected'").run();
  const extract = async () => [{ title: 'Note', content: 'The blog keeps a running Codex note seven.', scope: 'project', evidence: 'Codex note 7' }];
  let job = await L.startImport('rt-owner', [list.find((s) => s.title === 'Codex note 7').id], { extract, home: dir });
  for (let i = 0; i < 200 && job.status === 'running'; i++) { await new Promise((r) => setTimeout(r, 20)); job = await L.getJob('rt-owner', job.id); }
  assert.equal(job.status, 'done', job.notice);
  const drawers = db.prepare("SELECT drawer_kind, drawer_key FROM memory_file_proposals WHERE status = 'pending'").all().map((r) => `${r.drawer_kind}:${r.drawer_key}`);
  assert.deepEqual(drawers, ['project:blog'], job.notice);
});

test('one item the model cannot answer is tried again, then left out; the import goes on (it pauses only after 3 in a row)', async () => {
  const pick = (n) => list.find((s) => s.title === `Codex note ${n}`).id;
  let calls = 0;
  const extract = async (text) => { calls++; if (/Codex note 11\b/.test(text)) throw new L.ItemUnreadable('model 500'); return []; };
  let job = await L.startImport('rt-owner', [pick(10), pick(11), pick(12)], { extract, home: dir });
  for (let i = 0; i < 200 && job.status === 'running'; i++) { await new Promise((r) => setTimeout(r, 20)); job = await L.getJob('rt-owner', job.id); }
  assert.equal(job.status, 'done', job.notice);
  assert.equal(job.errors, 1, 'the one item is counted as not read');
  assert.equal(calls, 4, 'the failing item was tried twice');
  const failing = async () => { throw new L.ItemUnreadable('model 500'); };
  job = await L.startImport('rt-owner', [pick(20), pick(21), pick(22), pick(23)], { extract: failing, home: dir });
  for (let i = 0; i < 200 && job.status === 'running'; i++) { await new Promise((r) => setTimeout(r, 20)); job = await L.getJob('rt-owner', job.id); }
  assert.equal(job.status, 'error', 'three in a row: the model is in trouble, the import pauses');
  assert.equal(job.done, 2, 'two left out, the third keeps its place for Resume');
});
