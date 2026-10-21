require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { allowed } = require('../scripts/application-server.cjs');
const { memoryPagesRoute, memoryPagesResponse } = require('../src/memory-pages-contract.js');
const { memoryRecallRoute, memoryRecallResponse } = require('../src/memory-recall-contract.js');
const { localImportRoute, localImportResponse } = require('../src/local-import-contract.js');
const { MemoryHealthController } = require('../src/memory-health.ts');
const { HealthView } = require('../src/MemoryHealth.tsx');
const { SafeFixDialog } = require('../src/MemoryDialogs.tsx');

const H1 = 'a'.repeat(64), H2 = 'b'.repeat(64);
const report = (hash, dup) => ({ checkedAt: '2026-10-21T11:54:00.000Z', embeddingModel: 'qwen3-embedding:0.6b', total: 386, counts: { duplicate: dup, expired: 11, 'embedding-missing': 0, 'embedding-stale': 2, 'broken-drawer': 1 }, issues: dup ? [{ kind: 'duplicate', drawerId: 'project:flowxtra', memoryIds: ['m1', 'm2'] }, { kind: 'duplicate', drawerId: 'owner', memoryIds: ['m3', 'm4'] }] : [], reportHash: hash });
function backend({ changed = false } = {}) {
  let rules = { scope: 'company', own: { routine: null, important: null, contradiction: null, reviewerAgentId: null, weeklyDay: null, weeklyHour: null, updatedAt: null }, effective: { routine: 'save', important: 'ask', contradiction: 'ask', from: { routine: 'default', important: 'default', contradiction: 'default' }, reviewerAgentId: null, weekly: { day: 1, hour: 9 } } };
  const calls = []; let hash = H1, dup = 4, retention = { enabled: false, taskTtlDays: 90, experienceAfterDays: 180, experienceMinGroup: 3 }, auto = { enabled: true, intervalMinutes: 15, nextRun: 0, lastRun: null, status: 'idle', lastImported: 0, lastProposed: 0, notice: '' };
  const client = { request: async r => {
    calls.push(r); assert.ok(allowedRequest(r.method, r.path, r.body), `${r.method} ${r.path}`); assert.ok(allowed(r.method, r.path, r.body), `bridge ${r.method} ${r.path}`);
    const f = (status, x) => memoryPagesRoute(r.path) ? memoryPagesResponse(r.path, status, x) : memoryRecallRoute(r.path) ? memoryRecallResponse(r.path, status, x) : localImportRoute(r.path) ? localImportResponse(r.path, status, x) : x;
    const out = (body, status = 200) => ({ status, body: f(status, f(status, body)) });
    if (r.path === '/api/memory/doctor') return out(report(hash, dup));
    if (r.path === '/api/memory/doctor/fix') {
      if (changed) { hash = H2; return out({ error: 'x', code: 'report_changed' }, 409); }
      assert.equal(r.body.expectedReportHash, hash); dup = 0; hash = H2;
      return out({ fixed: { duplicate: 4 }, skipped: [], report: report(hash, 0) });
    }
    if (r.path === '/api/memory/retention') { if (r.method === 'PUT') { retention = { ...retention, ...r.body }; return out({ config: retention }); } return out({ config: retention, runs: [] }); }
    if (r.path === '/api/memory/import/local/automatic') { if (r.method === 'PUT') auto = { ...auto, ...r.body }; return out({ settings: auto }); }
    if (r.path === '/api/memory/cache/metrics') return out({ process: { caches: { pack: { hits: 8, misses: 2, hitRate: 0.8 } }, ttftMs: { p50: 1400 }, packChars: { avg: 12400 } }, recent: { turns: 10, packHitRate: 0.82, ttftMs: { p50: 1400 } }, budget: { numCtx: 32768, summaryTokens: 600 } });
    if (r.path.startsWith('/api/memory/scopes/rules')) {
      if (r.method === 'PUT') { const { scope, ...rest } = r.body; rules = { ...rules, scope, own: { ...rules.own, ...rest }, effective: { ...rules.effective, ...Object.fromEntries(Object.entries(rest).filter(([k, v]) => ['routine', 'important', 'contradiction'].includes(k) && v)) } }; return out(rules); }
      return out({ ...rules, scope: new URLSearchParams(r.path.split('?')[1]).get('scope') });
    }
    return { status: 404, body: null };
  } };
  return { client, calls };
}

test('health check names the doctor kinds; the M13 dialog fixes only the ticked kinds on the shown report (boards M7 + M13)', async () => {
  const { client, calls } = backend();
  const c = new MemoryHealthController(client);
  await c.load();
  const html = renderToStaticMarkup(React.createElement(HealthView, { c, conflicts: 2, onReview: () => {}, onFiles: () => {} }));
  for (const words of ['Health check', 'Duplicate copies', 'Expired working items', 'every memory indexed with qwen3-embedding:0.6b', 'Broken drawer', 'Map leftovers', 'Open conflicts', 'Review safe fixes (18)…', 'Rules', 'for the whole company',
    'Routine facts', 'Save automatically', 'Weekly summary', 'Monday', '09:00', 'Keep Tasks drawer items', 'Every 15 minutes', 'Secrets are never saved to memory', 'Speed: cache and context', 'Context pack', '82%', '1.4 s', '32k', 'nothing to clear by hand', 'Export all'])
    assert.ok(html.includes(words), words);
  assert.ok(!html.includes('Clear cache'), 'M16: no clear-cache button (caches clear on their own)');
  c.startFix();
  const dialog = renderToStaticMarkup(React.createElement(SafeFixDialog, { c }));
  for (const words of ['Review safe fixes', 'Pick what to fix. Deleted copies keep their history and can be brought back.', 'Keep the one with a topic key', 'Delete working / experience items past their expiry', 'Missing meaning index', 'Old meaning index', 'Loose history', 'Topic key not in standard form', 'Show the 2 duplicate groups', 'Fix 4 kinds · 18 items', 'Cancel'])
    assert.ok(dialog.includes(words), words);
  c.toggleKind('expired'); c.toggleKind('embedding-stale'); c.toggleKind('broken-drawer');
  await c.fix();
  assert.deepEqual(calls.find(r => r.path === '/api/memory/doctor/fix').body, { confirm: true, expectedReportHash: H1, kinds: ['duplicate'] });
  assert.equal(c.getSnapshot().report.counts.duplicate, 0); assert.equal(c.getSnapshot().fixing, false);
  c.dispose();
});

test('a changed memory stops the fix: nothing fixed until "Check again" shows the new report', async () => {
  const { client } = backend({ changed: true });
  const c = new MemoryHealthController(client);
  await c.load(); c.startFix(); await c.fix();
  assert.equal(c.getSnapshot().stale, true);
  const dialog = renderToStaticMarkup(React.createElement(SafeFixDialog, { c }));
  assert.ok(dialog.includes('Memory changed since this check. Nothing was fixed.') && dialog.includes('Check again'));
  await c.check(true);
  assert.equal(c.getSnapshot().report.reportHash, H2);
  assert.equal(c.getSnapshot().stale, false);
  c.dispose();
});

test('rules save only what changed: the scope rules (null = inherit), retention and the import schedule', async () => {
  const { client, calls } = backend();
  const c = new MemoryHealthController(client);
  await c.load('project:flowxtra');
  assert.ok(calls.some(r => r.path === '/api/memory/scopes/rules?scope=project%3Aflowxtra'));
  const html = renderToStaticMarkup(React.createElement(HealthView, { c, conflicts: 0, onReview: () => {}, onFiles: () => {} }));
  assert.ok(html.includes('for Projects · flowxtra') && html.includes('As company'));
  assert.equal(c.rulesChanged(), false);
  c.editScopeRules({ routine: 'ask', contradiction: 'keep_both' });
  c.editRetention({ enabled: true, taskTtlDays: 30 }); c.editImport({ intervalMinutes: 60 });
  await c.saveRules();
  assert.deepEqual(calls.find(r => r.method === 'PUT' && r.path === '/api/memory/scopes/rules').body, { scope: 'project:flowxtra', routine: 'ask', contradiction: 'keep_both' });
  assert.deepEqual(calls.find(r => r.method === 'PUT' && r.path === '/api/memory/retention').body, { enabled: true, taskTtlDays: 30 });
  assert.deepEqual(calls.find(r => r.method === 'PUT' && r.path === '/api/memory/import/local/automatic').body, { enabled: true, intervalMinutes: 60 });
  assert.equal(c.getSnapshot().result, 'Rules saved.');
  assert.equal(c.rulesChanged(), false);
  c.editScopeRules({ routine: 'inherit' });
  await c.saveRules();
  assert.deepEqual(calls.filter(r => r.method === 'PUT' && r.path === '/api/memory/scopes/rules').pop().body, { scope: 'project:flowxtra', routine: null });
  c.dispose();
});
