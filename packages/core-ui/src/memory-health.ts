// MEM-UI-01 P7 (board M7): health check and memory rules. The doctor's
// report; safe fixes run only for the kinds the owner ticks, on the report
// that was shown (its hash) and with confirm: true. Retention rules and the
// automatic import interval are saved explicitly. Speed shows the context
// cache and time to first word; "Clear cache" asks first. "Export all"
// downloads every drawer's readable file.
import { Store, codeOf } from './memory-store';
import type { Requester } from './memory-store';
import type { DoctorFix, DoctorKind, DoctorReport, Retention, RetentionConfig } from './memory-pages-contract.js';
import type { CacheMetrics } from './memory-recall-contract.js';

export type ImportSettings = { enabled: boolean; intervalMinutes: 15 | 30 | 60; status: string; lastRun: number | null };
export type HealthState = Readonly<{
  phase: 'idle' | 'loading' | 'ready' | 'error'; notice?: string; busy: boolean;
  report: DoctorReport | null; fixing: boolean; kinds: readonly DoctorKind[]; fixed?: DoctorFix;
  retention: Retention | null; retentionDraft: RetentionConfig | null;
  importSettings: ImportSettings | null; importDraft: { enabled: boolean; intervalMinutes: 15 | 30 | 60 } | null;
  metrics: CacheMetrics | null; confirmClear: boolean; result?: string;
}>;

/** The doctor kinds as the owner reads them. */
export const CHECKS: ReadonlyArray<{ kinds: DoctorKind[]; label: string; note: string }> = [
  { kinds: ['duplicate'], label: 'Near-duplicates', note: 'same topic, almost the same words' },
  { kinds: ['expired'], label: 'Past retention', note: 'older than the drawer keeps them' },
  { kinds: ['embedding-missing', 'embedding-stale'], label: 'Meaning index', note: 'memories without a current meaning index' },
  { kinds: ['orphan-versions'], label: 'Orphan history', note: 'history of a memory that no longer exists' },
  { kinds: ['broken-drawer'], label: 'Broken drawer names', note: 'project renamed or deleted' },
  { kinds: ['topic-key-invalid'], label: 'Topic keys to repair', note: 'a topic key that is not valid' },
];

export class MemoryHealthController extends Store<HealthState> {
  constructor(client: Requester) {
    super({ phase: 'idle', busy: false, report: null, fixing: false, kinds: [], retention: null, retentionDraft: null, importSettings: null, importDraft: null, metrics: null, confirmClear: false }, client);
  }

  async load() {
    if (this.getSnapshot().phase !== 'ready') this.publish({ phase: 'loading', notice: undefined });
    const [report, retention, auto, metrics] = await Promise.all([
      this.read<DoctorReport>('/api/memory/doctor'),
      this.read<Retention>('/api/memory/retention'),
      this.read<{ settings: ImportSettings }>('/api/memory/import/local/automatic'),
      this.read<CacheMetrics>('/api/memory/cache/metrics'),
    ]);
    if (!report && !retention && !metrics) { this.publish({ phase: 'error', notice: 'Health and rules could not be loaded.' }); return; }
    this.publish({ phase: 'ready', report, retention, retentionDraft: retention ? { ...retention.config } : null, importSettings: auto?.settings ?? null,
      importDraft: auto ? { enabled: auto.settings.enabled, intervalMinutes: auto.settings.intervalMinutes } : null, metrics });
  }
  async check(keepNotice = false) {
    this.publish({ busy: true, fixed: undefined, ...(keepNotice ? {} : { notice: undefined }) });
    const report = await this.read<DoctorReport>('/api/memory/doctor');
    this.publish({ busy: false, ...(report ? { report } : { notice: 'The check did not run.' }) });
  }
  count(kinds: readonly DoctorKind[]) { const r = this.getSnapshot().report; return r ? kinds.reduce((n, k) => n + (r.counts[k] ?? 0), 0) : 0; }
  fixable(): DoctorKind[] { const r = this.getSnapshot().report; return r ? (Object.keys(r.counts) as DoctorKind[]).filter(k => r.counts[k] > 0) : []; }
  startFix() { this.publish({ fixing: true, kinds: this.fixable(), fixed: undefined }); }
  toggleKind(k: DoctorKind) { const ks = this.getSnapshot().kinds; this.publish({ kinds: ks.includes(k) ? ks.filter(x => x !== k) : [...ks, k] }); }
  cancelFix() { this.publish({ fixing: false }); }
  /** Runs the chosen safe fixes on the report that was shown. */
  async fix() {
    const s = this.getSnapshot();
    if (!s.report || !s.kinds.length) return;
    this.publish({ busy: true, notice: undefined });
    try {
      const r = await this.req('POST', '/api/memory/doctor/fix', { confirm: true, expectedReportHash: s.report.reportHash, kinds: [...s.kinds] });
      if (r.status !== 200) {
        const changed = codeOf(r) === 'report_changed';
        this.publish({ busy: false, notice: changed ? 'The memory changed since the check. Here is the new report; look again before fixing.' : 'The fixes did not run.' });
        if (changed) await this.check(true);
        return;
      }
      const fixed = r.body as DoctorFix;
      this.publish({ busy: false, fixing: false, fixed, report: fixed.report });
    } catch { this.publish({ busy: false, notice: 'The fixes have an unknown outcome (no connection). Check again.' }); }
  }

  editRetention(p: Partial<RetentionConfig>) { const d = this.getSnapshot().retentionDraft; if (d) this.publish({ retentionDraft: { ...d, ...p } }); }
  editImport(p: Partial<{ enabled: boolean; intervalMinutes: 15 | 30 | 60 }>) { const d = this.getSnapshot().importDraft; if (d) this.publish({ importDraft: { ...d, ...p } }); }
  rulesChanged() {
    const s = this.getSnapshot();
    const r = s.retention?.config, rd = s.retentionDraft, i = s.importSettings, id = s.importDraft;
    return !!((r && rd && (Object.keys(rd) as (keyof RetentionConfig)[]).some(k => rd[k] !== r[k])) || (i && id && (i.enabled !== id.enabled || i.intervalMinutes !== id.intervalMinutes)));
  }
  async saveRules() {
    const s = this.getSnapshot();
    this.publish({ busy: true, notice: undefined, result: undefined });
    try {
      const r = s.retention?.config, rd = s.retentionDraft;
      if (r && rd) {
        const changed = Object.fromEntries((Object.keys(rd) as (keyof RetentionConfig)[]).filter(k => rd[k] !== r[k]).map(k => [k, rd[k]]));
        if (Object.keys(changed).length) {
          const x = await this.req('PUT', '/api/memory/retention', changed);
          if (x.status !== 200) { this.publish({ busy: false, notice: 'The retention rules were not saved.' }); return; }
          this.publish({ retention: { ...s.retention!, config: (x.body as { config: RetentionConfig }).config } });
        }
      }
      const i = s.importSettings, id = s.importDraft;
      if (i && id && (i.enabled !== id.enabled || i.intervalMinutes !== id.intervalMinutes)) {
        const x = await this.req('PUT', '/api/memory/import/local/automatic', { enabled: id.enabled, intervalMinutes: id.intervalMinutes });
        if (x.status !== 200) { this.publish({ busy: false, notice: 'The import schedule was not saved.' }); return; }
        this.publish({ importSettings: (x.body as { settings: ImportSettings }).settings });
      }
      this.publish({ busy: false, result: 'Rules saved.' });
    } catch { this.publish({ busy: false, notice: 'The rules were not saved (no connection).' }); }
  }

  askClear() { this.publish({ confirmClear: true }); }
  cancelClear() { this.publish({ confirmClear: false }); }
  /** Drops only the owner's cached context; the next reply builds it again. */
  async clearCache() {
    this.publish({ busy: true, notice: undefined });
    try {
      const r = await this.req('POST', '/api/memory/cache/clear', { confirm: true });
      this.publish({ busy: false, confirmClear: false, ...(r.status === 200 ? { result: `Cache cleared (${(r.body as { cleared: number }).cleared} entries). The next reply builds its context again.` } : { notice: 'The cache was not cleared.' }) });
      const metrics = await this.read<CacheMetrics>('/api/memory/cache/metrics');
      if (metrics) this.publish({ metrics });
    } catch { this.publish({ busy: false, notice: 'The cache was not cleared (no connection).' }); }
  }

  /** Every drawer's readable file (as the primary agent sees it) in one Markdown text. */
  async exportAll(): Promise<{ text: string; drawers: number } | null> {
    this.publish({ busy: true, notice: undefined });
    const [d, a] = await Promise.all([this.read<{ drawers: Array<{ kind: string; key?: string }> }>('/api/memory/drawers'), this.read<{ agents: Array<{ id: string; isPrimary?: boolean }> }>('/api/agents')]);
    const agent = a?.agents.find(x => x.isPrimary)?.id ?? a?.agents[0]?.id;
    if (!d || !agent) { this.publish({ busy: false, notice: 'The export could not start.' }); return null; }
    const parts: string[] = [];
    for (const x of d.drawers.slice(0, 500)) {
      const id = x.key ? `${x.kind}:${x.key}` : x.kind;
      const f = await this.read<{ content: string }>(`/api/memory/files/${encodeURIComponent(id)}?agentId=${encodeURIComponent(agent)}`);
      if (f) parts.push(`<!-- drawer: ${id} -->\n${f.content}`);
    }
    this.publish({ busy: false, result: `Exported ${parts.length} drawers.` });
    return { text: parts.join('\n\n'), drawers: parts.length };
  }
}
