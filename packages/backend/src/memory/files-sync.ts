/**
 * Background re-export of memory files (MEM-UX-02, startup.ts, background jobs
 * on): every minute, for each active owner, the drawers whose history changed
 * since the last round get their exported files rewritten in every agent
 * folder where they exist, the same way the bridge keeps project files
 * current. A file the owner edited is left alone (memory-files.ts
 * refreshUntouchedExports). The first round after start checks every drawer.
 * Errors are logged, never thrown.
 */
import { all, sql } from '../repositories/sql-steps.js';
import { normalizeDrawer, type DrawerRef } from './drawers.js';
import { refreshUntouchedExports } from './memory-files.js';

const EVERY_MS = 60_000;
let timer: ReturnType<typeof setInterval> | undefined;
let running = false;
/** owner -> drawer id -> history fingerprint seen in the last round. */
const seen = new Map<string, Map<string, string>>();

/** One round for one owner: { drawers checked, files re-exported, files left alone because edited }. */
export async function syncMemoryFiles(ownerId: string): Promise<{ drawers: number; reexported: number; edited: number }> {
  const out = { drawers: 0, reexported: 0, edited: 0 };
  const rows = await sql().read(all<{ drawer_kind: string; drawer_key: string; n: number; last: string | null }>(
    'SELECT drawer_kind, drawer_key, COUNT(*) AS n, MAX(created_at) AS last FROM memory_versions WHERE user_id = ? GROUP BY drawer_kind, drawer_key', ownerId));
  const before = seen.get(ownerId) ?? new Map<string, string>();
  const next = new Map<string, string>();
  for (const r of rows) {
    const id = r.drawer_key ? `${r.drawer_kind}:${r.drawer_key}` : r.drawer_kind;
    const print = `${r.n}|${r.last}`;
    next.set(id, print);
    if (before.get(id) === print) continue;
    let drawer: DrawerRef;
    try { drawer = normalizeDrawer(r.drawer_key ? { kind: r.drawer_kind, key: r.drawer_key } : { kind: r.drawer_kind }); } catch { continue; }
    out.drawers++;
    const res = await refreshUntouchedExports(ownerId, drawer);
    out.reexported += res.reexported.length;
    out.edited += res.edited.length;
  }
  seen.set(ownerId, next);
  return out;
}

export async function syncAllMemoryFiles(): Promise<number> {
  const owners = await sql().read(all<{ id: string }>("SELECT id FROM users WHERE role = 'owner' AND COALESCE(status, 'active') = 'active'"));
  let n = 0;
  for (const o of owners) n += (await syncMemoryFiles(o.id)).reexported;
  return n;
}

export function startMemoryFilesSync(): void {
  if (timer) return;
  const tick = () => {
    if (running) return;
    running = true;
    syncAllMemoryFiles()
      .then((n) => { if (n) console.log(`[Memory files] ${n} exported file(s) brought up to date`); })
      .catch((err) => console.warn('[Memory files] sync failed:', (err as Error)?.message))
      .finally(() => { running = false; });
  };
  timer = setInterval(tick, EVERY_MS);
  timer.unref?.();
}

export function stopMemoryFilesSync(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** Tests: forget what the last rounds saw. */
export function resetMemoryFilesSync(): void { seen.clear(); }
