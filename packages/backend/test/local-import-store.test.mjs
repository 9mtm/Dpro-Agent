import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const backend = process.cwd();
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dpro-journal-'));
process.env.AGENT_PLAYER_DATA_DIR = root;
const { saveImport, savedImports, replaceJournal } = await import(pathToFileURL(path.join(backend, 'src/memory/import/local-import-store.ts')).href);
test.after(() => fs.rm(root, { recursive: true, force: true }));
test('queued checkpoint writes preserve the state at submission rather than later mutable worker state', async () => {
  const job = { v: 1, id: randomUUID(), userId: 'fixture-owner', ids: ['a'.repeat(32)], cursor: 0, skipped: 0, total: 1, done: 0, proposed: 0, dropped: 0, status: 'running', startedAt: Date.now(), errors: 0 };
  const pending = saveImport(job); job.cursor = 999; await pending;
  assert.equal((await savedImports())[0].cursor, 0);
});
test('Windows sharing violations retain the previous journal until bounded atomic replacement succeeds', async () => {
  const target = path.join(root, 'previous'), temp = path.join(root, 'next');
  await fs.writeFile(target, 'previous'); await fs.writeFile(temp, 'next'); let calls = 0;
  const rename = async (from, to) => { calls++; if (calls < 3) { assert.equal(await fs.readFile(to, 'utf8'), 'previous'); throw Object.assign(new Error('busy'), { code: 'EPERM' }); } await fs.rename(from, to); };
  await replaceJournal(temp, target, { platform: 'win32', rename, delay: async () => {} });
  assert.equal(calls, 3); assert.equal(await fs.readFile(target, 'utf8'), 'next');
  calls = 0;
  await assert.rejects(() => replaceJournal(temp, target, { platform: 'win32', rename: async () => { calls++; throw Object.assign(new Error('busy'), { code: 'EACCES' }); }, delay: async () => {} }), { code: 'EACCES' });
  assert.equal(calls, 5); assert.equal(await fs.readFile(target, 'utf8'), 'next');
});
