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

const H1 = 'a'.repeat(64), H2 = 'b'.repeat(64);
const report = (hash, dup) => ({ checkedAt: '2026-10-21T11:54:00.000Z', embeddingModel: 'qwen3-embedding:0.6b', total: 386, counts: { duplicate: dup, expired: 11, 'embedding-missing': 0, 'embedding-stale': 2, 'broken-drawer': 1 }, issues: [], reportHash: hash });
function backend({ changed = false } = {}) {
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
    if (r.path === '/api/memory/cache/clear') return out({ cleared: 3 });
    return { status: 404, body: null };
  } };
  return { client, calls };
}

test('health check and safe fixes run only on the shown report, for the ticked kinds, after a confirm (board M7)', async () => {
  const { client, calls } = backend();
  const c = new MemoryHealthController(client);
  await c.load();
  const html = renderToStaticMarkup(React.createElement(HealthView, { c, conflicts: 2, onReview: () => {}, onFiles: () => {} }));
  for (const words of ['Health check', 'Near-duplicates', 'Past retention', 'every memory indexed with qwen3-embedding:0.6b', 'Broken drawer names', 'Open conflicts', 'Review safe fixes (18)…', 'Nothing changes until you confirm each fix.', 'Rules', 'Keep Tasks drawer items', 'Every 15 minutes', 'Secrets are never saved to memory', 'Speed: cache and context', '82%', '1.4 s', '32k', 'Clear cache', 'Export all'])
    assert.ok(html.includes(words), words);
  c.startFix(); c.toggleKind('expired'); c.toggleKind('embedding-stale'); c.toggleKind('broken-drawer');
  await c.fix();
  assert.deepEqual(calls.find(r => r.path === '/api/memory/doctor/fix').body, { confirm: true, expectedReportHash: H1, kinds: ['duplicate'] });
  assert.equal(c.getSnapshot().report.counts.duplicate, 0); assert.equal(c.getSnapshot().fixing, false);
  c.dispose();
});

test('a changed memory stops the fix and shows the new report', async () => {
  const { client } = backend({ changed: true });
  const c = new MemoryHealthController(client);
  await c.load(); c.startFix(); await c.fix();
  assert.match(c.getSnapshot().notice, /changed since the check/);
  assert.equal(c.getSnapshot().report.reportHash, H2);
  c.dispose();
});

test('rules save only what changed; clear cache asks first', async () => {
  const { client, calls } = backend();
  const c = new MemoryHealthController(client);
  await c.load();
  assert.equal(c.rulesChanged(), false);
  c.editRetention({ enabled: true, taskTtlDays: 30 }); c.editImport({ intervalMinutes: 60 });
  await c.saveRules();
  assert.deepEqual(calls.find(r => r.method === 'PUT' && r.path === '/api/memory/retention').body, { enabled: true, taskTtlDays: 30 });
  assert.deepEqual(calls.find(r => r.method === 'PUT' && r.path === '/api/memory/import/local/automatic').body, { enabled: true, intervalMinutes: 60 });
  assert.equal(c.getSnapshot().result, 'Rules saved.');
  c.askClear(); await c.clearCache();
  assert.deepEqual(calls.find(r => r.path === '/api/memory/cache/clear').body, { confirm: true });
  assert.match(c.getSnapshot().result, /Cache cleared \(3 entries\)/);
  c.dispose();
});
