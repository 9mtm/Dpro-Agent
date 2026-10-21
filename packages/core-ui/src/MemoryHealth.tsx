// MEM-UI-01 P7 (board M7): health check with safe fixes, rules, speed, backup.
import { useSyncExternalStore } from 'react';
import { CHECKS, MemoryHealthController } from './memory-health';
import { ago } from './memory-store';

const TTL = [30, 60, 90, 180, 365];
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);

export function HealthView({ c, conflicts, onReview, onFiles }: { c: MemoryHealthController; conflicts: number | null; onReview: () => void; onFiles: () => void }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  if (s.phase === 'error') return <p className="empty-note">{s.notice} <button type="button" className="link-button" onClick={() => void c.load()}>Try again</button></p>;
  if (s.phase !== 'ready') return <p className="empty-note" role="status">Checking the memory…</p>;
  const r = s.report; const m = s.metrics; const rd = s.retentionDraft; const id = s.importDraft;
  const fixTotal = c.count(c.fixable());
  return <div className="mem-health">
    {s.notice && <p className="card-notice" role="alert">{s.notice}</p>}
    {s.result && <p className="memory-status" role="status">{s.result}</p>}
    <div className="mem-health-grid">
      <section className="mem-card" aria-label="Health check">
        <div className="mem-card-head"><h3>Health check</h3><span className="fine-print">{r ? `checked ${ago(r.checkedAt) === 'now' ? 'just now' : `${ago(r.checkedAt)} ago`} · ${r.total} memories` : 'not checked'}</span></div>
        {CHECKS.map(ch => { const n = c.count(ch.kinds);
          return <div key={ch.label} className="mem-check"><span className="mem-dot" data-health={n ? 'attention' : 'ok'}/><span className="mem-check-label">{ch.label}<small className="fine-print">{ch.kinds.includes('embedding-missing') && r?.embeddingModel ? `every memory indexed with ${r.embeddingModel}` : ch.note}</small></span><span className="mem-check-count">{n}</span></div>; })}
        <div className="mem-check"><span className="mem-dot" data-health={conflicts ? 'problem' : 'ok'}/><span className="mem-check-label">Open conflicts<small className="fine-print">waiting in Review</small></span><button type="button" className="link-button mem-check-count" onClick={onReview}>{conflicts ?? '…'}</button></div>
        {s.fixing ? <div className="mem-fix">
          <p className="fine-print">Choose what to fix. Nothing changes until you confirm.</p>
          {CHECKS.flatMap(ch => ch.kinds).filter(k => (r?.counts[k] ?? 0) > 0).map(k => <label key={k} className="check"><input type="checkbox" checked={s.kinds.includes(k)} onChange={() => c.toggleKind(k)}/>{CHECKS.find(ch => ch.kinds.includes(k))!.label} · {k.replace(/-/g, ' ')} ({r!.counts[k]})</label>)}
          <div className="actions"><button type="button" className="primary" disabled={s.busy || !s.kinds.length} onClick={() => void c.fix()}>Confirm: fix {c.count(s.kinds)}</button><button type="button" onClick={() => c.cancelFix()}>Cancel</button></div>
        </div> : <div className="actions mem-push-down">
          <button type="button" disabled={s.busy} onClick={() => void c.check()}>Check again</button>
          <button type="button" className="primary" disabled={s.busy || !fixTotal} onClick={() => c.startFix()}>Review safe fixes ({fixTotal})…</button>
        </div>}
        {s.fixed && <p className="fine-print" role="status">Fixed {Object.values(s.fixed.fixed).reduce((a, b) => a + b, 0)}{s.fixed.skipped.length ? `; ${s.fixed.skipped.length} skipped (changed meanwhile)` : ''}.</p>}
        <span className="fine-print">Nothing changes until you confirm each fix.</span>
      </section>
      <section className="mem-card" aria-label="Rules">
        <h3>Rules</h3>
        <div className="mem-rule"><span>Routine facts</span><span className="fine-print">Saved automatically</span></div>
        <div className="mem-rule"><span>Important facts (family, money, health)</span><span className="fine-print">Ask me first (Review)</span></div>
        <div className="mem-rule"><span>When a new fact contradicts an old one</span><span className="fine-print">Ask me (Review: keep new / old / both)</span></div>
        {rd && <>
          <label className="check mem-rule"><input type="checkbox" checked={rd.enabled} onChange={e => c.editRetention({ enabled: e.target.checked })}/>Apply the keeping rules below</label>
          <label className="mem-rule-field">Keep Tasks drawer items<select value={rd.taskTtlDays} onChange={e => c.editRetention({ taskTtlDays: Number(e.target.value) })}>{[...new Set([...TTL, rd.taskTtlDays])].sort((a, b) => a - b).map(d => <option key={d} value={d}>{d} days, then forget</option>)}</select></label>
          <label className="mem-rule-field">Summarise lessons older than<select value={rd.experienceAfterDays} onChange={e => c.editRetention({ experienceAfterDays: Number(e.target.value) })}>{[...new Set([...TTL, rd.experienceAfterDays])].sort((a, b) => a - b).map(d => <option key={d} value={d}>{d} days</option>)}</select></label>
        </>}
        {id && <label className="mem-rule-field">Import from other agents<select value={id.enabled ? id.intervalMinutes : 0} onChange={e => { const v = Number(e.target.value); c.editImport(v ? { enabled: true, intervalMinutes: v as 15 | 30 | 60 } : { enabled: false }); }}>
          <option value={0}>Off</option><option value={15}>Every 15 minutes</option><option value={30}>Every 30 minutes</option><option value={60}>Every 60 minutes</option></select></label>}
        <div className="mem-rule"><span>Weekly summary</span><span className="fine-print">Built each week (read it on Home)</span></div>
        <div className="actions"><button type="button" className="primary" disabled={s.busy || !c.rulesChanged()} onClick={() => void c.saveRules()}>Save rules</button></div>
        <span className="mem-secret-note">Secrets are never saved to memory: they go to the key store.</span>
      </section>
      <div className="mem-col">
        <section className="mem-card" aria-label="Cache and context">
          <h3>Speed: cache and context</h3>
          <span className="mem-line"><span>Context pack from cache</span><span>{pct(m?.recent.packHitRate ?? m?.process.caches.pack.hitRate)}</span></span>
          <span className="mem-line"><span>Time to first word (median)</span><span>{m?.recent.ttftMs.p50 ?? m?.process.ttftMs.p50 ? `${(((m?.recent.ttftMs.p50 ?? m?.process.ttftMs.p50) as number) / 1000).toFixed(1)} s` : '—'}</span></span>
          <span className="mem-line"><span>Context pack size</span><span>{m?.recent.avgPackChars ?? m?.process.packChars.avg ? `≈ ${(Math.round(((m?.recent.avgPackChars ?? m?.process.packChars.avg) as number) / 400) / 10).toFixed(1)}k tokens` : '—'}</span></span>
          <span className="mem-line"><span>Model context window</span><span>{m?.budget.numCtx ? `${Math.round(m.budget.numCtx / 1024)}k` : '—'}</span></span>
          <span className="mem-line"><span>Older turns kept as summaries</span><span>{m ? (m.budget.summaryTokens > 0 ? 'yes' : 'no') : '—'}</span></span>
          {s.confirmClear ? <span className="confirm-inline">Clear the cached context? The next reply builds it again.<button type="button" className="link-button" disabled={s.busy} onClick={() => void c.clearCache()}>Clear</button><button type="button" className="link-button" onClick={() => c.cancelClear()}>Keep</button></span>
            : <button type="button" onClick={() => c.askClear()} disabled={s.busy}>Clear cache</button>}
        </section>
        <section className="mem-card" aria-label="Backup">
          <h3>Backup and export</h3>
          <p>Readable files per drawer, kept in sync. Edits come back as reviews.</p>
          <div className="actions"><button type="button" disabled={s.busy} onClick={() => void download(c)}>Export all</button><button type="button" onClick={onFiles}>Open files view</button></div>
        </section>
      </div>
    </div>
  </div>;
}

async function download(c: MemoryHealthController) {
  const out = await c.exportAll();
  if (!out || typeof document === 'undefined') return;
  const url = URL.createObjectURL(new Blob([out.text], { type: 'text/markdown' }));
  const a = document.createElement('a'); a.href = url; a.download = `dpro-memory-${new Date().toISOString().slice(0, 10)}.md`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
