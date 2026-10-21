// MEM-UI-01: the small external store every memory page controller uses
// (React reads it with useSyncExternalStore) and the owner's request helper.
import type { WireResponse } from './session';

export type Requester = { request: (r: never) => Promise<WireResponse> };
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class Store<S extends object> {
  #state: Readonly<S>;
  #listeners = new Set<() => void>();
  #disposed = false;
  constructor(initial: S, protected readonly client: Requester) { this.#state = Object.freeze({ ...initial }); }
  getSnapshot = () => this.#state;
  subscribe = (fn: () => void) => { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; };
  get disposed() { return this.#disposed; }
  protected publish(p: Partial<S>) { if (this.#disposed) return; this.#state = Object.freeze({ ...this.#state, ...p }); this.#listeners.forEach(fn => fn()); }
  dispose() { this.#disposed = true; this.#listeners.clear(); }
  protected req(method: Method, path: string, body?: unknown): Promise<WireResponse> {
    return this.client.request((body === undefined ? { method, path } : { method, path, body }) as never);
  }
  /** GET that answers the body on 200, else null (never throws). */
  protected async read<T>(path: string): Promise<T | null> {
    try { const r = await this.req('GET', path); return r.status === 200 ? r.body as T : null; } catch { return null; }
  }
}

/** The machine code of a refused change, if the contract kept one. */
export const codeOf = (r: WireResponse): string | undefined => (r.body && typeof r.body === 'object' && typeof (r.body as { code?: unknown }).code === 'string' ? (r.body as { code: string }).code : undefined);

/** "10 min", "3 h", "yesterday", "2 days", "12 Aug". */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso.length === 19 ? `${iso}Z` : iso);
  if (!Number.isFinite(t)) return '';
  const min = Math.max(0, Math.round((now - t) / 60000));
  if (min < 1) return 'now';
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days`;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

const KIND_LABEL: Record<string, string> = { owner: 'About you', experience: 'Lessons', project: 'Projects', task: 'Tasks', people: 'People' };
/** "About you", "Projects · flowxtra", "People · ahmed". */
export function drawerName(id: string): string {
  const i = id.indexOf(':');
  return i < 0 ? KIND_LABEL[id] ?? id : `${KIND_LABEL[id.slice(0, i)] ?? id.slice(0, i)} · ${id.slice(i + 1)}`;
}
export const kindLabel = (k: string) => KIND_LABEL[k] ?? k;
/** Agent id → shown name ("_main" is the Main Agent). */
export function agentLabel(id: string | null | undefined, names: Readonly<Record<string, string>>): string {
  if (!id) return '';
  const plain = id.startsWith('agent:') ? id.slice(6) : id;
  return names[plain] ?? (plain === '_main' ? 'Main Agent' : plain);
}

/** One line for a list: Markdown heading marks removed, lines joined. */
export function oneLine(text: string): string {
  return text.split('\n').map(l => l.replace(/^#{1,6}\s+/, '').trim()).filter(Boolean).join(' — ');
}
