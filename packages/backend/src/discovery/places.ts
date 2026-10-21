/**
 * Folders the owner allows Dpro to read, file kinds, "don't show" rules and
 * merged projects (DISCOVER-02, board M18). Nothing outside an allowed folder
 * is walked for project notes; agent folders (~/.claude, ~/.codex, ~/.ssh/config)
 * stay as in M17. Paths work on macOS, Windows and Linux.
 *
 *   places   the home folder's own folders and the drives (macOS /Volumes,
 *            Linux /media and /mnt, Windows drive letters); a tick allows a
 *            folder with everything inside it, also folders added later; a
 *            subfolder of an allowed folder can be left out
 *   kinds    which kinds a scan reads (notes, commands, skills, MCP, SSH)
 *   hidden   "don't show <kind> from this project"
 *   groups   several project folders shown as one project; the folders stay
 *            where they are
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { q } from '../repositories/sql-steps.js';

export const FILE_KINDS = ['notes', 'tools', 'skills', 'mcp', 'ssh', 'design', 'databases'] as const;
export type FileKind = (typeof FILE_KINDS)[number];
export type Kinds = Record<FileKind, boolean>;
export type PlaceState = 'allow' | 'exclude' | null;
export type Place = { id: string; name: string; path: string; kind: 'home' | 'drive' | 'folder' | 'added'; state: PlaceState; inherited: PlaceState; hasChildren: boolean };
export class PlacesError extends Error { constructor(readonly code: string, readonly status = 400) { super(code); } }

const sha = (t: string) => createHash('sha256').update(t).digest('hex');
export const placeId = (p: string) => sha(`place\0${p}`).slice(0, 32);
/** Folders never offered and never walked (the system's own, other programs' data). */
const SYSTEM = new Set(['Library', 'Applications', 'System', 'private', 'usr', 'bin', 'sbin', 'etc', 'var', 'dev', 'opt', 'cores', 'Volumes', 'proc', 'sys', 'boot', 'run', 'snap', 'lost+found', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', '$Recycle.Bin', 'System Volume Information', 'AppData', 'node_modules']);

let ready: Promise<void> | undefined;
export function initPlaces() {
  return ready ??= (async () => {
    await q.run('CREATE TABLE IF NOT EXISTS discovery_places (user_id TEXT NOT NULL, place TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (user_id, place))');
    await q.run('CREATE TABLE IF NOT EXISTS discovery_kinds (user_id TEXT PRIMARY KEY, kinds TEXT NOT NULL)');
    await q.run('CREATE TABLE IF NOT EXISTS discovery_hidden (user_id TEXT NOT NULL, root_id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (user_id, root_id, kind))');
    await q.run('CREATE TABLE IF NOT EXISTS discovery_groups (user_id TEXT NOT NULL, group_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, group_id))');
    await q.run('CREATE TABLE IF NOT EXISTS discovery_group_roots (user_id TEXT NOT NULL, root TEXT NOT NULL, group_id TEXT NOT NULL, PRIMARY KEY (user_id, root))');
    await q.run('CREATE TABLE IF NOT EXISTS discovery_merge_dismissed (user_id TEXT NOT NULL, pair TEXT NOT NULL, PRIMARY KEY (user_id, pair))');
  })().catch((e) => { ready = undefined; throw e; });
}

const isDir = async (p: string) => (await fs.stat(p).catch(() => null))?.isDirectory() === true;
const inside = (p: string, parent: string) => p === parent || p.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** The drives of this computer (not the system disk itself). */
async function drives(platform = process.platform): Promise<string[]> {
  if (platform === 'win32') {
    const out: string[] = [];
    for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (await isDir(`${l}:\\`)) out.push(`${l}:\\`);
    return out;
  }
  const bases = platform === 'darwin' ? ['/Volumes'] : [`/media/${os.userInfo().username}`, '/mnt'];
  const out: string[] = [];
  for (const b of bases) {
    let entries; try { entries = await fs.readdir(b, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(b, e.name);
      // macOS lists the system disk as a link to "/": that is not a separate drive.
      if (e.isSymbolicLink() && (await fs.realpath(p).catch(() => '')) === '/') continue;
      if (await isDir(p)) out.push(p);
    }
  }
  return out;
}
/** A system folder: one of the system's own names at the top of a disk or of the home folder, or a profile's app data. */
export function isSystemPath(p: string, home = os.homedir()): boolean {
  if (p.split(path.sep).includes('AppData')) return true;
  const top = path.parse(p).root;
  const under = (base: string) => { const r = path.relative(base, p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep)[0] : null; };
  const inHome = under(home);
  if (inHome !== null) return SYSTEM.has(inHome);
  // A drive's own top (macOS /Volumes/<drive>, Linux /media/<user>/<drive> and /mnt/<drive>, Windows X:\) counts like a disk.
  const slash = p.split(path.sep).join('/');
  const drive = /^(\/Volumes\/[^/]+|\/media\/[^/]+\/[^/]+|\/mnt\/[^/]+)(\/|$)/.exec(slash)?.[1];
  const first = drive ? under(drive.split('/').join(path.sep)) : under(top);
  if (drive && first === null) return false;
  return first !== null && SYSTEM.has(first) && first !== 'Users' && first !== 'home';
}
async function subfolders(dir: string, limit = 400, home = os.homedir()): Promise<string[]> {
  let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.') && !e.name.startsWith('$') && e.name !== 'node_modules' && !isSystemPath(path.join(dir, e.name), home)).map((e) => path.join(dir, e.name)).sort((a, b) => a.localeCompare(b)).slice(0, limit);
}

type Saved = { place: string; state: 'allow' | 'exclude' };
/** Folders shown to the owner (id → path): only these can be allowed or left out by id. */
const shown = new Map<string, Map<string, string>>();
const remember = (userId: string, list: Place[]) => { if (!shown.has(userId)) shown.set(userId, new Map()); const m = shown.get(userId)!; for (const p of list) m.set(p.id, p.path); if (m.size > 20_000) shown.set(userId, new Map(list.map((p) => [p.id, p.path]))); return list; };
export async function savedPlaces(userId: string): Promise<Saved[]> {
  await initPlaces();
  return q.all<Saved>('SELECT place, state FROM discovery_places WHERE user_id = ?', userId);
}
/** The nearest saved decision above (or at) a path. */
function decided(p: string, saved: Saved[]): PlaceState {
  let best: Saved | null = null;
  for (const s of saved) if (inside(p, s.place) && (!best || s.place.length > best.place.length)) best = s;
  return best?.state ?? null;
}
/** Allowed folders and the folders left out inside them, for a scan. */
export async function allowedFolders(userId: string): Promise<{ allow: string[]; exclude: string[] }> {
  const saved = await savedPlaces(userId);
  return { allow: saved.filter((s) => s.state === 'allow').map((s) => s.place), exclude: saved.filter((s) => s.state === 'exclude').map((s) => s.place) };
}
export const isExcluded = (p: string, exclude: string[]) => exclude.some((e) => inside(p, e));

/** Places to show: the top level (home folders, drives, folders the owner added) or one folder's subfolders. */
export async function listPlaces(userId: string, parent?: string, home = os.homedir()): Promise<Place[]> {
  const saved = await savedPlaces(userId);
  const make = async (p: string, kind: Place['kind']): Promise<Place> => {
    const own = saved.find((s) => s.place === p)?.state ?? null;
    const above = decided(path.dirname(p) === p ? '' : path.dirname(p), saved);
    return { id: placeId(p), name: kind === 'drive' ? path.basename(p) || p : path.basename(p) || p, path: p, kind, state: own, inherited: own ? null : above, hasChildren: (await subfolders(p, 1)).length > 0 };
  };
  if (parent) return remember(userId, await Promise.all((await subfolders(parent, 400, home)).map((p) => make(p, 'folder'))));
  const top: [string, Place['kind']][] = [...(await subfolders(home, 400, home)).map((p): [string, Place['kind']] => [p, 'home']), ...(await drives()).map((p): [string, Place['kind']] => [p, 'drive'])];
  for (const s of saved) if (!top.some(([p]) => inside(s.place, p))) top.push([s.place, 'added']);
  return remember(userId, await Promise.all(top.map(([p, k]) => make(p, k))));
}
/** A place id to its path: only folders the owner can see in the list (or saved ones). */
export async function resolvePlace(userId: string, id: string, home = os.homedir(), hint?: string): Promise<string | null> {
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  for (const s of await savedPlaces(userId)) if (placeId(s.place) === id) return s.place;
  const known = shown.get(userId)?.get(id); if (known) return known;
  for (const p of await listPlaces(userId, undefined, home)) if (p.id === id) return p.path;
  if (hint && placeId(hint) === id && path.isAbsolute(hint) && await isDir(hint)) return hint;
  return null;
}
/** Allow several folders at once, take allowed folders back, leave subfolders out. */
export async function setPlaces(userId: string, input: { allow?: string[]; deny?: string[]; exclude?: string[] }) {
  await initPlaces();
  for (const p of input.allow ?? []) await q.run("INSERT INTO discovery_places (user_id, place, state) VALUES (?, ?, 'allow') ON CONFLICT (user_id, place) DO UPDATE SET state = 'allow'", userId, p);
  for (const p of input.exclude ?? []) await q.run("INSERT INTO discovery_places (user_id, place, state) VALUES (?, ?, 'exclude') ON CONFLICT (user_id, place) DO UPDATE SET state = 'exclude'", userId, p);
  for (const p of input.deny ?? []) await q.run('DELETE FROM discovery_places WHERE user_id = ? AND place = ?', userId, p);
}
/** A folder or drive typed by the owner: it must exist; the system disk itself and system folders are refused. */
export async function checkAddedFolder(p: unknown): Promise<string> {
  if (typeof p !== 'string' || !p.trim() || p.length > 2048 || p.includes('\0') || !path.isAbsolute(p)) throw new PlacesError('invalid_input');
  const real = await fs.realpath(p).catch(() => null);
  if (!real || !(await isDir(real))) throw new PlacesError('not_found', 404);
  if (real === path.parse(real).root && process.platform !== 'win32') throw new PlacesError('system_folder');
  if (isSystemPath(real)) throw new PlacesError('system_folder');
  return real;
}
/** Files and size under a folder, stopped at a limit (for the tree). */
export async function countFolder(p: string, limit = 50_000, ms = 4000): Promise<{ files: number; bytes: number; capped: boolean }> {
  let files = 0, bytes = 0, capped = false; const until = Date.now() + ms;
  const walk = async (d: string): Promise<void> => {
    if (capped) return;
    let entries; try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files >= limit || Date.now() > until) { capped = true; return; }
      if (e.isSymbolicLink() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) await walk(f);
      else if (e.isFile()) { files++; bytes += (await fs.lstat(f).catch(() => null))?.size ?? 0; }
    }
  };
  await walk(p);
  return { files, bytes, capped };
}

// ---- kinds and "don't show" ----
const DEFAULT_KINDS: Kinds = { notes: true, tools: true, skills: true, mcp: true, ssh: true, design: true, databases: true };
export async function kinds(userId: string): Promise<Kinds> {
  await initPlaces();
  const r = await q.one<{ kinds: string }>('SELECT kinds FROM discovery_kinds WHERE user_id = ?', userId);
  try { return { ...DEFAULT_KINDS, ...(r ? JSON.parse(r.kinds) : {}) }; } catch { return { ...DEFAULT_KINDS }; }
}
export async function setKinds(userId: string, input: unknown): Promise<Kinds> {
  const b = input as Record<string, unknown>;
  if (!b || typeof b !== 'object' || Array.isArray(b) || !Object.keys(b).length || Object.keys(b).some((k) => !(FILE_KINDS as readonly string[]).includes(k)) || Object.values(b).some((v) => typeof v !== 'boolean')) throw new PlacesError('invalid_input');
  const next = { ...(await kinds(userId)), ...(b as Partial<Kinds>) };
  await q.run('INSERT INTO discovery_kinds (user_id, kinds) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET kinds = excluded.kinds', userId, JSON.stringify(next));
  return next;
}
export async function hiddenKinds(userId: string): Promise<Map<string, Set<string>>> {
  await initPlaces();
  const m = new Map<string, Set<string>>();
  for (const r of await q.all<{ root_id: string; kind: string }>('SELECT root_id, kind FROM discovery_hidden WHERE user_id = ?', userId)) { if (!m.has(r.root_id)) m.set(r.root_id, new Set()); m.get(r.root_id)!.add(r.kind); }
  return m;
}
export async function setHidden(userId: string, rootId: string, kind: string, hidden: boolean) {
  await initPlaces();
  if (hidden) await q.run('INSERT INTO discovery_hidden (user_id, root_id, kind) VALUES (?, ?, ?) ON CONFLICT (user_id, root_id, kind) DO NOTHING', userId, rootId, kind);
  else await q.run('DELETE FROM discovery_hidden WHERE user_id = ? AND root_id = ? AND kind = ?', userId, rootId, kind);
}

// ---- merged projects ----
export type Group = { id: string; name: string; slug: string; roots: string[] };
export async function groups(userId: string): Promise<Group[]> {
  await initPlaces();
  const gs = await q.all<{ group_id: string; name: string; slug: string }>('SELECT group_id, name, slug FROM discovery_groups WHERE user_id = ? ORDER BY created_at', userId);
  const rs = await q.all<{ group_id: string; root: string }>('SELECT group_id, root FROM discovery_group_roots WHERE user_id = ?', userId);
  return gs.map((g) => ({ id: g.group_id, name: g.name, slug: g.slug, roots: rs.filter((r) => r.group_id === g.group_id).map((r) => r.root) }));
}
export const groupSlug = (name: string) => name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
export async function merge(userId: string, name: unknown, roots: string[]): Promise<Group> {
  await initPlaces();
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || roots.length < 2 || roots.length > 20) throw new PlacesError('invalid_input');
  const slug = groupSlug(name.trim()); if (!slug) throw new PlacesError('invalid_input');
  const id = sha(`group\0${userId}\0${slug}\0${roots.slice().sort().join('\0')}`).slice(0, 32);
  // A folder already in a group moves to the new one; groups left with fewer than two folders end.
  for (const r of roots) await q.run('DELETE FROM discovery_group_roots WHERE user_id = ? AND root = ?', userId, r);
  await q.run('INSERT INTO discovery_groups (user_id, group_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, group_id) DO UPDATE SET name = excluded.name, slug = excluded.slug', userId, id, name.trim(), slug, new Date().toISOString());
  for (const r of roots) await q.run('INSERT INTO discovery_group_roots (user_id, root, group_id) VALUES (?, ?, ?)', userId, r, id);
  for (const g of await groups(userId)) if (g.id !== id && g.roots.length < 2) await separate(userId, g.id);
  return { id, name: name.trim(), slug, roots };
}
export async function separate(userId: string, groupId: string) {
  await initPlaces();
  await q.run('DELETE FROM discovery_group_roots WHERE user_id = ? AND group_id = ?', userId, groupId);
  const r = await q.run('DELETE FROM discovery_groups WHERE user_id = ? AND group_id = ?', userId, groupId);
  if (!r.changes) throw new PlacesError('not_found', 404);
}
/** Words too common to say two projects are the same. */
const GENERIC = new Set(['agent', 'agents', 'project', 'projects', 'site', 'website', 'web', 'app', 'apps', 'backend', 'frontend', 'admin', 'dashboard', 'server', 'client', 'core', 'main', 'test', 'demo', 'landing', 'page']);
const words = (name: string) => new Set(name.toLowerCase().split(/[^a-z0-9؀-ۿ]+/).filter((w) => w.length >= 3));
const squash = (name: string) => name.toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, '');
export const pairKey = (a: string, b: string) => sha(`pair\0${[a, b].sort().join('\0')}`).slice(0, 32);
/** Projects that look like the same one: the same name without separators, or all words of one inside the other. */
export function suggestMerges(roots: { id: string; name: string }[], dismissed: Set<string>, limit = 10): { key: string; a: { id: string; name: string }; b: { id: string; name: string }; reason: string }[] {
  const out: { key: string; a: { id: string; name: string }; b: { id: string; name: string }; reason: string }[] = [];
  for (let i = 0; i < roots.length && out.length < limit; i++) for (let j = i + 1; j < roots.length && out.length < limit; j++) {
    const a = roots[i], b = roots[j];
    const key = pairKey(a.id, b.id); if (dismissed.has(key)) continue;
    const an = a.name.split(/[\\/]/).pop()!, bn = b.name.split(/[\\/]/).pop()!;
    let reason = '';
    if (squash(an) && squash(an) === squash(bn)) reason = 'same name';
    else { const wa = words(an), wb = words(bn); const [s, l] = wa.size <= wb.size ? [wa, wb] : [wb, wa]; if (s.size && [...s].every((w) => l.has(w)) && (s.size >= 2 || [...s].some((w) => w.length >= 5 && !GENERIC.has(w)))) reason = 'one name is inside the other'; }
    if (reason) out.push({ key, a, b, reason });
  }
  return out;
}
export async function dismissedPairs(userId: string): Promise<Set<string>> {
  await initPlaces();
  return new Set((await q.all<{ pair: string }>('SELECT pair FROM discovery_merge_dismissed WHERE user_id = ?', userId)).map((r) => r.pair));
}
export async function dismissPair(userId: string, key: string) {
  await initPlaces();
  if (!/^[a-f0-9]{32}$/.test(key)) throw new PlacesError('invalid_input');
  await q.run('INSERT INTO discovery_merge_dismissed (user_id, pair) VALUES (?, ?) ON CONFLICT (user_id, pair) DO NOTHING', userId, key);
}
