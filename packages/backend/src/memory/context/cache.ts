/**
 * In-process caches of the context pack and per-message recall
 * (MEM-CACHE-01). Entries are keyed by memory revisions (revisions.ts), so a
 * changed memory is never served; forget (CORE-07) also drops the user's
 * entries right away so the forgotten text does not stay in RAM.
 */

export class LruCache<V> {
  private readonly map = new Map<string, { userId: string; value: V }>();
  constructor(private readonly size: number) {}
  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }
  set(key: string, userId: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, { userId, value });
    while (this.map.size > this.size) this.map.delete(this.map.keys().next().value as string);
  }
  dropUser(userId: string): void {
    for (const [k, e] of this.map) if (e.userId === userId) this.map.delete(k);
  }
  clear(): void { this.map.clear(); }
  get entries(): number { return this.map.size; }
}

export const PACK_CACHE_SIZE = 100;
export const RECALL_CACHE_SIZE = 300;

const caches: Array<LruCache<unknown>> = [];

export function registerCache<V>(size: number): LruCache<V> {
  const c = new LruCache<V>(size);
  caches.push(c as LruCache<unknown>);
  return c;
}

/** Drop every cached pack and recall of a user (forget). */
export function dropContextCache(userId: string): void {
  for (const c of caches) c.dropUser(userId);
}

/** Test hook. */
export function clearContextCaches(): void {
  for (const c of caches) c.clear();
}

export function contextCacheEntries(): number {
  return caches.reduce((n, c) => n + c.entries, 0);
}
