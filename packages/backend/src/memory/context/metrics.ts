/**
 * Memory cache metrics (MEM-CACHE-01), in process since start: context-pack,
 * per-message recall and embedding cache hits, pack sizes and time to the
 * first word of a reply. Numbers only, no memory text. Persisted per-turn
 * numbers live in memory_recall_traces (see trace.ts).
 */

export type CacheName = 'pack' | 'recall' | 'embedding';

const counters: Record<CacheName, { hits: number; misses: number }> = {
  pack: { hits: 0, misses: 0 },
  recall: { hits: 0, misses: 0 },
  embedding: { hits: 0, misses: 0 },
};
const MAX_SAMPLES = 500;
const ttft: number[] = [];
const packChars: number[] = [];
let since = new Date().toISOString();

export function countCache(name: CacheName, hit: boolean): void {
  counters[name][hit ? 'hits' : 'misses']++;
}

const push = (list: number[], v: number) => { list.push(v); if (list.length > MAX_SAMPLES) list.shift(); };

export function recordPackSize(chars: number): void { push(packChars, Math.max(0, Math.round(chars))); }
export function recordTtft(ms: number): void { push(ttft, Math.max(0, Math.round(ms))); }

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const rate = (c: { hits: number; misses: number }) => (c.hits + c.misses ? c.hits / (c.hits + c.misses) : null);

export function cacheMetrics() {
  const caches = Object.fromEntries((Object.keys(counters) as CacheName[]).map((k) => [k, { ...counters[k], hitRate: rate(counters[k]) }]));
  return {
    since,
    caches,
    packChars: { last: packChars.at(-1) ?? null, avg: packChars.length ? Math.round(packChars.reduce((a, b) => a + b, 0) / packChars.length) : null, samples: packChars.length },
    ttftMs: { last: ttft.at(-1) ?? null, p50: percentile(ttft, 50), p90: percentile(ttft, 90), samples: ttft.length },
  };
}

/** Test hook. */
export function resetCacheMetrics(): void {
  for (const c of Object.values(counters)) { c.hits = 0; c.misses = 0; }
  ttft.length = 0; packChars.length = 0; since = new Date().toISOString();
}
