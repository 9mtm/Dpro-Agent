// CHAT-REBUILD-01: saved conversations and runs that outlive the page.
//  - a run streams numbered events (reasoning, tools, text, end) and stores the
//    user and assistant turns with their work; the first message names the chat;
//  - a reader can re-attach with after=N; Stop keeps the partial reply ("stopped");
//  - the model gets the stored history, not a client-sent one;
//  - other users get 404; a guest is refused; a busy chat answers 409; a repeated
//    runId does not run twice.
// Throwaway DB/keys; the local model is stubbed (no network).
// Run: node --import tsx --test test/chat-runs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-chat-runs-'));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
for (const k of ['AGENT_EXEC_TOOLS', 'OLLAMA_THINK', 'DEFAULT_MODEL']) delete process.env[k];

// --- stubbed local model: a queue of scripted replies (NDJSON lines) ---------
const script = [];
const bodies = [];
let hold = null; // when set, the next reply waits for hold.release()
globalThis.fetch = async (url, init = {}) => {
  if (String(url) !== 'http://127.0.0.1:11434/api/chat') throw new Error(`unexpected network call in test: ${url}`);
  bodies.push(JSON.parse(init.body));
  // 'missing' = the local model server answers 404 (the model is not installed).
  if (script[0] === 'missing') { script.shift(); return new Response(JSON.stringify({ error: 'model not found' }), { status: 404 }); }
  const lines = script.shift() ?? [{ message: { content: 'ok' }, done: true }];
  const enc = new TextEncoder();
  const h = hold;
  return new Response(new ReadableStream({
    async start(c) {
      c.enqueue(enc.encode(JSON.stringify(lines[0]) + '\n'));
      if (h) await new Promise((r) => { h.release = r; init.signal?.addEventListener('abort', r); });
      if (init.signal?.aborted) { c.error(new DOMException('aborted', 'AbortError')); return; }
      for (const l of lines.slice(1)) c.enqueue(enc.encode(JSON.stringify(l) + '\n'));
      c.close();
    },
  }), { status: 200 });
};

const capture = () => {};
console.log = capture; console.info = capture; console.warn = capture;

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const { getOrchestrator } = await import(join(backendDir, 'src/multi-agent/index.ts'));
await getOrchestrator().initialize(join(dir, '.data', 'multi-agent', 'orchestrator.db'));
for (const [id, role] of [['r-owner', 'owner'], ['r-other', 'user'], ['r-guest', 'guest']]) {
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, 'active', 1)`).run(id, `${id}@example.test`, id, role);
}
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('r-agent', 'Run Agent', 'ollama', 'qwen-test', 1)`).run();
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('r-claude', 'Claude Agent', 'claude', 'claude-sonnet-test', 0)`).run();

const tools = await import(join(backendDir, 'src/tools/index.ts'));
const grants = await import(join(backendDir, 'src/tools/grants.ts'));
const echoed = [];
tools.registerExtensionTool({ name: 'x_echo', description: 'echo', extensionId: 'x', requiresApproval: false,
  input_schema: { type: 'object', properties: { text: { type: 'string' } } },
  execute: async (p) => { echoed.push(p.text); return { content: [{ type: 'text', text: `echo: ${p.text}` }] }; } });
const avail = tools.createToolsRegistry({ workspaceDir: dir }).listRegistered();
await grants.setAgentGrants('r-agent', { grants: ['x_echo', 'read'] }, 'r-owner', avail);

const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const { chatRuns } = await import(join(backendDir, 'src/services/chat-runs.ts'));
const { historyFor } = await import(join(backendDir, 'src/api/routes/chat-conversations.ts'));
const app = await buildServer({ logger: false });
await app.ready();
const as = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const call = (user, method, url, payload) => app.inject({ method, url, headers: as(user), ...(payload ? { payload } : {}) });
const frames = (body) => body.split('\n\n').filter((b) => b.includes('data:')).map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data:')).slice(5)));
const ended = (runId) => new Promise((r) => { const run = chatRuns.get(runId); if (run.status !== 'running') r(); else run.emitter.once('end', r); });
const rid = () => `run-${randomBytes(6).toString('hex')}`;

test('a run streams reasoning, tools and text, then stores both turns with their work', async () => {
  const c = (await call('r-owner', 'POST', '/api/chat/conversations', {})).json().conversation;
  script.push(
    [{ message: { thinking: 'I should echo.' } }, { message: { content: '', tool_calls: [{ function: { name: 'x_echo', arguments: { text: 'hi' } } }] } }, { done: true }],
    [{ message: { content: 'All ' } }, { message: { content: 'done.' } }, { done: true }],
  );
  const runId = rid();
  const start = await call('r-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId, message: 'Echo hi please\nsecond line' });
  assert.equal(start.statusCode, 202);
  await ended(runId);
  const ev = frames((await call('r-owner', 'GET', `/api/chat/runs/${runId}/events`)).body);
  assert.deepEqual(ev.map((f) => f.type), ['reasoning', 'tool_start', 'tool_result', 'text', 'text', 'end']);
  assert.deepEqual(ev.map((f) => f.seq), [1, 2, 3, 4, 5, 6]);
  assert.ok(ev.every((f) => Number.isFinite(f.at) && f.at >= 0), 'every event carries its time since the run started');
  assert.equal(ev[1].tools[0].name, 'x_echo');
  assert.equal(ev[2].results[0].output, 'echo: hi');
  assert.equal(ev.at(-1).status, 'complete');
  assert.deepEqual(echoed, ['hi']);

  const after = frames((await call('r-owner', 'GET', `/api/chat/runs/${runId}/events?after=4`)).body);
  assert.deepEqual(after.map((f) => f.seq), [5, 6]);

  const m = (await call('r-owner', 'GET', `/api/chat/conversations/${c.id}/messages`)).json();
  assert.equal(m.conversation.title, 'Echo hi please');
  assert.equal(m.activeRunId, null);
  assert.deepEqual(m.messages.map((x) => [x.role, x.content, x.status]), [['user', 'Echo hi please\nsecond line', 'complete'], ['assistant', 'All done.', 'complete']]);
  assert.deepEqual(m.messages[1].parts.map((p) => p.kind), ['reasoning', 'tools', 'text']);
  assert.ok(Number.isFinite(m.messages[1].parts[0].ms), 'the thinking time is stored');
  assert.equal(m.messages[1].parts[1].calls[0].output, 'echo: hi');
  assert.ok(m.messages[1].durationMs >= 0);

  // The next turn gives the model the stored history (not anything from the client).
  script.push([{ message: { content: 'Second.' } }, { done: true }]);
  const r2 = rid();
  bodies.length = 0;
  await call('r-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId: r2, message: 'And again' });
  await ended(r2);
  const sent = bodies[0].messages.filter((x) => x.role !== 'system').map((x) => [x.role, x.content]);
  assert.deepEqual(sent, [['user', 'Echo hi please\nsecond line'], ['assistant', 'All done.'], ['user', 'And again']]);
  // Repeating a finished runId does not run it again.
  const again = await call('r-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId: r2, message: 'And again' });
  assert.equal(again.statusCode, 202);
  assert.equal(again.json().replayed, true);
  assert.equal((await call('r-owner', 'GET', `/api/chat/conversations/${c.id}/messages`)).json().messages.length, 4);
});

test('Stop keeps the partial reply as stopped; a busy chat refuses a second run', async () => {
  const c = (await call('r-owner', 'POST', '/api/chat/conversations', { title: 'Long one' })).json().conversation;
  hold = {};
  script.push([{ message: { content: 'Partial answer' } }, { message: { content: ' never sent' } }, { done: true }]);
  const runId = rid();
  await call('r-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId, message: 'Write a lot' });
  const h = hold;
  for (let i = 0; i < 400 && !h.release; i++) await new Promise((r) => setTimeout(r, 5));
  hold = null;
  assert.ok(h.release, 'the model was reached');
  const list = (await call('r-owner', 'GET', `/api/chat/conversations/${c.id}/messages`)).json();
  assert.equal(list.activeRunId, runId);
  const busy = await call('r-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId: rid(), message: 'more' });
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.json().code, 'conversation_busy');
  assert.equal((await call('r-other', 'POST', `/api/chat/runs/${runId}/stop`)).statusCode, 404);
  assert.equal((await call('r-owner', 'POST', `/api/chat/runs/${runId}/stop`)).statusCode, 200);
  await ended(runId);
  const m = (await call('r-owner', 'GET', `/api/chat/conversations/${c.id}/messages`)).json();
  assert.equal(m.conversation.title, 'Long one'); // a given title is kept
  assert.deepEqual([m.messages[1].content, m.messages[1].status], ['Partial answer', 'stopped']);
  const ev = frames((await call('r-owner', 'GET', `/api/chat/runs/${runId}/events`)).body);
  assert.equal(ev.at(-1).status, 'stopped');
});

test('conversations are private; guests are refused; inputs are checked', async () => {
  const c = (await call('r-owner', 'POST', '/api/chat/conversations', {})).json().conversation;
  for (const [m, u, p] of [['GET', `/api/chat/conversations/${c.id}/messages`], ['PUT', `/api/chat/conversations/${c.id}`, { title: 'x' }],
    ['DELETE', `/api/chat/conversations/${c.id}`], ['POST', `/api/chat/conversations/${c.id}/runs`, { runId: rid(), message: 'hi' }]]) {
    assert.equal((await call('r-other', m, u, p)).statusCode, 404, `${m} ${u}`);
  }
  assert.equal((await call('r-other', 'GET', '/api/chat/conversations')).json().conversations.length, 0);
  assert.equal((await call('r-guest', 'GET', '/api/chat/conversations')).statusCode >= 401, true);
  assert.equal((await app.inject({ method: 'GET', url: '/api/chat/conversations' })).statusCode, 401);
  assert.equal((await call('r-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId: 'short', message: 'hi' })).statusCode, 400);
  assert.equal((await call('r-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId: rid(), message: '   ' })).statusCode, 400);
  // Rename, pin (pinned first), delete.
  const d = (await call('r-owner', 'POST', '/api/chat/conversations', { title: 'Pin me' })).json().conversation;
  assert.equal((await call('r-owner', 'PUT', `/api/chat/conversations/${d.id}`, { pinned: true, title: 'Pinned' })).json().conversation.pinned, true);
  assert.equal((await call('r-owner', 'GET', '/api/chat/conversations')).json().conversations[0].title, 'Pinned');
  assert.equal((await call('r-owner', 'DELETE', `/api/chat/conversations/${d.id}`)).statusCode, 200);
  assert.equal((await call('r-owner', 'GET', `/api/chat/conversations/${d.id}/messages`)).statusCode, 404);
});

test('historyFor keeps the newest turns within budget and starts with the user', () => {
  const msg = (role, content, status = 'complete') => ({ role, content, status });
  const h = historyFor([msg('assistant', 'orphan'), msg('user', 'a'.repeat(50)), msg('assistant', 'b'.repeat(50)), msg('user', 'c'.repeat(50)), msg('assistant', 'part', 'stopped'), msg('user', 'now')], 120);
  assert.deepEqual(h.map((t) => t.role), ['user', 'assistant', 'user']);
  assert.match(h[1].content, /stopped by the user/);
  assert.equal(h.at(-1).content, 'now');
});

test('an agent set to Claude with no key answers with the local model', async () => {
  const c = (await call('r-owner', 'POST', '/api/chat/conversations', { agentId: 'r-claude' })).json().conversation;
  script.push([{ message: { content: 'Local answer.' } }, { done: true }]);
  bodies.length = 0;
  const runId = rid();
  await call('r-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId, message: 'hello' });
  await ended(runId);
  assert.equal(bodies[0].model, 'qwen3.5:9b');
  const m = (await call('r-owner', 'GET', `/api/chat/conversations/${c.id}/messages`)).json();
  assert.equal(m.messages.at(-1).content, 'Local answer.');
});

test('a local model that is not installed ends the run with local_model_missing', async () => {
  const c = (await call('r-owner', 'POST', '/api/chat/conversations', { agentId: 'r-claude' })).json().conversation;
  script.push('missing');
  const runId = rid();
  await call('r-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId, message: 'hello' });
  await ended(runId);
  const ev = frames((await call('r-owner', 'GET', `/api/chat/runs/${runId}/events`)).body);
  assert.deepEqual([ev.at(-1).type, ev.at(-1).status, ev.at(-1).code], ['end', 'error', 'local_model_missing']);
});

test('a run can pick a local model; a bad model id is refused', async () => {
  const c = (await call('r-owner', 'POST', '/api/chat/conversations', { agentId: 'r-claude' })).json().conversation;
  script.push([{ message: { content: 'From the picked model.' } }, { done: true }]);
  bodies.length = 0;
  const runId = rid();
  const r = await call('r-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId, message: 'hi', model: 'llama3.2:3b' });
  assert.equal(r.statusCode, 202);
  await ended(runId);
  assert.equal(bodies[0].model, 'llama3.2:3b', 'the picked local model is used even for an agent set to Claude');
  assert.equal((await call('r-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId: rid(), message: 'x', model: '../x' })).statusCode, 400);
});

test('projects: owner only, real folders only, a run reads the project folder and gets the project note', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const folder = join(dir, 'proj-app'); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'README.md'), 'Project readme: build with care.');
  assert.equal((await call('r-other', 'POST', '/api/chat/projects', { name: 'X' })).statusCode, 403, 'projects are owner only');
  for (const bad of [{ name: 'A', folder: 'relative/path' }, { name: 'A', folder: join(dir, 'missing') }, { name: 'A', folder: '/' }, { name: '  ' }, { name: 'A', repoUrl: 'file:///etc' }]) {
    const r = await call('r-owner', 'POST', '/api/chat/projects', bad);
    assert.equal(r.statusCode, 400, JSON.stringify(bad));
    assert.equal(r.json().code, 'invalid_project');
  }
  const p = (await call('r-owner', 'POST', '/api/chat/projects', { name: 'My App', folder, repoUrl: 'https://github.com/example/app' })).json().project;
  assert.equal(p.slug, 'my-app');
  assert.equal((await call('r-owner', 'GET', `/api/chat/projects/${p.id}/git`)).json().git.branch, null, 'not a git folder');
  const c = (await call('r-owner', 'POST', '/api/chat/conversations', { projectId: p.id })).json().conversation;
  assert.equal(c.projectId, p.id);
  script.push(
    [{ message: { tool_calls: [{ function: { name: 'read', arguments: { path: 'README.md' } } }] } }, { done: true }],
    [{ message: { content: 'Read it.' } }, { done: true }],
  );
  bodies.length = 0;
  const runId = rid();
  await call('r-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId, message: 'read the readme' });
  await ended(runId);
  const ev = frames((await call('r-owner', 'GET', `/api/chat/runs/${runId}/events`)).body);
  assert.match(ev.find((f) => f.type === 'tool_result').results[0].output, /Project readme: build with care/);
  assert.match(bodies[0].messages[0].content, /You are working in the project "My App"/);
  assert.equal((await call('r-owner', 'DELETE', `/api/chat/projects/${p.id}`)).statusCode, 200);
  assert.equal((await call('r-owner', 'GET', `/api/chat/conversations/${c.id}/messages`)).json().conversation.projectId, null, 'conversations stay, without the project');
});

test('project panes: per-file changes, a diff, the folder listing and a file, all inside the folder', async () => {
  const { mkdirSync, writeFileSync, symlinkSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const folder = join(dir, 'proj-panes'); mkdirSync(join(folder, 'src'), { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', folder, ...a], { env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' } });
  writeFileSync(join(folder, 'src', 'a.ts'), 'one\ntwo\n'); writeFileSync(join(folder, '.env'), 'SECRET=x\n');
  g('init', '-q'); g('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'add', 'src/a.ts'); g('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
  writeFileSync(join(folder, 'src', 'a.ts'), 'one\nTWO\nthree\n'); writeFileSync(join(folder, 'new.md'), 'hello\nworld\n');
  symlinkSync('/etc/hosts', join(folder, 'escape'));
  const p = (await call('r-owner', 'POST', '/api/chat/projects', { name: 'Panes', folder })).json().project;
  const base = `/api/chat/projects/${p.id}`;
  assert.equal((await call('r-other', 'GET', `${base}/changes`)).statusCode, 403, 'owner only');
  const ch = (await call('r-owner', 'GET', `${base}/changes`)).json();
  const a = ch.changes.find((c) => c.path === 'src/a.ts'); const n = ch.changes.find((c) => c.path === 'new.md');
  assert.deepEqual([a.status, a.added, a.removed], ['modified', 2, 1]);
  assert.deepEqual([n.status, n.added, n.removed], ['untracked', 2, 0]);
  assert.match((await call('r-owner', 'GET', `${base}/diff?path=src%2Fa.ts`)).json().diff, /^\+TWO$/m);
  assert.match((await call('r-owner', 'GET', `${base}/diff?path=new.md`)).json().diff, /^\+world$/m);
  assert.equal((await call('r-owner', 'GET', `${base}/diff?path=.env`)).json().hidden, true, 'secret files are never shown');
  const tree = (await call('r-owner', 'GET', `${base}/tree`)).json();
  assert.deepEqual(tree.entries.map((e) => e.name), ['src', '.env', 'new.md'], 'folders first; .git and links outside are left out');
  assert.equal((await call('r-owner', 'GET', `${base}/file?path=src%2Fa.ts`)).json().text, 'one\nTWO\nthree\n');
  assert.equal((await call('r-owner', 'GET', `${base}/file?path=.env`)).json().text, null);
  for (const bad of ['..%2F..%2Fetc%2Fhosts', '%2Fetc%2Fhosts', 'escape']) assert.equal((await call('r-owner', 'GET', `${base}/file?path=${bad}`)).statusCode, 400, bad);
  assert.equal((await call('r-owner', 'GET', `${base}/file?path=missing.txt`)).statusCode, 400);
});

test('microphone: owner only, base64 audio only, unknown containers refused before any program runs', async () => {
  assert.equal((await call('r-other', 'POST', '/api/chat/transcribe', { audio: 'AAAA' })).statusCode, 403);
  const st = (await call('r-owner', 'GET', '/api/chat/transcribe')).json();
  assert.equal(typeof st.available, 'boolean');
  assert.equal((await call('r-owner', 'POST', '/api/chat/transcribe', { audio: 'not base64!' })).statusCode, 400);
  assert.equal((await call('r-owner', 'POST', '/api/chat/transcribe', { audio: 'AAAA', language: 'xx' })).statusCode, 400);
  const r = await call('r-owner', 'POST', '/api/chat/transcribe', { audio: Buffer.from('plain text, not audio at all').toString('base64') });
  assert.ok([400, 503].includes(r.statusCode), `got ${r.statusCode}`);
  const { audioKind } = await import(new URL('../src/services/local-stt.ts', import.meta.url).href);
  assert.equal(audioKind(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])), 'webm');
  assert.equal(audioKind(Buffer.from('OggS________')), 'ogg');
  assert.equal(audioKind(Buffer.from('#!/bin/sh echo')), null);
});

test('git status: upstream with ahead/behind from local refs, last commit, github links only for github remotes', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' };
  const id = ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid'];
  const bare = join(dir, 'origin.git'); const work = join(dir, 'proj-gh');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env });
  mkdirSync(work, { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', work, ...a], { env }).toString();
  g('init', '-q', '-b', 'main'); writeFileSync(join(work, 'a.txt'), 'a'); g('add', '.'); g(...id, 'commit', '-qm', 'first');
  g('remote', 'add', 'origin', bare); g('push', '-q', '-u', 'origin', 'main');
  g('checkout', '-q', '-b', 'feature/x'); g('push', '-q', '-u', 'origin', 'feature/x');
  writeFileSync(join(work, 'b.txt'), 'b'); g('add', '.'); g(...id, 'commit', '-qm', 'second one');
  g('remote', 'set-head', 'origin', 'main');
  const { gitInfo, githubRepo } = await import(new URL('../src/repositories/chat-conversations.ts', import.meta.url).href);
  const info = await gitInfo(work);
  assert.equal(info.branch, 'feature/x'); assert.equal(info.upstream, 'origin/feature/x');
  assert.deepEqual([info.ahead, info.behind], [1, 0]);
  assert.equal(info.defaultBranch, 'main'); assert.equal(info.lastCommit.subject, 'second one');
  assert.equal(info.github, null, 'a non-github remote gets no github links');
  assert.deepEqual(githubRepo('git@github.com:o/r.git'), { owner: 'o', repo: 'r' });
  assert.equal(githubRepo('https://gitlab.com/o/r'), null);
});

test('task plan: every agent may call plan_steps (no grant); the steps travel in the run events; bad plans are refused', async () => {
  const c = (await call('r-owner', 'POST', '/api/chat/conversations', {})).json().conversation;
  const steps = [{ title: 'Read the notes', status: 'done' }, { title: 'Write the summary', status: 'active' }, { title: 'Check it', status: 'pending' }];
  script.push(
    [{ message: { tool_calls: [{ function: { name: 'plan_steps', arguments: { steps } } }] } }, { done: true }],
    [{ message: { content: 'Working on it.' } }, { done: true }],
  );
  bodies.length = 0;
  const runId = rid();
  await call('r-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId, message: 'summarise the notes in three steps' });
  await ended(runId);
  assert.ok(bodies[0].tools.some((t) => t.function?.name === 'plan_steps'), 'the model is offered plan_steps');
  assert.match(bodies[0].messages[0].content, /call plan_steps/);
  assert.match(bodies[0].messages[0].content, /## Rich answers/, 'the new chat gets the display-only set');
  assert.doesNotMatch(bodies[0].messages[0].content, /```notify|InputField|SupportChatBlock/, 'no forms or simulated notifications');
  const ev = frames((await call('r-owner', 'GET', `/api/chat/runs/${runId}/events`)).body);
  const start = ev.find((f) => f.type === 'tool_start');
  assert.equal(start.tools[0].name, 'plan_steps');
  assert.deepEqual(JSON.parse(start.tools[0].input).steps, steps);
  assert.match(ev.find((f) => f.type === 'tool_result').results[0].output, /Plan shown to the owner: 1\/3 done; now: Write the summary/);
  const { planSteps } = await import(new URL('../src/tools/plan/plan-steps.ts', import.meta.url).href);
  assert.equal(typeof planSteps([{ title: 'a', status: 'active' }, { title: 'b', status: 'active' }]), 'string', 'one active step at a time');
  assert.equal(typeof planSteps(Array.from({ length: 13 }, (_, i) => ({ title: `s${i}`, status: 'pending' }))), 'string');
});

test('team chat: another agent can write the next reply; it is stored per reply and earlier replies are named', async () => {
  const { getDatabase } = await import(new URL('../src/db/database.ts', import.meta.url).href);
  const db = getDatabase();
  for (const [id, name] of [['team-a', 'Nora'], ['team-b', 'Omar']]) db.prepare("INSERT OR IGNORE INTO agents_config (id, name, provider, model) VALUES (?, ?, 'local', 'llama3.2:3b')").run(id, name);
  const c = (await call('r-owner', 'POST', '/api/chat/conversations', { agentId: 'team-a' })).json().conversation;
  script.push([{ message: { content: 'Nora here: draft ready.' } }, { done: true }]);
  const r1 = rid(); await call('r-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId: r1, message: 'draft it' }); await ended(r1);
  script.push([{ message: { content: 'Omar: reviewed.' } }, { done: true }]);
  bodies.length = 0;
  const r2 = rid();
  const res = await call('r-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId: r2, message: '@Omar review it', agentId: 'team-b' });
  assert.equal(res.statusCode, 202, res.body); await ended(r2);
  const msgs = bodies[0].messages;
  assert.ok(msgs.some((m) => m.role === 'assistant' && m.content.startsWith('[Nora] Nora here')), 'the earlier reply is named');
  assert.match(msgs[0].content, /Several agents of the team answer/);
  const stored = (await call('r-owner', 'GET', `/api/chat/conversations/${c.id}/messages`)).json().messages.filter((m) => m.role === 'assistant');
  assert.deepEqual(stored.map((m) => m.agentId), [null, 'team-b']);
  assert.equal((await call('r-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId: rid(), message: 'x', agentId: 'nobody' })).statusCode, 400);
  assert.equal((await call('r-other', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId: rid(), message: 'x', agentId: 'team-b' })).statusCode, 404, 'not their conversation');
});
