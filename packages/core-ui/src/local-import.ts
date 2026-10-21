import type { SessionClient } from './session';
import { LOCAL_IMPORT_PATH, MAX_IMPORT_SESSIONS } from './local-import-contract.js';
import type { ImportJob, LocalSession, LocalSource } from './local-import-contract.js';
export type ConversationPreview = { id: string; source: LocalSource; messages: { role: 'user' | 'assistant'; text: string }[]; truncated: boolean };
export type LocalImportState = Readonly<{
  phase: 'idle' | 'loading' | 'ready' | 'error'; sessions: readonly LocalSession[]; selected: readonly string[];
  job?: ImportJob; notice?: string; archive: string; busy?: boolean;
  progress?: { total: number; done: number; proposed: number };
  preview?: ConversationPreview; previewLoading?: string; previewError?: string;
}>;
const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
/** UI follows durable server jobs; leaving this page never cancels an import. */
export class LocalImportController {
  #state: LocalImportState = Object.freeze({ phase: 'idle', sessions: [], selected: [], archive: '' });
  #listeners = new Set<() => void>(); #timer: ReturnType<typeof setTimeout> | undefined; #disposed = false;
  #jobTicket = 0;
  #starting = false; #pollErrors = 0; #previewTicket = 0;
  constructor(private readonly client: SessionClient, private readonly pollMs = 1500) {}
  getSnapshot = () => this.#state;
  subscribe = (fn: () => void) => { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; };
  private publish(p: Partial<LocalImportState>) { if (!this.#disposed) { this.#state = Object.freeze({ ...this.#state, ...p }); this.#listeners.forEach(fn => fn()); } }
  private job(job: ImportJob) { this.publish({ job, busy: job.status === 'running', progress: { total: job.total, done: job.done, proposed: job.proposed } }); if (job.status === 'running') this.poll(job.id); else clearTimeout(this.#timer); }
  async load() {
    if (this.#disposed) return; const ticket = this.#jobTicket; this.publish({ phase: 'loading', notice: undefined });
    try {
      const r = await this.client.request({ method: 'GET', path: LOCAL_IMPORT_PATH } as never);
      if (this.#disposed || ticket !== this.#jobTicket) return;
      if (r.status === 200 && record(r.body) && Array.isArray(r.body.sessions)) {
        this.publish({ phase: 'ready', sessions: r.body.sessions as LocalSession[], archive: String(r.body.archive ?? '') });
        if (record(r.body.job)) this.job(r.body.job as ImportJob);
      } else this.publish({ phase: 'error', notice: 'The conversations could not be read. Check this computer and try again.' });
    } catch { this.publish({ phase: 'error', notice: 'The conversations could not be read (no connection).' }); }
  }
  selectAll(ids: string[]) {
    if (this.#disposed || this.#state.busy) return;
    const known = new Set(this.#state.sessions.map(x => x.id));
    this.publish({ selected: [...new Set(ids)].filter(x => known.has(x)).slice(0, MAX_IMPORT_SESSIONS), notice: undefined });
  }
  toggle(id: string) {
    if (this.#disposed || this.#state.busy || !this.#state.sessions.some(x => x.id === id)) return;
    const s = this.#state.selected; if (s.includes(id)) this.publish({ selected: s.filter(x => x !== id) });
    else if (s.length < MAX_IMPORT_SESSIONS) this.publish({ selected: [...s, id] });
  }
  clear() { this.publish({ selected: [] }); }
  async start() { if (!this.#state.selected.length) return; await this.submit(LOCAL_IMPORT_PATH, { sessionIds: [...this.#state.selected] }); }
  async importDocuments(ids: string[]) { if (ids.length) await this.submit(LOCAL_IMPORT_PATH, { sessionIds: [...ids] }); }
  async resume() { if (this.#state.job) await this.submit(`${LOCAL_IMPORT_PATH}/jobs/${this.#state.job.id}/resume`); }
  async pause() {
    if (this.#disposed || this.#starting || this.#state.job?.status !== 'running') return;
    this.#starting = true; this.#jobTicket++;
    clearTimeout(this.#timer);
    try {
      const r = await this.client.request({ method: 'POST', path: `${LOCAL_IMPORT_PATH}/jobs/${this.#state.job.id}/pause` } as never);
      if (r.status === 202 && record(r.body) && record(r.body.job)) this.job(r.body.job as ImportJob);
      else { this.publish({ notice: 'Pause could not be confirmed. Check saved progress before trying again.' }); void this.load(); }
    } catch { this.publish({ notice: 'Pause could not be confirmed (no connection). Check saved progress.' }); }
    finally { this.#starting = false; }
  }
  private async submit(path: string, body?: unknown) {
    if (this.#disposed || this.#starting || this.#state.busy) return; this.#starting = true; this.publish({ busy: true, notice: undefined });
    try {
      const r = await this.client.request({ method: 'POST', path, ...(body === undefined ? {} : { body }) } as never);
      if (r.status === 202 && record(r.body) && record(r.body.job)) { this.publish({ selected: [] }); this.#pollErrors = 0; this.job(r.body.job as ImportJob); }
      else if (r.status === 409 && record(r.body) && r.body.code === 'import_running') this.publish({ busy: false, notice: 'Another import is not finished yet (running or paused). Resume it and let it end, then start this one.' });
      else this.publish({ busy: false, notice: 'The import could not start. Reload to check the saved job before trying again.' });
    } catch { this.publish({ busy: false, notice: 'Connection lost. The server may still be importing; reload to check saved progress.' }); }
    finally { this.#starting = false; }
  }
  async preview(id: string) {
    if (this.#disposed || !this.#state.sessions.some(s => s.id === id)) return;
    const ticket = ++this.#previewTicket; this.publish({ preview: undefined, previewLoading: id, previewError: undefined });
    try {
      const r = await this.client.request({ method: 'GET', path: `${LOCAL_IMPORT_PATH}/sessions/${id}` } as never);
      if (this.#disposed || ticket !== this.#previewTicket) return;
      if (r.status !== 200 || !record(r.body)) throw Error();
      this.publish({ preview: r.body as ConversationPreview, previewLoading: undefined });
    } catch { if (ticket === this.#previewTicket) this.publish({ previewLoading: undefined, previewError: 'This conversation could not be previewed.' }); }
  }
  closePreview() { this.#previewTicket++; this.publish({ preview: undefined, previewLoading: undefined, previewError: undefined }); }
  private poll(id: string) {
    clearTimeout(this.#timer); if (this.#disposed) return;
    const ticket = this.#jobTicket;
    this.#timer = setTimeout(async () => {
      try {
        const r = await this.client.request({ method: 'GET', path: `${LOCAL_IMPORT_PATH}/jobs/${id}` } as never);
        if (r.status === 200 && record(r.body) && record(r.body.job)) {
          if (this.#disposed || ticket !== this.#jobTicket) return; this.#pollErrors = 0; const job = r.body.job as ImportJob; this.job(job);
          if (job.status !== 'running') void this.load(); return;
        }
      } catch { /* The server job continues without this view. */ }
      if (!this.#disposed && ++this.#pollErrors < 3) this.poll(id);
      else this.publish({ notice: 'Progress is unavailable. The import remains saved on this computer; reopen this page to check it.' });
    }, this.pollMs);
  }
  dispose() { clearTimeout(this.#timer); this.#disposed = true; this.#previewTicket++; this.#listeners.clear(); this.#state = Object.freeze({ phase: 'idle', sessions: [], selected: [], archive: '' }); }
}
