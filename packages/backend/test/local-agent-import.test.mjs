import { pathToFileURL } from 'node:url';
const loadFile = file => import(pathToFileURL(file).href);
// MEM-IMPORT-01: conversations Claude Code and Codex saved on this computer ->
// secrets removed -> private archive -> a (fake) memory agent -> pending proposals.
// Run: node --import tsx --test test/local-agent-import.test.mjs
// Throwaway DB + HOME, fake logs, fake model, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const originalHome = process.env.HOME, originalProfile = process.env.USERPROFILE;
const dir = mkdtempSync(join(tmpdir(), 'ap-local-import-'));
mkdirSync(join(dir, '.data'), { recursive: true });
// A unique path avoids a shared tsx disk-cache hit: its persistent esbuild
// child must start in backendDir, or Windows locks the disposable cwd.
const warmup = join(dir, 'transformer-warmup.ts');
writeFileSync(warmup, 'export const ready: boolean = true;\n');
await loadFile(warmup);
process.chdir(dir);
process.env.HOME = dir;
process.env.USERPROFILE = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = { log: console.log, warn: console.warn };
console.log = () => {}; console.warn = () => {};

const { getDatabase, closeDatabase } = await loadFile(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES ('li-owner', 'li@example.test', 'li', 'x', 'owner', 'active')`).run();
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES ('li-user', 'lu@example.test', 'lu', 'x', 'user', 'active')`).run();
db.prepare('UPDATE agents_config SET is_primary = 0').run();
db.prepare(`INSERT INTO agents_config (id, name, is_primary) VALUES ('li-agent', 'Li Agent', 1)`).run();

const SECRET = `sk-ant-api03-${randomBytes(30).toString('hex')}`; // fake, test only
const app = join(dir, 'work', 'app'); mkdirSync(app, { recursive: true });
const claudeDir = join(dir, '.claude', 'projects', '-work-app'); mkdirSync(claudeDir, { recursive: true });
const line = (o) => JSON.stringify(o);
writeFileSync(join(claudeDir, 's1.jsonl'), [
  line({ type: 'user', cwd: app, timestamp: '2026-10-15T10:00:00Z', message: { role: 'user', content: `Always answer me in Arabic. My key is ${SECRET}` } }),
  line({ type: 'assistant', cwd: app, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Understood, Arabic it is.' }, { type: 'tool_use', name: 'Bash', input: {} }] } }),
  line({ type: 'user', cwd: app, message: { role: 'user', content: [{ type: 'tool_result', content: 'TOOL OUTPUT' }] } }),
  line({ type: 'user', cwd: app, isMeta: true, message: { role: 'user', content: '<system-reminder>injected</system-reminder>' } }),
  line({ type: 'user', cwd: app, isSidechain: true, message: { role: 'user', content: 'subagent text' } }),
].join('\n'));
const codexDir = join(dir, '.codex', 'sessions', '2026', '10', '16'); mkdirSync(codexDir, { recursive: true });
writeFileSync(join(codexDir, 'rollout-2026-10-16-x.jsonl'), [
  line({ type: 'session_meta', timestamp: '2026-10-16T09:00:00Z', payload: { cwd: '/elsewhere', id: 'x' } }),
  line({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'developer rules' }] } }),
  line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } }),
  line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'We deploy on Fridays only.' }] } }),
  line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Noted.' }] } }),
].join('\n'));

const { listLocalSessions } = await loadFile(join(backendDir, 'src/memory/import/local-agents.ts'));
const L = await loadFile(join(backendDir, 'src/memory/import/local-import.ts'));
const { createProject } = await loadFile(join(backendDir, 'src/repositories/chat-conversations.ts'));
const { registerAuthGate } = await loadFile(join(backendDir, 'src/auth/auth-gate.ts'));
const { memoryImportRoutes } = await loadFile(join(backendDir, 'src/api/routes/memory-import.ts'));
const { generateToken } = await loadFile(join(backendDir, 'src/auth/jwt.ts'));
const { default: Fastify } = await import('fastify');
const server = Fastify(); registerAuthGate(server); await server.register(memoryImportRoutes); await server.ready();
console.log = quiet.log; console.warn = quiet.warn;
test.after(async () => { await server.close(); await L.stopLocalImports(); closeDatabase(); globalThis.fetch = realFetch; process.chdir(backendDir); if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; if (originalProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalProfile; const fs = await import('node:fs/promises'); await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
const call = (method, url, payload, who = 'li-owner') => server.inject({ method, url, headers: { authorization: `Bearer ${generateToken(who, 1)}` }, payload });

test('the reader keeps only human and agent text; tool output, thinking, injected and sub-agent text stay out', async () => {
  const s = await listLocalSessions(dir);
  assert.deepEqual(s.map((x) => x.source).sort(), ['claude-code', 'codex']);
  const cc = s.find((x) => x.source === 'claude-code'); const cx = s.find((x) => x.source === 'codex');
  assert.equal(cc.cwd, app); assert.equal(cc.turns, 2);
  assert.equal(cx.cwd, '/elsewhere'); assert.match(cx.title, /deploy on Fridays/);
  assert.ok(!JSON.stringify(s).includes(dir + '/.claude'), 'no file paths leave the reader');
});

test('import: secrets removed before the archive and the model; archive is private; memories become pending proposals', async () => {
  await createProject('li-owner', { name: 'App', folder: app });
  const seen = [];
  const extract = async (text, ctx) => { seen.push(text); return ctx.source === 'claude-code'
    ? [{ title: 'Language', content: 'The owner wants answers in Arabic.', scope: 'owner', evidence: 'Always answer me in Arabic' }, { title: 'Stack', content: 'The app project uses Fastify.', scope: 'project', evidence: 'Understood, Arabic it is' }]
    : [{ title: 'Deploys', content: 'Deploys happen on Fridays only.', scope: 'owner', evidence: 'We deploy on Fridays only' }]; };
  const ids = (await listLocalSessions(dir)).map((x) => x.id);
  let job = await L.startImport('li-owner', ids, { extract, home: dir });
  for (let i = 0; i < 100 && job.status === 'running'; i++) { await new Promise((r) => setTimeout(r, 20)); job = await L.getJob('li-owner', job.id); }
  assert.equal(job.status, 'done', job.notice); assert.equal(job.errors, 0);
  assert.equal(job.proposed, 3);
  assert.ok(seen.every((t) => !t.includes(SECRET)) && seen.some((t) => t.includes('[REDACTED:')), 'the model never sees the secret');
  assert.ok(seen.every((t) => !t.includes('TOOL OUTPUT') && !t.includes('private') && !t.includes('subagent text')));
  const arch = join(dir, '.dpro', 'imports');
  if (process.platform !== 'win32') assert.equal(statSync(arch).mode & 0o777, 0o700);
  const files = readdirSync(join(arch, 'claude-code'));
  if (process.platform !== 'win32') assert.equal(statSync(join(arch, 'claude-code', files[0])).mode & 0o777, 0o600);
  assert.ok(!readFileSync(join(arch, 'claude-code', files[0]), 'utf8').includes(SECRET), 'the archive holds the redacted text only');
  const props = db.prepare("SELECT drawer_kind, drawer_key FROM memory_file_proposals WHERE status = 'pending'").all().map((r) => (r.drawer_key ? `${r.drawer_kind}:${r.drawer_key}` : r.drawer_kind)).sort();
  assert.deepEqual(props, ['owner', 'owner', 'project:app'], 'project facts go to the matching project drawer');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 0, 'nothing is remembered before approval');
  const imported = await L.importedSessions('li-owner');
  assert.equal(imported.size, 2);
});

test('routes: owner only; at most 400 opaque ids; one import at a time', async () => {
  assert.equal((await call('GET', '/api/memory/import/local', undefined, 'li-user')).statusCode, 403);
  const list = await call('GET', '/api/memory/import/local');
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().sessions.every((x) => x.imported), 'already imported sessions are marked');
  assert.ok(!list.body.includes(SECRET), 'titles carry no secrets');
  assert.equal((await call('POST', '/api/memory/import/local', { sessionIds: ['../../etc'] })).statusCode, 400);
  assert.equal((await call('POST', '/api/memory/import/local', { sessionIds: Array.from({ length: 401 }, (_, i) => i.toString(16).padStart(32, '0')) })).statusCode, 400);
  assert.equal((await call('GET', '/api/memory/import/local/jobs/nope')).statusCode, 404);
});

test('wrappers and interruption notes are not human text', async () => {
  const { humanText } = await loadFile(join(backendDir, 'src/memory/import/local-agents.ts'));
  assert.equal(humanText('<external_codex_apps_x>{"a":1}</external_codex_apps_x>'), null);
  assert.equal(humanText('[Request interrupted by user for tool use]'), null);
  assert.equal(humanText('<command-name>/clear</command-name>\n<command-args></command-args>'), null);
  assert.equal(humanText('Please keep it short <b>bold</b> ok'), 'Please keep it short <b>bold</b> ok', 'short inline tags a person typed stay');
  assert.equal(humanText('مرحبا'), 'مرحبا');
});

// ---- MEM-IMPORT-02 ----

test('speed: the model reads the owner\'s words, agent replies cut short, at most two small pieces', async () => {
  const turns = [];
  for (let i = 0; i < 400; i++) { turns.push({ role: 'user', text: `Owner rule ${i}: keep the build green and small.` }); turns.push({ role: 'assistant', text: `Long agent reply ${i} `.repeat(300) }); }
  const text = L.condensed(turns, 'Codex');
  assert.ok(text.length <= L.CHUNK_CHARS * L.MAX_CHUNKS, `condensed input is bounded (${text.length})`);
  assert.match(text, /Owner rule 0:/, 'the start of the conversation stays');
  assert.match(text, /Owner rule 399:/, 'the newest part stays');
  const small = L.condensed(turns.slice(0, 4), 'Codex');
  assert.match(small, /Owner: Owner rule 0/); assert.ok(small.split('Codex: ')[1].length < 300, 'an agent reply is cut to its first line');
  let calls = 0;
  const r = await L.extractMemories(async (chunk) => { calls++; assert.ok(chunk.length <= L.CHUNK_CHARS); return []; }, text, { source: 'codex', cwd: null }, '');
  assert.ok(calls <= L.MAX_CHUNKS, `at most ${L.MAX_CHUNKS} model calls (${calls})`);
  assert.equal(r.memories.length, 0);
});

test('dedupe: the same idea is proposed once (within a conversation and against what is known)', async () => {
  const chunk = 'Owner: merge only locally, never push without asking.\n\nOwner: keep local merges only.';
  const fake = async () => [
    { title: 'Local merges', content: 'The owner merges branches locally only.', scope: 'owner', evidence: 'merge only locally' },
    { title: 'Local-only merges', content: 'Branches are merged locally only by the owner.', scope: 'owner', evidence: 'keep local merges only' },
    { title: 'Merges stay local', content: 'The owner merges branches only locally.', scope: 'owner', evidence: 'merge only locally' },
    { title: 'Ask before push', content: 'Never push without asking the owner.', scope: 'owner', evidence: 'never push without asking' },
  ];
  const r = await L.extractMemories(fake, chunk, { source: 'codex', cwd: null }, chunk);
  assert.deepEqual(r.memories.map((m) => m.title), ['Local merges', 'Ask before push']);
  const again = await L.extractMemories(fake, chunk, { source: 'codex', cwd: null }, chunk, ['Never push to GitHub without asking the owner first.']);
  assert.deepEqual(again.memories.map((m) => m.title), ['Local merges'], 'an idea already stored or pending is not proposed again');
  assert.ok(!L.sameIdea('The owner speaks Iraqi Arabic.', 'The project uses Fastify and SQLite.'));
});

test('accuracy: a memory must rest on words in the conversation; personal details only on the owner\'s own words', async () => {
  const owner = 'Owner: please reply in Arabic, short answers.';
  const chunk = `${owner}\n\nCodex: Sure, I will reply in Arabic (Egyptian style).`;
  const fake = async () => [
    { title: 'Arabic replies', content: 'The owner wants short answers in Arabic.', scope: 'owner', evidence: 'please reply in Arabic, short answers' },
    { title: 'Egyptian dialect', content: 'The owner speaks the Egyptian dialect.', scope: 'owner', personal: true, evidence: 'the owner speaks Egyptian dialect' },
    { title: 'Dialect from agent', content: 'The owner prefers the Egyptian style.', scope: 'owner', personal: true, evidence: 'reply in Arabic (Egyptian style)' },
    { title: 'No evidence', content: 'The owner lives in Cairo.', scope: 'owner' },
  ];
  const r = await L.extractMemories(fake, chunk, { source: 'codex', cwd: null }, 'please reply in Arabic, short answers.');
  assert.deepEqual(r.memories.map((m) => m.title), ['Arabic replies'], 'guessed and agent-only personal details are dropped');
  assert.equal(r.dropped, 3);
  assert.ok(L.supported('مرحبا بك في المشروع', 'Owner: مرحبًا بك في المشروع الجديد'), 'Arabic evidence matches without diacritics');
});

test('Gemini CLI and Antigravity: read their plain-text logs; credential and settings files are never readable', async () => {
  const { listLocalSessions: list, readable, findSession, readSession } = await loadFile(join(backendDir, 'src/memory/import/local-agents.ts'));
  const { default: Database } = await import('better-sqlite3');
  const home = join(dir, 'home2');
  const gem = join(home, '.gemini'); const proj = join(gem, 'tmp', 'abc123');
  mkdirSync(join(proj, 'chats'), { recursive: true }); mkdirSync(join(gem, 'antigravity', 'conversations'), { recursive: true });
  writeFileSync(join(gem, 'oauth_creds.json'), JSON.stringify({ access_token: SECRET }));
  writeFileSync(join(gem, 'settings.json'), '{}');
  writeFileSync(join(proj, '.project_root'), app);
  writeFileSync(join(proj, 'chats', 'session-1.json'), JSON.stringify({ sessionId: 's-1', startTime: '2026-10-16T08:00:00Z', messages: [
    { type: 'user', content: 'Use pnpm in this repo.' }, { type: 'gemini', content: [{ text: 'thinking', thought: true }, { text: 'OK, pnpm.' }] }, { type: 'info', content: 'tool noise' }] }));
  writeFileSync(join(proj, 'logs.json'), JSON.stringify([
    { sessionId: 's-1', type: 'user', message: 'Use pnpm in this repo.', timestamp: '2026-10-16T08:00:00Z' },
    { sessionId: 's-2', type: 'user', message: 'Tests run with node --test.', timestamp: '2026-10-16T09:00:00Z' },
    { sessionId: 's-2', type: 'user', message: '/quit', timestamp: '2026-10-16T09:01:00Z' }]));
  const db = new Database(join(gem, 'antigravity', 'conversation_summaries.db'));
  db.exec(`CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text, last_modified_time datetime, workspace_uris text);
    CREATE VIRTUAL TABLE conversations_fts USING fts5(conversation_id UNINDEXED, chunk_index UNINDEXED, title, user_body, agent_body);`);
  db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)').run('c-1', 'Board work', '2026-10-15 23:34:14.371508+00:00', JSON.stringify([pathToFileURL(app).href]));
  db.prepare('INSERT INTO conversations_fts VALUES (?, ?, ?, ?, ?)').run('c-1', -1, 'Board work', '', '');
  db.prepare('INSERT INTO conversations_fts VALUES (?, ?, ?, ?, ?)').run('c-1', 0, '', 'Cards need a due date.', 'Added due dates.');
  db.close();
  writeFileSync(join(gem, 'antigravity', 'conversations', 'c-1.db'), 'binary steps');

  for (const f of ['oauth_creds.json', 'google_accounts.json', 'settings.json', 'state.json']) assert.equal(readable('gemini-cli', join(gem, f), home), false, f);
  assert.equal(readable('antigravity', join(gem, 'antigravity', 'conversations', 'c-1.db'), home), false, 'binary step stores are not read');
  assert.equal(readable('gemini-cli', join(gem, 'tmp', '..', 'oauth_creds.json'), home), false);
  const s = await list(home);
  assert.deepEqual(s.map((x) => x.source).sort(), ['antigravity', 'gemini-cli', 'gemini-cli']);
  assert.ok(!JSON.stringify(s).includes(SECRET));
  const chat = s.find((x) => x.title.startsWith('Use pnpm')); assert.equal(chat.cwd, app); assert.equal(chat.turns, 2);
  assert.ok(s.some((x) => x.title.startsWith('Tests run')), 'a session only in the prompt log is listed once');
  const agy = s.find((x) => x.source === 'antigravity'); assert.equal(agy.title, 'Board work'); assert.equal(agy.cwd, app);
  const text = await readSession(await findSession(agy.id, home), home);
  assert.deepEqual(text.turns.map((t) => t.role), ['user', 'assistant']);

  const seen = [];
  let job = await L.startImport('li-owner', s.map((x) => x.id), { home, extract: async (t) => { seen.push(t); return [{ title: 'Due dates', content: 'Board cards need a due date.', scope: 'project', evidence: 'Cards need a due date' }]; } });
  for (let i = 0; i < 100 && job.status === 'running'; i++) { await new Promise((r) => setTimeout(r, 20)); job = await L.getJob('li-owner', job.id); }
  assert.equal(job.status, 'done', job.notice); assert.equal(job.errors, 0);
  assert.equal(job.proposed, 1, 'the same memory from three conversations is proposed once');
  assert.ok(seen.every((t) => !t.includes('tool noise') && !t.includes('thinking')));
});


test('conversation preview is owner-only, bounded and redacted without changing the source', async () => {
  const session = (await listLocalSessions(dir)).find(s => s.source === 'claude-code');
  const path = '/api/memory/import/local/sessions/' + session.id;
  const source = join(claudeDir, 's1.jsonl'), before = readFileSync(source, 'utf8');
  assert.equal((await call('GET', path, undefined, 'li-user')).statusCode, 403);
  const result = await call('GET', path);
  assert.equal(result.statusCode, 200);
  const body = result.json();
  assert.equal(body.messages.length, 2);
  assert.ok(!result.body.includes(SECRET));
  assert.ok(!result.body.includes(claudeDir));
  assert.match(body.messages[0].text, /REDACTED/);
  assert.equal(readFileSync(source, 'utf8'), before);
  assert.equal((await call('GET', '/api/memory/import/local/sessions/' + 'f'.repeat(32))).statusCode, 404);
});

test('model disconnection retains the unfinished cursor for explicit resume', async () => {
  const source=join(claudeDir,'retry.jsonl');
  writeFileSync(source,line({type:'user',message:{role:'user',content:'For the Mercury project use SQLite backups every Sunday.'}}));
  const id=(await listLocalSessions(dir)).find(s=>s.title.includes('Mercury')).id;
  let j=await L.startImport('li-owner',[id],{home:dir,extract:async()=>{throw new TypeError('fetch failed')}});
  for(let i=0;i<100&&j.status==='running';i++){await new Promise(r=>setTimeout(r,10));j=await L.getJob('li-owner',j.id)}
  assert.equal(j.status,'error');assert.equal(j.done,0);assert.equal(j.errors,0);
  await L.resumeImport('li-owner',j.id,{home:dir,extract:async()=>[]});
  for(let i=0;i<100&&j.status!=='done';i++){await new Promise(r=>setTimeout(r,10));j=await L.getJob('li-owner',j.id)}
  assert.equal(j.status,'done');assert.equal(j.done,1);
});

test('one project file: selected-folder discovery, redacted preview, durable import, approval and content/fact dedupe', async () => {
 const {scanProjectDocuments,previewProjectDocument,readProjectDocument}=await loadFile(join(backendDir,'src/memory/import/project-documents.ts'));
 const folder=join(dir,'project-docs'),docs=join(folder,'docs');mkdirSync(docs,{recursive:true});mkdirSync(join(folder,'node_modules'),{recursive:true});
 const fact='The Aurora release requires two maintainers to approve deployment.';
 const original='# Project handoff\n\n'+fact+'\n\nTest API key: '+SECRET;
 writeFileSync(join(folder,'CLAUDE.md'),original);writeFileSync(join(docs,'HANDOFF.md'),original);
 writeFileSync(join(folder,'node_modules','AGENTS.md'),'Never import this dependency.');writeFileSync(join(docs,'secrets.md'),SECRET);
 const scan=await scanProjectDocuments('li-owner',[folder]);assert.equal(scan.documents.length,1,'identical content is listed once');
 const pages=join(dir,'scan-page');mkdirSync(pages);for(let i=0;i<2010;i++)writeFileSync(join(pages,`noise-${i}.json`),'{}');
 let automatic=await scanProjectDocuments('li-owner',{auto:true});assert.ok(automatic.documents.some(d=>d.id===scan.documents[0].id),'automatic computer scan finds project documents');
 assert.ok(automatic.nextCursor,'large scan continues in bounded pages');
 await assert.rejects(()=>scanProjectDocuments('li-user',{auto:true,cursor:automatic.nextCursor}));
 const discovered=new Set(automatic.documents.map(d=>d.id));let pageCount=1;
 while(automatic.nextCursor){automatic=await scanProjectDocuments('li-owner',{auto:true,cursor:automatic.nextCursor});for(const d of automatic.documents)discovered.add(d.id);pageCount++;}
 assert.ok(pageCount>1);assert.ok(automatic.scanned>2000);assert.ok(discovered.has(scan.documents[0].id));
 const id=scan.documents[0].id;
 assert.equal(await readProjectDocument('li-user',id),null,'catalog is owner-isolated');
 const preview=await previewProjectDocument('li-owner',id);assert.ok(!preview.text.includes(SECRET));assert.match(preview.text,/REDACTED/);
 const route=await call('POST','/api/memory/import/local/documents',{roots:[folder]});assert.equal(route.statusCode,200);
 assert.equal((await call('GET','/api/memory/import/local/documents/'+id,undefined,'li-user')).statusCode,403);
 assert.ok(!(await call('GET','/api/memory/import/local/documents/'+id)).body.includes(SECRET));
 let extracted=0;const extract=async(text,ctx)=>{extracted++;assert.equal(ctx.source,'project-files');assert.ok(!text.includes(SECRET));return [{title:'Aurora approvals',content:fact,scope:'owner',evidence:fact}]};
 const wait=async j=>{for(let i=0;i<100&&j.status==='running';i++){await new Promise(r=>setTimeout(r,10));j=await L.getJob('li-owner',j.id)}return j;};
 let job=await wait(await L.startImport('li-owner',[id],{home:dir,extract}));assert.equal(job.status,'done');assert.equal(job.proposed,1);
 const prop=db.prepare("SELECT id FROM memory_file_proposals WHERE changes LIKE '%Aurora%' AND status='pending'").get();assert.ok(prop);
 const {getProposal,approveProposal}=await loadFile(join(backendDir,'src/memory/memory-files.ts'));
 const detail=await getProposal('li-owner',prop.id);await approveProposal('li-owner',prop.id,'li-owner',detail.reviewHash);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE user_id=? AND content LIKE ?').get('li-owner','%'+fact+'%').n,1,'approved imported fact appears in memory');
 job=await wait(await L.startImport('li-owner',[id],{home:dir,extract}));assert.equal(job.proposed,0);assert.equal(extracted,1,'same file skipped');
 const selected=scan.documents[0].relative;writeFileSync(join(folder,selected),original+'\nUpdated handoff formatting.');
 await assert.rejects(()=>readProjectDocument('li-owner',id),/changed/);
 const next=await scanProjectDocuments('li-owner',[folder]);const changed=next.documents.find(d=>d.id!==id);assert.ok(changed);
 job=await wait(await L.startImport('li-owner',[changed.id],{home:dir,extract}));assert.equal(job.proposed,0,'same fact from changed content is not proposed again');
 assert.equal(readFileSync(join(folder,'CLAUDE.md'),'utf8').startsWith(original),true);
 const link=join(docs,'outside.md');const {symlinkSync}=await import('node:fs');symlinkSync(join(claudeDir,'s1.jsonl'),link);
 assert.ok(!(await scanProjectDocuments('li-owner',[folder])).documents.some(d=>d.relative.endsWith('outside.md')));
 await assert.rejects(()=>scanProjectDocuments('li-owner',[dir]),()=>false).catch(()=>{});
});

test('automatic import persists an opt-in schedule, catches up due work and saves memories only for enabled automatic imports', async () => {
 const A=await loadFile(join(backendDir,'src/memory/import/automatic-project-import.ts'));
 db.prepare("INSERT INTO users (id,email,username,password_hash,role,status) VALUES ('auto-owner','automatic@example.invalid','automatic','x','owner','active')").run();
 assert.equal((await A.automaticImportSettings('auto-owner')).enabled,false);
 await assert.rejects(()=>A.configureAutomaticImport('auto-owner',{enabled:true,intervalMinutes:1}));
 const {scanProjectDocuments}=await loadFile(join(backendDir,'src/memory/import/project-documents.ts'));
 const folder=join(dir,'automatic-project');mkdirSync(folder);const fact='The Borealis project stores deployment evidence in signed release manifests.';
 writeFileSync(join(folder,'AGENTS.md'),fact);
 const docs=await scanProjectDocuments('auto-owner',[folder]),id=docs.documents[0].id;
 let calls=0,scans=0;const opts={now:1000,home:dir,pollMs:5,scan:async()=>{scans++;return {documents:[{id}],nextCursor:null}},extract:async()=>{calls++;return [{title:'Borealis evidence',content:fact,scope:'owner',evidence:fact}]}};
 await A.configureAutomaticImport('auto-owner',{enabled:true,intervalMinutes:60},1000);
 await Promise.all([A.runDueAutomaticImports(opts),A.runDueAutomaticImports(opts)]);
 let settings=await A.automaticImportSettings('auto-owner');assert.equal(settings.nextRun,3601000);assert.equal(settings.lastImported,1);assert.equal(settings.lastProposed,1);assert.equal(calls,1);assert.equal(scans,1);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE user_id='auto-owner'").get().n,1,'enabled automatic imports save their own facts without review');
 await A.runDueAutomaticImports({...opts,now:3600000});assert.equal(scans,1,'not due yet');
 await A.runDueAutomaticImports({...opts,now:3601000});assert.equal(calls,1,'unchanged files are not imported again');
 settings=await A.automaticImportSettings('auto-owner');assert.equal(settings.lastImported,0);assert.equal(settings.nextRun,7201000);
 const manualFact='The Borealis project requires a signed changelog for every major release.';writeFileSync(join(folder,'HANDOFF.md'),manualFact);
 const manualId=(await scanProjectDocuments('auto-owner',[folder])).documents.find(d=>d.id!==id).id;
 let manual=await L.startImport('auto-owner',[manualId],{home:dir,extract:async()=>[{title:'Borealis changelog',content:manualFact,scope:'owner',evidence:manualFact}]});
 for(let i=0;i<100&&manual.status==='running';i++){await new Promise(r=>setTimeout(r,10));manual=await L.getJob('auto-owner',manual.id);}
 assert.equal(manual.proposed,1);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE user_id='auto-owner'").get().n,1,'manual import remains pending even when the automatic switch is on');
 await A.configureAutomaticImport('auto-owner',{enabled:false,intervalMinutes:15},3602000);await A.runDueAutomaticImports({...opts,now:9000000});assert.equal(scans,2,'disabled schedules do no work');
 assert.equal((await call('GET','/api/memory/import/local/automatic',undefined,'li-user')).statusCode,403);
 assert.equal((await call('PUT','/api/memory/import/local/automatic',{enabled:true,intervalMinutes:1})).statusCode,400);
 await A.stopAutomaticProjectImports();
});


test('a failed checkpoint after skipping an imported source cannot advance its cursor twice', async t => {
 await L.stopLocalImports();
 const id = db.prepare("SELECT session_id FROM local_agent_imports WHERE user_id='li-owner' LIMIT 1").get().session_id;
 const fs = await import('node:fs/promises'); const real = fs.default.rename; let writes = 0;
 t.mock.method(fs.default, 'rename', async (from, to) => {
  if (String(to).includes('local-import-jobs') && String(to).endsWith('.json') && ++writes === 2) throw Object.assign(new Error('fixture write failure'), { code: 'EIO' });
  return real(from, to);
 });
 let job = await L.startImport('li-owner', [id], { home: dir, extract: async () => { throw Error('Already imported source extracted again'); } });
 for (let i=0; i<100 && job.status==='running'; i++) { await new Promise(r=>setTimeout(r,10)); job=await L.getJob('li-owner',job.id); }
 assert.equal(job.status, 'error'); assert.equal(job.done, 1); assert.equal(job.total, 1);
 await L.stopLocalImports();
 const { savedImports } = await loadFile(join(backendDir,'src/memory/import/local-import-store.ts'));
 const saved = (await savedImports()).find(j=>j.id===job.id); assert.equal(saved.cursor, 1); assert.equal(saved.ids.length, 1);
});
