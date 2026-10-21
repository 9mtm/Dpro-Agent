// Release check (CORE-MEM): memories survive a backend restart. A backend
// is started on a temp data dir, memories are written over HTTP and it
// exits; a second backend process on the same data dir reads them back
// (content, drawer, topic key, version history) and keeps using them.
// Run: node --import tsx --test test/memory-restart.test.mjs
// Throwaway data dir + random test-only secrets; offline hash embeddings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-memrestart-'));
mkdirSync(join(dir, '.data'), { recursive: true });
const env = {
  PATH: process.env.PATH,
  HOME: dir,
  DATABASE_PATH: join(dir, '.data', 'agent-player.db'),
  JWT_SECRET: randomBytes(64).toString('hex'), // throwaway, test only
  ENCRYPTION_KEY: randomBytes(32).toString('hex'), // throwaway, test only
  MEMORY_EMBEDDINGS: 'hash',
};
test.after(() => rmSync(dir, { recursive: true, force: true }));

function boot(mode) {
  // tsx resolved from the backend (the child runs in the temp data dir).
  const stdout = execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(backendDir, 'test/fixtures/memory-restart-server.mjs'), mode, backendDir], {
    cwd: dir, env, encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `no result from the ${mode} boot`);
  return JSON.parse(line.slice('RESULT '.length));
}

test('memories written by one backend process are read back by the next one on the same data', () => {
  const w = boot('write');
  assert.equal(w.a.status, 200, JSON.stringify(w.a.body));
  assert.equal(w.b.body.updatedExisting, true);
  assert.equal(w.c.status, 200, JSON.stringify(w.c.body));
  const id = w.a.body.memory.id;
  assert.ok(readdirSync(join(dir, '.data')).some((f) => f.startsWith('agent-player.db')));

  const r = boot('read');
  assert.equal(r.list.status, 200);
  const byContent = Object.fromEntries(r.list.body.memories.map((m) => [m.content, m]));
  const topic = byContent['Restart check: deploy day is Friday'];
  assert.ok(topic, 'the topic memory survived with its latest text');
  assert.equal(topic.id, id);
  assert.equal(topic.topicKey, 'deploy-day');
  assert.equal(byContent['Restart check: deploy day is Thursday'], undefined, 'no near-duplicate');
  const pref = byContent['Restart check: answers in Arabic'];
  assert.deepEqual(pref.drawer, { kind: 'project', key: 'alpha' });
  assert.ok(r.drawers.body.drawers.some((d) => d.kind === 'project' && d.key === 'alpha'));
  assert.deepEqual(r.versions.body.versions.map((v) => [v.change, v.content]), [
    ['create', 'Restart check: deploy day is Thursday'],
    ['update', 'Restart check: deploy day is Friday'],
  ]);
  // The restarted backend keeps updating the same memory by its topic key.
  assert.equal(r.again.body.updatedExisting, true);
  assert.equal(r.again.body.memory.id, id);
  assert.equal(r.doctor.status, 200);
  assert.equal(r.doctor.body.counts.duplicate, 0);
  assert.equal(r.doctor.body.counts['embedding-missing'], 0);
});
