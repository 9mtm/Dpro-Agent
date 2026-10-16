// Real process restart over a throwaway SQLite DB; no network or listeners.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const backend = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-chat-recovery-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.env.HOME = dir;
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'config');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.JWT_SECRET = randomBytes(64).toString('hex');
process.env.NODE_ENV = 'test';
process.env.AGENT_PLAYER_BACKGROUND = 'off';
process.env.AGENT_PLAYER_DB = 'sqlite';
process.chdir(dir);
globalThis.fetch = () => { throw Error('network is forbidden'); };
console.log = () => {}; console.warn = () => {}; console.error = () => {};
const { getDatabase } = await import(join(backend, 'src/db/database.ts'));
const db = getDatabase(); await db.initialize();
const { getCredentialStorage } = await import(join(backend, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
db.prepare("INSERT INTO users (id,email,username,password_hash,role,status,email_verified) VALUES ('rec-owner','rec@example.test','rec','x','owner','active',1)").run();
const repo = await import(join(backend, 'src/repositories/chat-conversations.ts'));
const recovery = await import(join(backend, 'src/repositories/chat-recovery.ts'));
const context = await import(join(backend, 'src/services/chat-run-context.ts'));
const { ToolsRegistry } = await import(join(backend, 'src/tools/registry.ts'));
const { defaultGrants } = await import(join(backend, 'src/tools/grants.ts'));
const grants = { ...defaultGrants(), tools: new Map([['x_effect', null]]) };
const registry = new ToolsRegistry({ userId: 'rec-owner', workspaceDir: dir, grants });
let effects = 0;
registry.register({ name: 'x_effect', description: 'synthetic effect', input_schema: { type: 'object' }, execute: async () => { effects++; return { content: [{ type: 'text', text: 'effect done' }] }; } });
const journal = (runId, sessionId) => ({ run_id: runId, session_id: sessionId, user_id: 'rec-owner', agent_id: null, started_at: Date.now() });

test('SIGKILL after a completed side effect and an unknown intent: restart reconciles once without replay', async () => {
  const c = await repo.createConversation('rec-owner', {});
  const r = journal('restart-real-0001', c.id);
  await recovery.acceptChatRun(r, 'Finish the synthetic task');
  // Child completes one checkpoint, then dies while the next action is uncertain.
  const code = `
    globalThis.fetch = () => { throw Error('network forbidden'); };
    console.log=()=>{}; console.warn=()=>{}; console.error=()=>{};
    const { journalContext } = await import(${JSON.stringify(join(backend, 'src/repositories/chat-recovery.ts'))});
    const { writeFileSync } = await import('node:fs');
    const ctx = journalContext(${JSON.stringify(r)}, false);
    const id = await ctx.beforeTool('x_effect', { path: 'output.txt' });
    writeFileSync(${JSON.stringify(join(dir, 'completed-effect'))}, 'once');
    await ctx.afterTool(id, { content: [{ type:'text', text:'wrote output.txt' }] });
    await ctx.beforeTool('x_effect', { path: 'uncertain.txt' });
    writeFileSync(${JSON.stringify(join(dir, 'unknown-effect'))}, 'once');
    process.kill(process.pid, 'SIGKILL');
  `;
  const child = spawnSync(process.execPath, ['--import', resolve(backend, 'node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', code], { env: process.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const recoverCode = `
    globalThis.fetch = () => { throw Error('network forbidden'); };
    console.log=()=>{}; console.warn=()=>{}; console.error=()=>{};
    const { recoverChatRuns } = await import(${JSON.stringify(join(backend, 'src/repositories/chat-recovery.ts'))});
    const n = await recoverChatRuns(); process.stdout.write(String(n));
  `;
  const restart = spawnSync(process.execPath, ['--import', resolve(backend, 'node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', recoverCode], { env: process.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(restart.status, 0, restart.stderr); assert.equal(restart.stdout, '1');
  assert.equal(await recovery.recoverChatRuns(), 0, 'a second recovery cannot duplicate the turn');
  const messages = await repo.listConversationMessages(c.id);
  assert.equal(messages.length, 2);
  const m = messages[1]; assert.equal(m.code, 'run_interrupted'); assert.equal(m.status, 'error');
  assert.equal(m.parts[0].calls.length, 2);
  assert.match(m.parts[0].calls[0].output, /wrote output.txt/);
  assert.match(m.parts[0].calls[1].output, /Outcome unknown/);
  assert.equal(effects, 0, 'recovery never invokes tools');
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(join(dir, 'completed-effect'), 'utf8'), 'once');
  assert.equal(readFileSync(join(dir, 'unknown-effect'), 'utf8'), 'once');
  assert.equal(await recovery.needsRecoveryReview(c.id), true);
  // Even a normally allowed tool now produces an approval, not an effect.
  const next = journal('restart-continue-0002', c.id); await recovery.acceptChatRun(next, 'Continue safely');
  const held = await context.withChatRun(recovery.journalContext(next, true), () => registry.execute('x_effect', {}));
  assert.equal(effects, 0); assert.match(JSON.stringify(held), /approval/i);
});

test('message and run acceptance is atomic; conflicting run ids cannot move messages between users', async () => {
  const a = await repo.createConversation('rec-owner', {}), b = await repo.createConversation('rec-owner', {});
  const r = journal('atomic-run-00001', a.id);
  await recovery.acceptChatRun(r, 'first');
  await assert.rejects(recovery.acceptChatRun({ ...r, session_id: b.id }, 'second'));
  assert.equal((await repo.listConversationMessages(b.id)).length, 0);
  await assert.rejects(recovery.acceptChatRun(journal('atomic-other-0001', a.id), 'busy'));
  assert.equal((await repo.listConversationMessages(a.id)).length, 1);
});

test('a completed stored turn is not changed to interrupted after a crash before journal finalization', async () => {
  await recovery.recoverChatRuns();
  const c = await repo.createConversation('rec-owner', {}), r = journal('saved-turn-00001', c.id);
  await recovery.acceptChatRun(r, 'hello');
  await repo.addAssistantMessage(c.id, { runId: r.run_id, content: 'done', parts: [], status: 'complete', durationMs: 10 });
  assert.equal(await recovery.recoverChatRuns(), 0);
  assert.equal((await repo.listConversationMessages(c.id)).length, 2);
  assert.equal(await recovery.needsRecoveryReview(c.id), false);
});

test('write-ahead tool records contain references, never raw secrets; failed journal blocks effects', async () => {
  const c = await repo.createConversation('rec-owner', {}), r = journal('secret-checkpoint-0001', c.id);
  await recovery.acceptChatRun(r, 'work');
  const key = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const ctx = recovery.journalContext(r, false);
  const id = await ctx.beforeTool('x_effect', { token: key });
  await ctx.afterTool(id, { content: [{ type: 'text', text: key }] });
  const row = db.prepare('SELECT input,output FROM chat_run_steps WHERE id = ?').get(id);
  assert.ok(!JSON.stringify(row).includes(key)); assert.match(JSON.stringify(row), /SECRET:/);
  const before = effects;
  const bad = recovery.journalContext(journal('missing-journal-0001', c.id), false);
  const result = await context.withChatRun(bad, () => registry.execute('x_effect', {}));
  assert.equal(effects, before); assert.ok(result.error);
});

test('journal failure after an effect latches the run closed; restart retains the unknown result', async () => {
  await recovery.recoverChatRuns();
  const c = await repo.createConversation('rec-owner', {}), r = journal('lost-result-00001', c.id);
  await recovery.acceptChatRun(r, 'do once');
  let failed = false;
  const ctx = recovery.journalContext(r, false, () => { failed = true; });
  // Keep the intent, then reject the result write as a real storage failure.
  db.exec("CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON chat_run_steps BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END");
  const before = effects;
  const first = await context.withChatRun(ctx, () => registry.execute('x_effect', {}));
  assert.ok(first.error); assert.equal(failed, true); assert.equal(effects, before + 1);
  const second = await context.withChatRun(ctx, () => registry.execute('x_effect', {}));
  assert.ok(second.error); assert.equal(effects, before + 1, 'no repeated side effect after checkpoint failure');
  db.exec('DROP TRIGGER fail_checkpoint');
  await repo.addAssistantMessage(c.id, { runId: r.run_id, content: 'Checkpoint failed', parts: [], status: 'error', durationMs: 10 });
  assert.equal(await recovery.recoverChatRuns(), 1);
  const messages = await repo.listConversationMessages(c.id);
  assert.equal(messages.length, 2); assert.equal(messages[1].code, 'run_interrupted');
  assert.match(messages[1].content, /OUTCOME UNKNOWN/);
});

test('authenticated chat reopening reconciles automatically and can continue with tools held for review', async () => {
  await recovery.recoverChatRuns();
  mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
  const { getOrchestrator } = await import(join(backend, 'src/multi-agent/index.ts'));
  await getOrchestrator().initialize(join(dir, '.data', 'multi-agent', 'orchestrator.db'));
  const tools = await import(join(backend, 'src/tools/index.ts'));
  const { setAgentGrants } = await import(join(backend, 'src/tools/grants.ts'));
  let replayed = 0;
  tools.registerExtensionTool({ name: 'x_recovery_effect', extensionId: 'recovery-test', description: 'synthetic effect', input_schema: { type: 'object', properties: {} }, execute: async () => { replayed++; return { content: [{ type: 'text', text: 'done' }] }; } });
  db.prepare("INSERT INTO agents_config (id,name,provider,model,is_primary) VALUES ('rec-agent','Recovery agent','ollama','recovery-test',1)").run();
  await setAgentGrants('rec-agent', { grants: ['x_recovery_effect'] }, 'rec-owner', tools.createToolsRegistry({ workspaceDir: dir }).listRegistered());
  const c = await repo.createConversation('rec-owner', { agentId: 'rec-agent' });
  const r = journal('route-restart-0001', c.id); await recovery.acceptChatRun(r, 'Finish the original task');
  const checkpoint = recovery.journalContext(r, false);
  await checkpoint.beforeTool('x_recovery_effect', {});
  const { buildServer } = await import(join(backend, 'src/api/app.ts'));
  const { generateToken } = await import(join(backend, 'src/auth/jwt.ts'));
  const { chatRuns } = await import(join(backend, 'src/services/chat-runs.ts'));
  const app = await buildServer({ logger: false }); await app.ready();
  const headers = { authorization: `Bearer ${generateToken('rec-owner', 1)}` };
  const url = `/api/chat/conversations/${c.id}/messages`;
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
  assert.equal(db.prepare('SELECT state FROM chat_run_journal WHERE run_id = ?').get(r.run_id).state, 'running', 'anonymous traffic cannot trigger reconciliation');
  const reopened = (await app.inject({ method: 'GET', url, headers })).json();
  assert.equal(reopened.activeRunId, null); assert.equal(reopened.messages.at(-1).code, 'run_interrupted');
  let n = 0; const modelRequests = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:11434/api/chat');
    modelRequests.push(JSON.parse(init.body));
    const frames = n++ === 0 ? [{ message: { tool_calls: [{ function: { name: 'x_recovery_effect', arguments: {} } }] } }, { done: true }]
      : [{ message: { content: 'I need your approval before continuing.' } }, { done: true }];
    return new Response(frames.map(f => JSON.stringify(f)).join('\n') + '\n');
  };
  const runId = 'route-continue-0002';
  const accepted = await app.inject({ method: 'POST', url: `/api/chat/conversations/${c.id}/runs`, headers, payload: { runId, message: 'Continue safely' } });
  assert.equal(accepted.statusCode, 202, accepted.body);
  const run = chatRuns.get(runId); if (run.status === 'running') await new Promise(resolve => run.emitter.once('end', resolve));
  assert.equal(replayed, 0);
  assert.match(JSON.stringify(modelRequests[0]), /OUTCOME UNKNOWN/);
  assert.match(JSON.stringify(modelRequests[1]), /approval/i);
  const stored = (await app.inject({ method: 'GET', url, headers })).json().messages;
  assert.equal(stored.length, 4); assert.equal(stored.at(-1).content, 'I need your approval before continuing.');
  const pending = (await app.inject({ method: 'GET', url: '/api/approvals?status=pending', headers })).json().approvals.find(a => a.sessionId === c.id);
  assert.ok(pending);
  const detail = (await app.inject({ method: 'GET', url: `/api/approvals/${pending.id}`, headers })).json().approval;
  const approved = await app.inject({ method: 'POST', url: `/api/approvals/${pending.id}/approve`, headers, payload: { paramsHash: detail.paramsHash } });
  assert.equal(approved.statusCode, 200, approved.body); assert.equal(replayed, 1);
  assert.equal((await app.inject({ method: 'POST', url: `/api/approvals/${pending.id}/approve`, headers, payload: { paramsHash: detail.paramsHash } })).statusCode, 409);
  assert.equal(replayed, 1, 'owner approval executes exactly once');
  assert.match(await recovery.recoveryApprovalResults('rec-owner', c.id), /x_recovery_effect/);
  await app.close();
});
