import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readRegularFile, FileReadError } from '../src/services/read-regular-file.ts';
import { readFolderFile } from '../src/repositories/project-files.ts';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dpro-regular-file-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}

test('regular reads enforce byte limits, optional truncation, and the selected directory', async t => {
  const root = await fixture(t);
  const project = path.join(root, 'project'); await fs.mkdir(project);
  const file = path.join(project, 'text.txt'); await fs.writeFile(file, '0123456789');
  assert.equal((await readRegularFile(file, 10, { root: project })).data.toString(), '0123456789');
  await assert.rejects(readRegularFile(file, 4), /too large/);
  const short = await readRegularFile(file, 4, { truncate: true });
  assert.equal(short.data.toString(), '0123'); assert.equal(short.truncated, true);
  const outside = path.join(root, 'outside.txt'); await fs.writeFile(outside, 'outside fixture');
  await assert.rejects(readRegularFile(outside, 100, { root: project }), /outside/);
  assert.equal(await fs.readFile(file, 'utf8'), '0123456789');
});

test('replacing a pathname after open is rejected and its descriptor closes', async t => {
  const root = await fixture(t); const file = path.join(root, 'text.txt');
  await fs.writeFile(file, 'original fixture');
  const open = fs.open.bind(fs); let handle;
  const mock = t.mock.method(fs, 'open', async (...args) => {
    handle = await open(...args);
    await fs.rename(file, file+'.original');
    await fs.writeFile(file, 'replacement fixture');
    return handle;
  });
  try {
    await assert.rejects(readRegularFile(file, 100, { root }), FileReadError);
    await assert.rejects(handle.stat(), { code: 'EBADF' });
  } finally { mock.mock.restore(); }
  assert.equal(await fs.readFile(file, 'utf8'), 'replacement fixture');
});

test('project text previews preserve ordinary text, hidden files and traversal refusal', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'plain.txt'), 'project fixture');
  await fs.writeFile(path.join(root, '.env'), 'synthetic env content');
  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([1, 0, 2]));
  assert.equal((await readFolderFile(root, 'plain.txt')).text, 'project fixture');
  assert.equal((await readFolderFile(root, '.env')).hidden, true);
  assert.equal((await readFolderFile(root, 'binary.bin')).binary, true);
  await assert.rejects(readFolderFile(root, '../outside.txt'));
});

test('a harmless-looking link to an env file cannot expose its text in a project preview', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, '.env'), 'synthetic env content');
  try { await fs.symlink('.env', path.join(root, 'notes.txt'), 'file'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('File symlink privilege unavailable'); return; } throw error; }
  const result = await readFolderFile(root, 'notes.txt');
  assert.equal(result.hidden, true); assert.equal(result.text, null);
});
