import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadSession, loadInstance, NOT_SIGNED_IN, NO_INSTANCE } from '../src/session.ts';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpro-session-file-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { root, env: { AGENT_PLAYER_CONFIG_DIR: root } };
}

for (const kind of ['session', 'instance']) test(`a ${kind} path swap cannot replace the file whose permissions were checked`, t => {
  const { root, env } = fixture(t);
  const original = kind === 'session'
    ? { createdBy: 'agent-player-cli', token: 'fixture-'+randomBytes(8).toString('hex') }
    : { createdBy: 'agent-player-backend', id: 'fixture-instance', secret: randomBytes(32).toString('hex') };
  const file = path.join(root, kind === 'session' ? 'auth.json' : 'instance.json');
  fs.writeFileSync(file, JSON.stringify(original), { mode: 0o600 });
  const fstat = fs.fstatSync;
  const mock = t.mock.method(fs, 'fstatSync', fd => {
    const stat = fstat(fd);
    fs.renameSync(file, file+'.original');
    fs.writeFileSync(file, JSON.stringify({ ...original, token: 'replacement', id: 'replacement' }), { mode: 0o644 });
    return stat;
  });
  try {
    const loaded = kind === 'session' ? loadSession(env) : loadInstance(env);
    if (kind === 'session') assert.equal(loaded.token, original.token);
    else assert.deepEqual(loaded, { id: original.id, secret: original.secret });
  } finally { mock.mock.restore(); }
  if (process.platform !== 'win32') assert.throws(() => kind === 'session' ? loadSession(env) : loadInstance(env), /readable by other users/);
});

test('oversized cached JSON is refused without changing either file', t => {
  const { root, env } = fixture(t);
  for (const file of ['auth.json', 'instance.json']) fs.writeFileSync(path.join(root, file), ' '.repeat(65537), { mode: 0o600 });
  assert.throws(() => loadSession(env), error => error.message === NOT_SIGNED_IN);
  assert.throws(() => loadInstance(env), error => error.message === NO_INSTANCE);
  assert.equal(fs.statSync(path.join(root, 'auth.json')).size, 65537);
  assert.equal(fs.statSync(path.join(root, 'instance.json')).size, 65537);
});
