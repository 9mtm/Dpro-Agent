// S0-A.7 + CL-05: nothing under public/storage is served by @fastify/static
// (uploads live in .data/uploads); the canonical on-disk path is checked too.
// Run: node --import tsx --test test/static-access.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const backendDir = process.cwd();
const { isPublicStaticPath, registerPublicStatic } = await import(join(backendDir, 'src/api/static-access.ts'));
const { default: Fastify } = await import('fastify');

const root = mkdtempSync(join(tmpdir(), 'ap-static-'));
for (const rel of ['storage/cache/screenshots/s.png', 'storage/cdn/files/f.txt', 'storage/extensions/trading/d.json',
  'storage/newzone/x.txt', 'storage/top.txt', 'storage/profiles/p.png', 'storage/avatars/user/1/a/avatar.glb',
  'storage/logos/l.png', 'icons/x.svg']) {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), 'data');
}
// Symlinks from an allowed subtree / outside storage into private data.
symlinkSync(join(root, 'storage/cdn'), join(root, 'storage/avatars/leak'));
symlinkSync(join(root, 'storage/cache/screenshots/s.png'), join(root, 'icons/leak.png'));
const outside = mkdtempSync(join(tmpdir(), 'ap-static-out-'));
writeFileSync(join(outside, 'secret.txt'), 'secret');
symlinkSync(outside, join(root, 'icons/out'));

const app = Fastify();
await registerPublicStatic(app, root); // same registration as src/api/app.ts
await app.ready();
test.after(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const get = (url) => app.inject({ method: 'GET', url });

test('everything under storage/ outside the allow-list answers 404, with any encoding or case', async () => {
  for (const url of ['/storage/cache/screenshots/s.png', '/storage/cdn/files/f.txt', '/storage/extensions/trading/d.json',
    '/storage/newzone/x.txt', '/storage/top.txt', '/storage/%63ache/screenshots/s.png', '/STORAGE/CDN/files/f.txt',
    '/storage/./cdn/files/f.txt', '/icons/../storage/cdn/files/f.txt', '//storage/cdn/files/f.txt', '/storage/cdn%2Ffiles/f.txt']) {
    const res = await get(url);
    assert.equal(res.statusCode, 404, `${url} -> ${res.statusCode}`);
  }
});

test('symlinks into private data or outside the root are refused', async () => {
  for (const url of ['/storage/avatars/leak/files/f.txt', '/icons/leak.png', '/icons/out/secret.txt']) {
    const res = await get(url);
    assert.equal(res.statusCode, 404, `${url} -> ${res.statusCode}`);
  }
});

test('odd segments are refused: trailing dot/space, non-ASCII, control chars', async () => {
  for (const url of ['/storage/profiles./p.png', '/storage/profiles%20/p.png', '/storage/profiles/p.png.',
    '/storage/pro%C3%A9files/p.png', '/storage/profi%CC%81les/p.png', '/icons/x%01.svg', '/storage/profiles/p.png%20']) {
    const res = await get(url);
    assert.equal(res.statusCode, 404, `${url} -> ${res.statusCode}`);
  }
});

test('shipped public files are served; former display subtrees under storage/ are not (CL-05)', async () => {
  assert.equal((await get('/icons/x.svg')).statusCode, 200);
  for (const url of ['/storage/profiles/p.png', '/storage/avatars/user/1/a/avatar.glb', '/storage/logos/l.png']) {
    const res = await get(url);
    assert.equal(res.statusCode, 404, `${url} -> ${res.statusCode}`);
  }
});

test('isPublicStaticPath unit cases', () => {
  assert.equal(isPublicStaticPath('/storage/cache', root), false);
  assert.equal(isPublicStaticPath('/storage/avatarsx/a', root), false);
  assert.equal(isPublicStaticPath('/storage/%E0%A4%A', root), false); // bad encoding
  assert.equal(isPublicStaticPath('/storage\\avatars\\a', root), false);
  assert.equal(isPublicStaticPath('/icons/missing.svg', root), false); // cannot resolve
  assert.equal(isPublicStaticPath('/icons/x.svg', '/no/such/root'), false);
});
