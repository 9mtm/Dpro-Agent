// DISCOVER-01 (board M17): "Found on this computer" — projects, kinds, states,
// preview before import (with its hash), an MCP secret left out unless chosen,
// ignore / remove / keep, watch settings; the contract allows only these calls.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { allowed } = require('../scripts/application-server.cjs');
const { discoveryRoute, discoveryResponse, allowedDiscovery } = require('../src/discovery-contract.js');
const { DiscoveryController } = require('../src/discovery-controller.ts');
const { DiscoveryView } = require('../src/Discovery.tsx');

const BASE = '/api/memory/import/discovery';
const R1 = '1'.repeat(32), I = n => String(n).repeat(32).slice(0, 32), H = c => c.repeat(64);
const items = () => [
  { id: I(1), kind: 'memory', name: 'brand-voices', from: 'Claude Code memory · feedback', rootId: R1, to: 'Lessons', state: 'new', updatedAt: '2026-10-21T10:00:00Z' },
  { id: I(2), kind: 'memory', name: 'brand-colors', from: 'Claude Code memory · project', rootId: R1, to: 'Projects · flowxtra', state: 'changed', updatedAt: '2026-10-21T10:00:00Z' },
  { id: I(3), kind: 'mcp', name: 'flowxtra-admin', from: '~/work/flowxtra/.mcp.json · 1 secret inside', rootId: R1, to: 'MCP · off · secret → Credentials', state: 'decision', updatedAt: '' },
  { id: I(4), kind: 'note', name: 'CLAUDE.md', from: 'project notes', rootId: R1, to: 'Projects · flowxtra · read by the local model', state: 'imported', updatedAt: '' },
  { id: I(5), kind: 'memory', name: 'old-server', from: 'no longer on this computer', rootId: R1, to: 'Projects · flowxtra', state: 'gone', updatedAt: '' },
  { id: I(6), kind: 'ssh', name: 'devbox', from: '~/.ssh/config', rootId: null, to: 'SSH hosts · names only', state: 'new', updatedAt: '' },
  { id: I(7), kind: 'skill', name: 'writer', from: '~/.claude/skills/writer/SKILL.md', rootId: null, to: 'Skills · off until assigned', state: 'imported', updatedAt: '' },
];
function backend() {
  const calls = []; let list = items();
  const view = () => ({ scannedAt: new Date().toISOString(), ms: 1900, leftOut: 261, settings: { watch: true, intervalMinutes: 30 }, file: '/secret/path',
    roots: [{ id: 'computer', name: 'This computer', path: null, project: 'not a project · SSH, user skills', count: 2, fresh: 1, watch: true }, { id: R1, name: 'flowxtra', path: '~/work/flowxtra', project: 'Dpro project Flowxtra', count: 5, fresh: 3, watch: true }],
    items: list });
  const client = { request: async r => {
    calls.push(r);
    assert.ok(allowedRequest(r.method, r.path, r.body), `${r.method} ${r.path}`); assert.ok(allowed(r.method, r.path, r.body), `bridge ${r.method} ${r.path}`);
    const out = (body, status = 200) => ({ status, body: discoveryResponse(r.path, status, discoveryResponse(r.path, status, body)) });
    const path = r.path;
    if (path === BASE || path === `${BASE}/scan`) return out(view());
    const item = /items\/([a-f0-9]{32})$/.exec(path);
    if (item) { const it = list.find(x => x.id === item[1]); return out({ item: { ...it, text: it.kind === 'mcp' ? '{ "env": { "FLOWXTRA_TOKEN": "••••••••" } }' : 'Brand voices never mix.', truncated: false, secrets: it.kind === 'mcp' ? ['FLOWXTRA_TOKEN'] : [], blocked: null, previewHash: H(item[1][0]) } }); }
    if (path === `${BASE}/import`) { for (const i of r.body.items) list = list.map(x => (x.id === i.id ? { ...x, state: 'imported' } : x)); return out({ results: r.body.items.map(i => ({ id: i.id, ok: true, state: 'imported' })) }); }
    const act = /items\/([a-f0-9]{32})\/(ignore|remove|keep)$/.exec(path);
    if (act) { list = list.map(x => (x.id === act[1] ? { ...x, state: act[2] === 'keep' ? 'imported' : 'ignored' } : x)); return out(act[2] === 'ignore' ? { id: act[1], ignored: r.body.on } : act[2] === 'remove' ? { id: act[1], removed: true } : { id: act[1], kept: true }); }
    if (path === `${BASE}/settings`) return out({ settings: r.body });
    if (path.startsWith(`${BASE}/roots/`)) return out({ id: path.split('/').pop(), watch: r.body.watch });
    return { status: 404, body: null };
  } };
  return { client, calls };
}

test('contract: only these calls; responses keep reviewed fields and are stable twice', () => {
  for (const [m, p, b, ok] of [['GET', BASE, undefined, true], ['POST', `${BASE}/scan`, undefined, true], ['GET', `${BASE}/items/${I(1)}`, undefined, true], ['GET', `${BASE}/items/../etc`, undefined, false],
    ['POST', `${BASE}/import`, { items: [{ id: I(1), previewHash: H('a') }] }, true], ['POST', `${BASE}/import`, { items: [{ id: I(1), previewHash: 'x' }] }, false], ['POST', `${BASE}/import`, { items: [] }, false],
    ['POST', `${BASE}/import`, { items: [{ id: I(1), previewHash: H('a'), path: '/etc' }] }, false], ['PUT', `${BASE}/settings`, { watch: true, intervalMinutes: 45 }, false], ['PUT', `${BASE}/roots/computer`, { watch: false }, true],
    ['POST', `${BASE}/items/${I(1)}/ignore`, { on: true }, true], ['POST', `${BASE}/items/${I(1)}/remove`, { force: true }, false]])
    assert.equal(allowedDiscovery(m, p, b), ok, `${m} ${p}`);
  assert.ok(discoveryRoute(BASE) && !discoveryRoute('/api/memory/import/local'));
  const body = { scannedAt: 'x', ms: 3, settings: { watch: true, intervalMinutes: 30 }, roots: [{ id: R1, name: 'a', path: '~/a', project: 'p', count: 1, fresh: 1, file: '/x' }], items: [{ ...items()[0], file: '/secret/path' }, { id: 'bad', kind: 'memory' }] };
  const once = discoveryResponse(BASE, 200, body);
  assert.equal(once.items.length, 1); assert.ok(!JSON.stringify(once).includes('/secret/path'));
  assert.deepEqual(discoveryResponse(BASE, 200, once), once);
});

test('the page: projects with new counts, kinds and states, where each item goes (board M17)', async () => {
  const { client } = backend();
  const c = new DiscoveryController(client);
  await c.load();
  assert.equal(c.getSnapshot().rootId, R1, 'opens on the first project with something new');
  const html = renderToStaticMarkup(React.createElement(DiscoveryView, { c, active: false }));
  for (const words of ['By project folder', 'This computer', 'flowxtra', '3 new', 'Found on this computer', 'Dpro only reads; your files never change', 'Scan now', 'Watch', '30 min',
    'Memory files', 'Project notes', 'MCP servers', 'SSH hosts', 'Needs your decision', 'Gone from this computer', 'Dpro project Flowxtra', '~/work/flowxtra', 'Stop watching this project',
    'brand-voices', 'Lessons', 'Changed', 'Update', 'Review', 'Keep', 'Import selected', 'Memory files go in as they are (no model)', 'Rules of this page', '261 files were left out: copies, archives and other people', 'private SSH keys, .env files'])
    assert.ok(html.includes(words), words);
  c.setKind('memory'); assert.deepEqual(c.shown().map(i => i.name), ['brand-voices', 'brand-colors', 'old-server']);
  c.setState('changed'); assert.deepEqual(c.shown().map(i => i.name), ['brand-colors']);
  c.setKind('all'); c.setState('all'); c.setRoot('computer'); assert.deepEqual(c.shown().map(i => i.name), ['devbox', 'writer']);
});

test('import selected previews each item first and sends its hash; an MCP secret is left out unless chosen', async () => {
  const { client, calls } = backend();
  const c = new DiscoveryController(client);
  await c.load();
  c.toggle(I(1)); c.toggle(I(3));
  await c.importIds(c.getSnapshot().selected);
  const post = calls.find(r => r.path === `${BASE}/import`);
  assert.deepEqual(post.body, { items: [{ id: I(1), previewHash: H('1') }, { id: I(3), previewHash: H('3'), secret: 'leave' }] });
  assert.match(c.getSnapshot().result, /2 imported/);
  assert.equal(c.getSnapshot().selected.length, 0);
});

test('the opened MCP server: secret names only, the owner chooses Credentials, added switched off', async () => {
  const { client, calls } = backend();
  const c = new DiscoveryController(client);
  await c.load();
  await c.open(I(3));
  const html = renderToStaticMarkup(React.createElement(DiscoveryView, { c, active: false }));
  for (const words of ['A secret was found (FLOWXTRA_TOKEN)', 'Save it in Credentials (encrypted)', 'Leave it on this computer only', 'Add server (off)', 'switched off', '••••••••'])
    assert.ok(html.includes(words), words);
  c.setSecret('credentials');
  await c.importOpen();
  assert.deepEqual(calls.filter(r => r.path === `${BASE}/import`).pop().body, { items: [{ id: I(3), previewHash: H('3'), secret: 'credentials' }] });
  assert.equal(c.getSnapshot().preview, null, 'closed after import');
});

test('ignore, remove (from the opened item), keep, watch settings, stop watching a project', async () => {
  const { client, calls } = backend();
  const c = new DiscoveryController(client);
  await c.load();
  await c.ignore(I(1), true);
  assert.match(c.getSnapshot().result, /Ignored/);
  await c.open(I(4));
  let html = renderToStaticMarkup(React.createElement(DiscoveryView, { c, active: false }));
  assert.ok(html.includes('Read again') && !html.includes('>Remove from Dpro</button>'), 'notes are read again, not removed one by one');
  c.setRoot('computer'); await c.open(I(7));
  html = renderToStaticMarkup(React.createElement(DiscoveryView, { c, active: false }));
  assert.ok(html.includes('>Remove from Dpro</button>'));
  await c.remove(I(7));
  assert.match(c.getSnapshot().result, /file on this computer is unchanged/);
  await c.keep(I(5));
  await c.setWatch(true, 15);
  assert.deepEqual(calls.find(r => r.path === `${BASE}/settings`).body, { watch: true, intervalMinutes: 15 });
  await c.setRootWatch(R1, false);
  assert.deepEqual(calls.find(r => r.path === `${BASE}/roots/${R1}`).body, { watch: false });
});

test('a slow first read (504) is asked again, not shown as an error', async () => {
  const { client } = backend(); let first = true;
  const slow = { request: async r => { if (first && r.path === BASE) { first = false; return { status: 504, body: null }; } return client.request(r); } };
  const c = new DiscoveryController(slow);
  await c.load();
  assert.equal(c.getSnapshot().phase, 'ready');
});
