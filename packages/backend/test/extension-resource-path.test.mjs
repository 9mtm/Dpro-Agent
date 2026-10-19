import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extensionResourcePath } from '../src/plugins/resource-path.ts';

test('extension resources remain inside their own directory, including symlink targets', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpro-extension-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const extension = path.join(root, 'extension');
  const locale = path.join(extension, 'i18n', 'en.json');
  fs.mkdirSync(path.dirname(locale), { recursive: true });
  fs.writeFileSync(locale, '{"title":"fixture"}');
  assert.equal(extensionResourcePath(extension, 'i18n/en.json'), fs.realpathSync(locale));
  assert.equal(extensionResourcePath(extension, 'optional.json'), path.join(extension, 'optional.json'));
  assert.throws(() => extensionResourcePath(extension, '../outside.json'), /outside/);
  assert.throws(() => extensionResourcePath(extension, path.resolve(root, 'outside.json')), /Invalid/);
  assert.throws(() => extensionResourcePath(extension, 'i18n\0/en.json'), /Invalid/);
  const outside = path.join(root, 'outside.json'); fs.writeFileSync(outside, '{}');
  try {
    fs.symlinkSync(outside, path.join(extension, 'i18n', 'escape.json'), 'file');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return;
    throw error;
  }
  assert.throws(() => extensionResourcePath(extension, 'i18n/escape.json'), /outside/);
});

test('permission manifests cannot escape the extensions root or grant string-shaped permissions', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpro-manifest-path-'));
  const originalCwd = process.cwd();
  const oldData = process.env.AGENT_PLAYER_DATA_DIR;
  const oldDatabase = process.env.DATABASE_PATH;
  process.chdir(root);
  process.env.AGENT_PLAYER_DATA_DIR = path.join(root, 'data');
  process.env.DATABASE_PATH = path.join(root, 'data', 'test.db');
  t.after(() => {
    process.chdir(originalCwd);
    if (oldData === undefined) delete process.env.AGENT_PLAYER_DATA_DIR; else process.env.AGENT_PLAYER_DATA_DIR = oldData;
    if (oldDatabase === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = oldDatabase;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const safe = path.join(root, 'extensions', 'safe');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(safe, { recursive: true }); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(safe, 'agentplayer.plugin.json'), JSON.stringify({ permissions: ['network'] }));
  fs.writeFileSync(path.join(outside, 'agentplayer.plugin.json'), JSON.stringify({ permissions: ['process'] }));
  const { getExtensionPermissions } = await import('../src/middleware/extension-permissions.ts');
  assert.deepEqual(getExtensionPermissions('safe'), ['network', 'storage']);
  for (const id of ['../outside', outside, 'safe/../../outside', 'safe\\..\\outside', null]) assert.deepEqual(getExtensionPermissions(id), []);
  fs.symlinkSync(outside, path.join(root, 'extensions', 'escaped'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(getExtensionPermissions('escaped'), []);
  fs.writeFileSync(path.join(safe, 'agentplayer.plugin.json'), JSON.stringify({ permissions: 'network,process,storage' }));
  assert.deepEqual(getExtensionPermissions('safe'), []);
});
