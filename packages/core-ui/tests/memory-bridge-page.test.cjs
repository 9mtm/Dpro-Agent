// MEM-FINISH-01 (board M11): Memory › Coding apps — app states from /api/memory-bridge,
// register only after a preview with its hash, a stale preview is shown again, kill switch,
// undo, folder settings, back-flow and the activity log in plain words.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { allowed } = require('../scripts/application-server.cjs');
const { memoryBridgeRoute, memoryBridgeResponse } = require('../src/memory-bridge-contract.js');
const { MemoryBridgeController, activityText } = require('../src/memory-bridge.ts');
const { BridgeView } = require('../src/MemoryBridge.tsx');

const H1 = 'a'.repeat(64), H2 = 'b'.repeat(64);
const REG = '0123abcd-0000-4000-8000-000000000000';
function backend({ stale = false } = {}) {
  const calls = [];
  let hash = H1, enabled = { 'claude-code': true, codex: false, 'gemini-cli': false, antigravity: false }, codexReg = null, git = true, back = true, files = false;
  const status = () => ({
    clients: [
      { client: 'claude-code', name: 'Claude Code', enabled: enabled['claude-code'], configPath: '/tmp/h/.claude.json', registrationId: REG, registeredAt: '2026-10-18 10:00:00', lastCallAt: new Date(Date.now() - 4 * 60000).toISOString(), lastTool: 'memory_search' },
      { client: 'codex', name: 'Codex', enabled: enabled.codex, configPath: '/tmp/h/.codex/config.toml', registrationId: codexReg, registeredAt: codexReg ? '2026-10-21 12:00:00' : null, lastCallAt: null, lastTool: null },
      { client: 'gemini-cli', name: 'Gemini CLI', enabled: false, configPath: '/tmp/h/.gemini/settings.json', registrationId: null, registeredAt: null, lastCallAt: null, lastTool: null },
      { client: 'antigravity', name: 'Antigravity', enabled: false, configPath: '/tmp/h/.gemini/config/mcp_config.json', registrationId: null, registeredAt: null, lastCallAt: null, lastTool: null },
    ],
    projects: [{ projectId: 'proj-1', name: 'Dpro', folder: '/tmp/dpro', filesEnabled: files, backflowEnabled: back, gitExclude: git, writtenAt: files ? '2026-10-21 12:00:00' : null, confirmedAt: null }],
    registrations: [], serverReady: true,
  });
  const client = { request: async r => {
    calls.push(r); assert.ok(allowedRequest(r.method, r.path, r.body), `${r.method} ${r.path}`); assert.ok(allowed(r.method, r.path, r.body), `bridge ${r.method} ${r.path}`);
    assert.ok(memoryBridgeRoute(r.path));
    const out = (body, status = 200) => ({ status, body: memoryBridgeResponse(r.path, status, memoryBridgeResponse(r.path, status, body)) });
    const path = r.path.split('?')[0];
    if (path === '/api/memory-bridge') return out(status());
    if (path === '/api/memory-bridge/audit') return out({ entries: [{ id: 'a1', client: 'claude-code', projectId: 'proj-1', action: 'mcp-read', detail: 'project_brief', createdAt: '2026-10-21 12:00:00' }, { id: 'a2', client: 'claude-code', projectId: 'proj-1', action: 'mcp-propose', detail: 'proposal x', createdAt: '2026-10-21 11:50:00' }] });
    if (path === '/api/memory-bridge/clients/codex/registration') {
      if (r.method === 'GET') return out({ preview: { client: 'codex', name: 'Codex', configPath: '/tmp/h/.codex/config.toml', action: 'create', diff: '  [mcp_servers.github]\n+ [mcp_servers.dpro-memory]\n+ command = "/usr/local/bin/node"', beforeSha256: null, afterSha256: H1, previewHash: hash, warnings: [] } });
      if (stale && r.body.previewHash === H1) { hash = H2; return out({ error: 'changed', code: 'preview_stale' }, 409); }
      assert.equal(r.body.previewHash, hash); codexReg = REG.replace('0123', '4567'); enabled.codex = true;
      return out({ registration: { id: codexReg, client: 'codex', configPath: '/tmp/h/.codex/config.toml', existed: true, status: 'applied', createdAt: '2026-10-21 12:00:00', undoneAt: null }, preview: { client: 'codex', name: 'Codex', configPath: '/tmp/h/.codex/config.toml', action: 'create', diff: '', beforeSha256: null, afterSha256: H1, previewHash: hash, warnings: [] } });
    }
    if (path === '/api/memory-bridge/clients/claude-code') { enabled['claude-code'] = r.body.enabled; return out({ client: 'claude-code', enabled: r.body.enabled }); }
    if (path === `/api/memory-bridge/registrations/${REG}/undo`) return out({ registration: { id: REG, client: 'claude-code', configPath: '/tmp/h/.claude.json', existed: true, status: 'undone', createdAt: '2026-10-18 10:00:00', undoneAt: '2026-10-21 13:00:00' }, mode: 'restored' });
    if (path === '/api/memory-bridge/projects/proj-1/files') {
      if (r.method === 'GET') return out({ preview: { projectId: 'proj-1', folder: '/tmp/dpro', files: [{ name: 'AGENTS.md', relative: 'AGENTS.md', action: 'create', diff: '+ <!-- dpro:begin -->' }], previewHash: H1, conflicts: 0, changes: 1 } });
      files = true; return out({ result: { projectId: 'proj-1', folder: '/tmp/dpro', files: [], previewHash: H1, conflicts: 0, changes: 1 } });
    }
    if (path === '/api/memory-bridge/projects/proj-1') { if (r.body.gitExclude !== undefined) git = r.body.gitExclude; if (r.body.backflowEnabled !== undefined) back = r.body.backflowEnabled; if (r.body.filesEnabled === false) files = false; return out({ folder: { projectId: 'proj-1', filesEnabled: files, backflowEnabled: back, gitExclude: git, writtenAt: null, confirmedAt: null } }); }
    if (path === '/api/memory-bridge/projects/proj-1/backflow') return out({ result: { files: 2, proposed: 3, known: 0, skipped: 0, proposalIds: ['p1'] } });
    return { status: 404, body: null };
  } };
  return { client, calls };
}

test('the page shows each app, its registration, last call and the folders as drawn (board M11)', async () => {
  const { client } = backend();
  const c = new MemoryBridgeController(client);
  await c.load();
  await c.previewRegistration('codex');
  const html = renderToStaticMarkup(React.createElement(BridgeView, { c, onChangeFolder: () => {} }));
  for (const words of ['Coding apps share this memory', 'Claude Code', 'Registered · 18 Oct', 'Last call 4 min ago · memory_search', 'Codex', 'Not registered', 'No calls yet', 'Register…', 'Check registration', 'Undo registration',
    'Folders and projects', '/tmp/dpro', 'Hidden', 'Bring back app notes', 'Now', 'Preview &amp; turn on', 'Change', 'Your own text in those files is never changed.',
    'Step 1 of 2 · Preview', 'Register Dpro memory in Codex', '/tmp/h/.codex/config.toml · a backup is kept first', '[mcp_servers.dpro-memory]', 'No key, password or token goes into this file.',
    'Confirm and register', 'If the file changed after this preview, Dpro stops and shows a new preview.', 'Recent bridge activity', 'Claude Code read the Dpro brief', 'Claude Code proposed a fact for Dpro → Review'])
    assert.ok(html.includes(words), words);
});

test('register: confirm sends the preview hash; a changed file stops it and shows a new preview', async () => {
  const { client, calls } = backend({ stale: true });
  const c = new MemoryBridgeController(client);
  await c.load();
  await c.previewRegistration('codex');
  await c.confirm();
  assert.match(c.getSnapshot().notice, /changed after this preview/);
  assert.equal(c.getSnapshot().preview.preview.previewHash, H2, 'a new preview is shown');
  await c.confirm();
  const posts = calls.filter(r => r.method === 'POST' && r.path.endsWith('/registration'));
  assert.deepEqual(posts.map(r => r.body), [{ previewHash: H1, confirm: true }, { previewHash: H2, confirm: true }]);
  assert.match(c.getSnapshot().result, /registered in Codex/);
  assert.equal(c.getSnapshot().preview, null);
  assert.ok(c.getSnapshot().status.clients.find(x => x.client === 'codex').registrationId);
});

test('kill switch, undo, folder settings, files preview -> confirm, back-flow now', async () => {
  const { client, calls } = backend();
  const c = new MemoryBridgeController(client);
  await c.load();
  await c.setEnabled('claude-code', false);
  assert.deepEqual(calls.find(r => r.method === 'PUT').body, { enabled: false });
  const html = renderToStaticMarkup(React.createElement(BridgeView, { c }));
  assert.ok(html.includes('Registered · off') && html.includes('Off: every call is refused'));
  c.askUndo('claude-code');
  await c.undo('claude-code');
  assert.match(c.getSnapshot().result, /config is back as it was/);
  await c.setFolder('proj-1', { gitExclude: false });
  assert.equal(c.getSnapshot().status.projects[0].gitExclude, false);
  await c.previewFiles('proj-1');
  assert.equal(c.getSnapshot().preview.kind, 'files');
  await c.confirm();
  assert.deepEqual(calls.filter(r => r.method === 'POST' && r.path.endsWith('/files')).map(r => r.body), [{ previewHash: H1, confirm: true }]);
  assert.equal(c.getSnapshot().status.projects[0].filesEnabled, true);
  await c.setFolder('proj-1', { filesEnabled: false });
  assert.equal(c.getSnapshot().status.projects[0].filesEnabled, false);
  await c.backflowNow('proj-1');
  assert.match(c.getSnapshot().result, /3 new notes from 2 files wait in Review/);
});

test('activity lines in plain words', () => {
  const name = () => 'Dpro';
  assert.equal(activityText({ id: 'x', client: 'codex', projectId: 'p', action: 'mcp-handoff', detail: null, createdAt: '' }, name), 'Codex wrote a handoff for Dpro');
  assert.equal(activityText({ id: 'x', client: 'gemini-cli', projectId: null, action: 'client-off', detail: null, createdAt: '' }, name), 'Gemini CLI turned off by you');
  assert.equal(activityText({ id: 'x', client: 'claude-code', projectId: null, action: 'registered', detail: null, createdAt: '' }, name), 'Claude Code registered by you (backup kept)');
});
