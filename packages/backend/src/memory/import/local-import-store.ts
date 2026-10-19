/** Durable local import journal: opaque source ids and preview receipts, never transcript text. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dataPath } from '../../config/data-root.js';
import type { ImportJob } from './local-import.js';
export type PreviewCheckpoint = { id: string; version: number; hash: string; key: string; include: boolean; count?: number; proposals?: string[] };
export type SessionCheckpoint = { id: string; source: string; archive: string; dropped: number; rebuild?: boolean; previews: PreviewCheckpoint[] };
export type SavedImport = ImportJob & { v: 1; ids: string[]; cursor: number; skipped: number; automatic?: boolean; current?: SessionCheckpoint };
const UUID = /^[0-9a-f-]{36}$/;
const writes = new Map<string, Promise<void>>();
const folder = () => dataPath('local-import-jobs');
async function directory() { const dir = folder(); await fs.mkdir(dir, { recursive: true, mode: 0o700 }); return dir; }
/** Retry only Windows sharing violations; each attempt remains an atomic rename. */
export async function replaceJournal(temp: string, file: string, options: { platform?: string; rename?: typeof fs.rename; delay?: (ms: number) => Promise<void> } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { await (options.rename ?? fs.rename)(temp, file); return; }
    catch (error: any) {
      if ((options.platform ?? process.platform) !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 4) throw error;
      await (options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(25 * (attempt + 1));
    }
  }
}
export async function saveImport(job: SavedImport): Promise<void> {
  const snapshot = JSON.stringify(job);
  const previous = writes.get(job.id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const dir = await directory(), file = path.join(dir, `${job.id}.json`), temp = `${file}.${randomUUID()}.tmp`;
    const fd = await fs.open(temp, 'wx', 0o600);
    try { await fd.writeFile(snapshot); await fd.sync(); } finally { await fd.close(); }
    await replaceJournal(temp, file);
    if (process.platform !== 'win32') { const parent = await fs.open(dir, 'r'); try { await parent.sync(); } finally { await parent.close(); } }
  });
  writes.set(job.id, next); await next;
}
export async function savedImports(): Promise<SavedImport[]> {
  const dir = await directory(), out: SavedImport[] = [];
  for (const file of await fs.readdir(dir)) {
    if (!UUID.test(file.replace(/\.json$/, '')) || !file.endsWith('.json')) continue;
    const j = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')) as SavedImport;
    if (j.v !== 1 || !UUID.test(j.id) || typeof j.userId !== 'string' || !Array.isArray(j.ids) || j.ids.length > 400 || j.ids.some(id => !/^[a-f0-9]{32}$/.test(id)) || new Set(j.ids).size !== j.ids.length || !Number.isInteger(j.cursor) || j.cursor < 0 || j.cursor > j.ids.length) throw new Error('Saved import progress is invalid');
    out.push(j);
  }
  return out.sort((a,b) => b.startedAt - a.startedAt);
}
/** One live worker per owner across local processes. A dead process's lease is recoverable. */
export async function importLease(userId: string): Promise<null | (() => Promise<void>)> {
  const dir = await directory(), key = createHash('sha256').update(userId).digest('hex');
  const file = path.join(dir, `${key}.lock`), nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = await fs.open(file, 'wx', 0o600);
      try { await fd.writeFile(JSON.stringify({ pid: process.pid, nonce })); await fd.sync(); } finally { await fd.close(); }
      return async () => { try { const current = JSON.parse(await fs.readFile(file, 'utf8')); if (current.nonce === nonce) await fs.unlink(file); } catch { /* already released */ } };
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
      let lease; try { lease = JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
      if (!Number.isInteger(lease.pid) || lease.pid < 1) return null;
      try { process.kill(lease.pid, 0); return null; }
      catch (error: any) { if (error.code !== 'ESRCH') return null; }
      await fs.unlink(file).catch(() => {});
    }
  }
  return null;
}
