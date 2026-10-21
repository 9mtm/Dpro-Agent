/**
 * Background sync of the memory bridge (MEM-BRIDGE-01, startup.ts, background
 * jobs on): every minute the managed files of confirmed folders are rewritten
 * (inside Dpro's markers only) when the project's facts or handoff changed,
 * and back-flow runs for folders where the owner turned it on. Before that,
 * coding apps and project folders connect on their own once the owner allowed
 * reading this computer (service.ts autoConnect, MEM-UX-02).
 * Errors are logged, never thrown.
 */
import { bridgeOwner } from './store.js';
import { autoConnect, syncOwner } from './service.js';
import { allowedFolders } from '../../discovery/places.js';

const EVERY_MS = 60_000;
let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

export async function syncMemoryBridge(): Promise<{ written: number; proposed: number; conflicts: number } | null> {
  const owner = await bridgeOwner();
  if (!owner) return null;
  // MEM-UX-02: coding apps connect on their own once the owner allowed reading this computer.
  const allowed = (await allowedFolders(owner).catch(() => ({ allow: [] as string[] }))).allow.length > 0;
  const auto = await autoConnect(owner, allowed);
  if (auto.registered.length || auto.folders.length) console.log(`[Memory bridge] connected on its own: ${auto.registered.join(', ') || 'no app'}; ${auto.folders.length} project folder(s)`);
  const r = await syncOwner(owner);
  return { ...r, conflicts: r.conflicts + auto.conflicts };
}

export function startMemoryBridgeSync(): void {
  if (timer) return;
  const tick = () => {
    if (running) return;
    running = true;
    syncMemoryBridge()
      .then((r) => { if (r && (r.written || r.proposed || r.conflicts)) console.log(`[Memory bridge] ${r.written} file(s) updated, ${r.proposed} proposal(s), ${r.conflicts} conflict(s)`); })
      .catch((err) => console.warn('[Memory bridge] sync failed:', (err as Error)?.message))
      .finally(() => { running = false; });
  };
  timer = setInterval(tick, EVERY_MS);
  timer.unref?.();
}

export function stopMemoryBridgeSync(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
