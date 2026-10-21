require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { allowed } = require('../scripts/application-server.cjs');
const { memoryPagesResponse } = require('../src/memory-pages-contract.js');
const { MemoryAccessController, chain, cellText, whyText } = require('../src/memory-access.ts');
const { AccessView } = require('../src/MemoryAccess.tsx');

const H = 'e'.repeat(64);
const rule = (id, scope, kind, read, write, agentId = null, endsAt = null) => ({ id, scope, agentId, drawerKind: kind, read, write, endsAt, expired: false, reason: null, createdAt: '2026-10-20T00:00:00.000Z' });
const tree = { company: {}, agents: { total: 3012 }, departments: [{ id: 'marketing', name: 'Marketing', projects: 24 }], projects: [{ slug: 'flowxtra', name: 'Flowxtra', departmentId: 'marketing' }] };
function backend({ changed = false } = {}) {
  const calls = [];
  let rules = [rule('r1', 'company', 'people', 'deny', 'deny'), rule('r2', 'department:marketing', 'project', 'allow', 'allow'), rule('r3', 'project:flowxtra', 'people', 'allow', 'deny', 'legal-1', '2026-10-30T00:00:00.000Z')];
  const client = { request: async r => {
    calls.push(r); assert.ok(allowedRequest(r.method, r.path, r.body), `${r.method} ${r.path}`); assert.ok(allowed(r.method, r.path, r.body), `bridge ${r.method} ${r.path}`);
    const out = (body, status = 200) => ({ status, body: memoryPagesResponse(r.path, status, memoryPagesResponse(r.path, status, body)) });
    if (r.path === '/api/memory/access') return out({ version: 3, rules, templates: [{ id: 't1', name: 'Marketing writer', memoryRead: ['owner', 'project'], memoryWrite: ['project'], agents: 18 }] });
    if (r.path === '/api/agents') return { status: 200, body: { agents: [{ id: 'writer', name: 'Writer' }, { id: 'legal-1', name: 'Legal reviewer' }] } };
    if (r.path === '/api/memory/access/preview') return out({ previewHash: H, version: 3, changes: r.body.changes.length, agentsAffected: 42, projectsAffected: 24, noProjectAffected: false, pairsChanged: 50, widened: 42, narrowed: 0, agentsTotal: 3012, projectsTotal: 100, sample: [{ agentId: 'writer', agentName: 'Writer', project: 'flowxtra', before: { read: ['owner'], write: [] }, after: { read: ['owner', 'people'], write: [] } }] });
    if (r.path === '/api/memory/access/apply') { if (changed) return out({ error: 'x', code: 'preview_changed' }, 409); rules = [...rules, rule('r4', r.body.changes[0].scope, r.body.changes[0].drawerKind, r.body.changes[0].read, r.body.changes[0].write)]; return out({ version: 4, preview: { previewHash: H, agentsAffected: 42 } }); }
    if (r.path.startsWith('/api/memory/access/effective/writer')) return out({ agentId: 'writer', agentName: 'Writer', project: 'flowxtra', department: 'marketing', version: 3, template: { id: 't1', name: 'Marketing writer' }, exceptions: [], effective: { memoryRead: ['project'], memoryWrite: ['project'] },
      kinds: { project: { read: true, write: true, readWhy: [{ layer: 'default', value: 'allow' }, { layer: 'department', value: 'allow' }, { layer: 'role-template', value: 'allow', name: 'Marketing writer' }], writeWhy: [{ layer: 'department', value: 'allow' }] }, people: { read: false, write: false, readWhy: [{ layer: 'company', value: 'deny' }], writeWhy: [] } } });
    if (r.path.startsWith('/api/memory/access/counts')) return out({ column: 'project', mode: 'read', total: 3012, company: 3012, departments: { marketing: 400 }, projects: { flowxtra: 12 } });
    if (r.path.startsWith('/api/memory/access/agents')) { const col = new URLSearchParams(r.path.split('?')[1]).get('column'); return out({ scope: 'project:flowxtra', column: col, mode: 'read', count: col === 'people' ? 1 : 12, total: 3012, agents: col === 'people' ? [{ id: 'legal-1', name: 'Legal reviewer', read: true, write: false, template: null, exception: true }] : [{ id: 'writer', name: 'Writer', read: true, write: true, template: 'Marketing writer', exception: false }], nextCursor: null }); }
    if (r.path.startsWith('/api/memory/access/templates/t1')) return out({ template: { id: 't1', name: 'Marketing writer', memoryRead: ['owner', 'project'], memoryWrite: ['project'], scopeRead: null, scopeWrite: null, agents: 18 }, agents: [{ id: 'writer', name: 'Writer' }], nextCursor: 'b' });
    return { status: 404, body: null };
  } };
  return { client, calls };
}

test('the grid shows each level, inherited and own values, and agent exceptions (board M9)', async () => {
  const { client } = backend();
  const c = new MemoryAccessController(client);
  await c.load();
  assert.deepEqual(chain('project:flowxtra', () => 'marketing'), ['company', 'department:marketing', 'project:flowxtra']);
  const html = renderToStaticMarkup(React.createElement(AccessView, { c, scope: 'project:flowxtra', tree }));
  for (const words of ['Who may read and write this memory', 'Company default', 'all 3012 agents', 'Marketing', '24 projects', 'Flowxtra', 'Exception: Legal reviewer', 'temporary · ends 2026-10-30', 'Role templates', 'Marketing writer', 'used by 18 agents', 'Check one agent', 'Always true', 'Add exception'])
    assert.ok(html.includes(words), words);
  const levels = [{ scope: 'company', agentId: null }, { scope: 'department:marketing', agentId: null }, { scope: 'project:flowxtra', agentId: null }, { scope: 'project:flowxtra', agentId: 'legal-1' }];
  assert.deepEqual(c.cell(levels, 0, 'people'), { read: false, write: false, own: true });
  assert.equal(cellText(c.cell(levels, 2, 'people')), '—', 'inherited from the company');
  assert.equal(c.cell(levels, 2, 'people').own, false);
  assert.equal(cellText(c.cell(levels, 1, 'project')), 'R+W');
  assert.equal(cellText(c.cell(levels, 3, 'people')), 'R', 'the exception adds read here');
  c.dispose();
});

test('a change is previewed (N agents) and applied only with the preview hash and confirm', async () => {
  const { client, calls } = backend();
  const c = new MemoryAccessController(client);
  await c.load();
  const levels = [{ scope: 'company', agentId: null }, { scope: 'department:marketing', agentId: null }];
  c.cycle(levels[1], 'people', c.cell(levels, 1, 'people')); await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(calls.find(r => r.path === '/api/memory/access/preview').body, { changes: [{ op: 'set_rule', scope: 'department:marketing', agentId: null, drawerKind: 'people', read: 'allow', write: 'deny' }] });
  assert.ok(!calls.some(r => r.path === '/api/memory/access/apply'), 'the preview saves nothing');
  const html = renderToStaticMarkup(React.createElement(AccessView, { c, scope: 'department:marketing', tree }));
  assert.ok(html.includes('Preview before saving')); assert.ok(html.includes('42 agents')); assert.ok(html.includes('Apply to 42'));
  await c.apply();
  const apply = calls.find(r => r.path === '/api/memory/access/apply');
  assert.equal(apply.body.expectedPreviewHash, H); assert.equal(apply.body.confirm, true);
  assert.match(c.getSnapshot().result, /42 agents/); assert.equal(c.getSnapshot().changes.length, 0);
  c.dispose();
});

test('a temporary exception goes through the same preview; check one agent explains why', async () => {
  const { client, calls } = backend();
  const c = new MemoryAccessController(client);
  await c.load();
  c.startException(); c.editException({ agentId: 'writer', kind: 'people', access: 'read', until: '2026-10-30', reason: 'launch week' });
  c.addException('project:flowxtra'); await new Promise(r => setTimeout(r, 0));
  const ch = calls.find(r => r.path === '/api/memory/access/preview').body.changes[0];
  assert.equal(ch.agentId, 'writer'); assert.equal(ch.read, 'allow'); assert.equal(ch.write, 'deny'); assert.match(ch.endsAt, /^2026-10-30T/); assert.equal(ch.reason, 'launch week');
  await c.check('writer', 'flowxtra');
  assert.equal(whyText(c.getSnapshot().effective, 'project'), 'department rule allows read → Marketing writer template allows read → department rule allows write');
  c.dispose();
});

test('access changed meanwhile: nothing is applied and the new preview is shown', async () => {
  const { client } = backend({ changed: true });
  const c = new MemoryAccessController(client);
  await c.load();
  c.cycle({ scope: 'company', agentId: null }, 'task', c.cell([{ scope: 'company', agentId: null }], 0, 'task')); await new Promise(r => setTimeout(r, 0));
  await c.apply();
  assert.match(c.getSnapshot().notice, /changed meanwhile/); assert.equal(c.getSnapshot().changes.length, 1);
  c.dispose();
});

test('MEM-GAPS-02: who reads a column of the scope, "read by N agents" per project, a template with its agents (boards M9 + M6)', async () => {
  const { client, calls } = backend();
  const c = new MemoryAccessController(client);
  await c.load('project:flowxtra');
  let html = renderToStaticMarkup(React.createElement(AccessView, { c, scope: 'project:flowxtra', tree }));
  for (const words of ['this project · read by 12 agents', 'Who reads it here', '12 of 3012', 'agents read project memories in Flowxtra.', 'Writer · writes · Marketing writer']) assert.ok(html.includes(words), words);
  await c.loadWho('project:flowxtra', 'people');
  assert.ok(calls.some(r => r.path === '/api/memory/access/agents?scope=project%3Aflowxtra&column=people&mode=read&limit=50'));
  html = renderToStaticMarkup(React.createElement(AccessView, { c, scope: 'project:flowxtra', tree }));
  assert.ok(html.includes('1 of 3012') && html.includes('Legal reviewer · exception'));
  await c.openTemplate('t1');
  html = renderToStaticMarkup(React.createElement(AccessView, { c, scope: 'project:flowxtra', tree }));
  assert.ok(html.includes('Marketing writer: Writer …'));
});
