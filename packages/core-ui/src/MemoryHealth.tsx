// MEM-UI-01 P7 (board M7, with M13 / M15 / M16 changes): health check with the
// safe-fix dialog, review rules per scope, speed, backup.
import { useSyncExternalStore } from 'react';
import { CHECKS, MemoryHealthController } from './memory-health';
import type { RulesDraft } from './memory-health';
import { ago, drawerName } from './memory-store';
import { SafeFixDialog } from './MemoryDialogs';
import type { CacheMetrics } from './memory-recall-contract.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const scopeName = (x: string) => (x === 'default' ? 'default' : x === 'company' ? 'company' : x.startsWith('department:') ? `department ${x.slice(11)}` : drawerName(x));

/** Speed: cache hit rates as bars, then the numbers (Health › cache and a reply's details, board M15). */
export function SpeedCard({ m, title = 'Speed: cache and context' }: { m: CacheMetrics | null; title?: string }) {
  const rate = (x: number | null | undefined) => (x === null || x === undefined ? null : Math.round(x * 100));
  const bars: Array<[string, number | null]> = [['Context pack', rate(m?.recent.packHitRate ?? m?.process.caches.pack.hitRate)], ['Recall', rate(m?.process.caches.recall.hitRate)], ['Meaning index', rate(m?.process.caches.embedding.hitRate)]];
  const sec = (ms: number | null | undefined) => (ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(1)} s`);
  const chars = m?.recent.avgPackChars ?? m?.process.packChars.avg;
  return <section className="mem-card mem-speed" aria-label="Cache and context">
    <div className="mem-card-head"><h3>{title}</h3><span className="fine-print">{m?.recent.turns ? `last ${m.recent.turns} replies` : 'since start'}</span></div>
    {bars.map(([label, v]) => <div key={label} className="mem-speed-bar"><span>{label}</span><span className="mem-speed-track"><span style={{ inlineSize: `${v ?? 0}%` }} data-bar={label}/></span><span>{v === null ? '—' : `${v}%`}</span></div>)}
    <span className="mem-line"><span>Pack size (average)</span><span>{chars ? `≈ ${(Math.round(chars / 400) / 10).toFixed(1)}k tokens` : '—'}</span></span>
    <span className="mem-line"><span>First word p50 · p90</span><span>{sec(m?.recent.ttftMs.p50 ?? m?.process.ttftMs.p50)} · {sec(m?.recent.ttftMs.p90 ?? m?.process.ttftMs.p90)}</span></span>
    <span className="mem-line"><span>Model context window</span><span>{m?.budget.numCtx ? `${Math.round(m.budget.numCtx / 1024)}k` : '—'}</span></span>
    <span className="mem-line"><span>Summary budget</span><span>{m ? (m.budget.summaryTokens > 0 ? `${(m.budget.summaryTokens / 1000).toFixed(1)}k tokens` : 'off') : '—'}</span></span>
    <span className="mem-line"><span>Model kept loaded</span><span>{m?.budget.keepAlive || '—'}</span></span>
    <span className="fine-print">A cache entry is dropped when its scope changes; nothing to clear by hand.</span>
  </section>;
}

const TTL = [30, 60, 90, 180, 365];

export function HealthView({ c, conflicts, onReview, onFiles }: { c: MemoryHealthController; conflicts: number | null; onReview: () => void; onFiles: () => void }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  if (s.phase === 'error') return <p className="empty-note">{s.notice} <button type="button" className="link-button" onClick={() => void c.load()}>Try again</button></p>;
  if (s.phase !== 'ready') return <p className="empty-note" role="status">Checking the memory…</p>;
  const r = s.report; const m = s.metrics; const rd = s.retentionDraft; const id = s.importDraft;
  const fixTotal = c.count(c.fixable());
  return <div className="mem-health">
    {s.notice && !s.fixing && <p className="card-notice" role="alert">{s.notice}</p>}
    {s.result && <p className="memory-status" role="status">{s.result}</p>}
    <SafeFixDialog c={c}/>
    <div className="mem-health-grid">
      <section className="mem-card" aria-label="Health check">
        <div className="mem-card-head"><h3>Health check</h3><span className="fine-print">{r ? `checked ${ago(r.checkedAt) === 'now' ? 'just now' : `${ago(r.checkedAt)} ago`} · ${r.total} memories` : 'not checked'}</span></div>
        {CHECKS.map(ch => { const n = c.count(ch.kinds);
          return <div key={ch.label} className="mem-check"><span className="mem-dot" data-health={n ? 'attention' : 'ok'}/><span className="mem-check-label">{ch.label}<small className="fine-print">{ch.kinds.includes('embedding-missing') && r?.embeddingModel ? `every memory indexed with ${r.embeddingModel}` : ch.note}</small></span><span className="mem-check-count">{n}</span></div>; })}
        <div className="mem-check"><span className="mem-dot" data-health={conflicts ? 'problem' : 'ok'}/><span className="mem-check-label">Open conflicts<small className="fine-print">waiting in Review</small></span><button type="button" className="link-button mem-check-count" onClick={onReview}>{conflicts ?? '…'}</button></div>
        {!s.fixing && <div className="actions mem-push-down">
          <button type="button" disabled={s.busy} onClick={() => void c.check()}>Check again</button>
          <button type="button" className="primary" disabled={s.busy || !fixTotal} onClick={() => c.startFix()}>Review safe fixes ({fixTotal})…</button>
        </div>}
        {s.fixed && <p className="fine-print" role="status">Fixed {Object.values(s.fixed.fixed).reduce((a, b) => a + b, 0)}{s.fixed.skipped.length ? `; ${s.fixed.skipped.length} skipped (changed meanwhile)` : ''}.</p>}
        <span className="fine-print">Nothing changes until you confirm each fix.</span>
      </section>
      <section className="mem-card" aria-label="Rules">
        <div className="mem-card-head"><h3>Rules</h3><span className="fine-print">{s.rules ? (s.rules.scope === 'company' ? 'for the whole company' : `for ${scopeName(s.rules.scope)}`) : ''}</span></div>
        {s.rules && s.rulesDraft ? <RuleFields c={c} d={s.rulesDraft} from={s.rules.effective.from} company={s.rules.scope === 'company'}/> : <>
          <div className="mem-rule"><span>Routine facts</span><span className="fine-print">Saved automatically</span></div>
          <div className="mem-rule"><span>Important facts (family, money, health)</span><span className="fine-print">Ask me first (Review)</span></div>
          <div className="mem-rule"><span>When a new fact contradicts an old one</span><span className="fine-print">Ask me (Review: keep new / old / both)</span></div>
        </>}
        {rd && <>
          <label className="check mem-rule"><input type="checkbox" checked={rd.enabled} onChange={e => c.editRetention({ enabled: e.target.checked })}/>Apply the keeping rules below</label>
          <label className="mem-rule-field">Keep Tasks drawer items<select value={rd.taskTtlDays} onChange={e => c.editRetention({ taskTtlDays: Number(e.target.value) })}>{[...new Set([...TTL, rd.taskTtlDays])].sort((a, b) => a - b).map(d => <option key={d} value={d}>{d} days, then forget</option>)}</select></label>
          <label className="mem-rule-field">Summarise lessons older than<select value={rd.experienceAfterDays} onChange={e => c.editRetention({ experienceAfterDays: Number(e.target.value) })}>{[...new Set([...TTL, rd.experienceAfterDays])].sort((a, b) => a - b).map(d => <option key={d} value={d}>{d} days</option>)}</select></label>
        </>}
        {id && <label className="mem-rule-field">Import from other agents<select value={id.enabled ? id.intervalMinutes : 0} onChange={e => { const v = Number(e.target.value); c.editImport(v ? { enabled: true, intervalMinutes: v as 15 | 30 | 60 } : { enabled: false }); }}>
          <option value={0}>Off</option><option value={15}>Every 15 minutes</option><option value={30}>Every 30 minutes</option><option value={60}>Every 60 minutes</option></select></label>}
        {!(s.rules?.scope === 'company') && <div className="mem-rule"><span>Weekly summary</span><span className="fine-print">Built each week (read it on Home)</span></div>}
        <div className="actions"><button type="button" className="primary" disabled={s.busy || !c.rulesChanged()} onClick={() => void c.saveRules()}>Save rules</button></div>
        <span className="mem-secret-note">Secrets are never saved to memory: they go to the key store.</span>
      </section>
      <div className="mem-col">
        <SpeedCard m={m}/>
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

/** The scope's review rules: its own value or "as <parent>" (inherit); the weekly summary time for the company. */
function RuleFields({ c, d, from, company }: { c: MemoryHealthController; d: RulesDraft; from: Record<'routine' | 'important' | 'contradiction', string>; company: boolean }) {
  const inherit = (k: 'routine' | 'important' | 'contradiction') => <option value="inherit">{company ? 'Default' : `As ${scopeName(from[k] === 'default' ? 'company' : from[k])}`}</option>;
  return <>
    <label className="mem-rule-field">Routine facts<select value={d.routine} onChange={e => c.editScopeRules({ routine: e.target.value as RulesDraft['routine'] })}>{inherit('routine')}<option value="save">Save automatically</option><option value="ask">Ask me first (Review)</option></select></label>
    <label className="mem-rule-field">Important facts (family, money, health)<select value={d.important} onChange={e => c.editScopeRules({ important: e.target.value as RulesDraft['important'] })}>{inherit('important')}<option value="ask">Ask me first (Review)</option><option value="save">Save automatically</option></select></label>
    <label className="mem-rule-field">When a new fact contradicts an old one<select value={d.contradiction} onChange={e => c.editScopeRules({ contradiction: e.target.value as RulesDraft['contradiction'] })}>{inherit('contradiction')}<option value="ask">Ask me (keep new / old / both)</option><option value="keep_new">Keep the new one</option><option value="keep_both">Keep both</option></select></label>
    {company && <label className="mem-rule-field">Weekly summary<span className="mem-rule-pair">
      <select aria-label="Weekly summary day" value={d.weeklyDay} onChange={e => c.editScopeRules({ weeklyDay: Number(e.target.value) })}>{DAYS.map((x, i) => <option key={x} value={i}>{x}</option>)}</select>
      <select aria-label="Weekly summary hour" value={d.weeklyHour} onChange={e => c.editScopeRules({ weeklyHour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select>
    </span></label>}
    <span className="fine-print">Credentials, outside senders, permissions and overwrites always wait for you, whatever the rules say.</span>
  </>;
}
