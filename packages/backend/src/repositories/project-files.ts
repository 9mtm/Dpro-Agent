/**
 * Read-only views of a project folder for the chat's side panes (CHAT-PANES-01):
 * uncommitted git changes per file, one file's diff, a folder listing and a
 * file's text. Every path stays inside the project folder (symlinks too), and
 * files that usually hold secrets are listed but never opened.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { readRegularFile, FileReadError } from '../services/read-regular-file.js';
import path from 'node:path';

export class ProjectPathError extends Error {}

export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_DIFF_CHARS = 400_000;
const MAX_ENTRIES = 1000;
const MAX_CHANGES = 1000;

/** Files never opened in the panes (keys, env files, the app's own encryption data). */
export function secretPath(rel: string): boolean {
  const base = path.posix.basename(rel).toLowerCase();
  return /^\.env(\..*)?$/.test(base) || /\.(pem|key|p12|pfx|keystore|jks)$/.test(base) || /^id_(rsa|ed25519|ecdsa|dsa)$/.test(base)
    || /(^|\/)\.data\/encryption(\/|$)/.test(rel) || /(^|\/)\.git(\/|$)/.test(rel);
}

/** A relative path inside the folder: no absolute paths, no "..", no NUL. "" is the folder itself. */
export function cleanRel(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string' || raw.length > 1024 || raw.includes('\0') || raw.startsWith('/') || raw.includes('\\')) throw new ProjectPathError('Bad path');
  const parts = raw.split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..')) throw new ProjectPathError('Bad path');
  return parts.join('/');
}

/** The real path of rel, refusing anything that resolves outside the folder. */
async function inside(folder: string, rel: string): Promise<string> {
  const root = await fs.realpath(folder);
  let real: string;
  try { real = await fs.realpath(path.join(root, rel)); } catch { throw new ProjectPathError('Not found'); }
  if (real !== root && !real.startsWith(root + path.sep)) throw new ProjectPathError('Outside the project folder');
  return real;
}

async function secretTarget(folder: string, real: string): Promise<boolean> {
  const root = await fs.realpath(folder);
  return secretPath(path.relative(root, real).split(path.sep).join('/'));
}

const gitEnv = () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' });
function git(folder: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string | null> {
  return new Promise(resolve => execFile('git', ['-C', folder, '-c', 'core.quotepath=off', ...args], { timeout: 5000, maxBuffer, env: gitEnv() },
    (err, out) => resolve(err ? null : String(out))));
}

export type FileChange = { path: string; status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'; added: number | null; removed: number | null; from?: string };

/** Uncommitted changes against HEAD, one row per file (null when not a git folder). */
export async function gitChanges(folder: string): Promise<{ branch: string | null; changes: FileChange[]; truncated: boolean } | null> {
  const [status, numstat, branch] = await Promise.all([
    git(folder, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(folder, ['diff', '--numstat', '-z', 'HEAD']),
    git(folder, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ]);
  if (status === null) return null;
  const counts = new Map<string, [number | null, number | null]>();
  if (numstat) {
    const f = numstat.split('\0');
    for (let i = 0; i < f.length; i++) {
      const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(f[i]);
      if (!m) continue;
      const n = (x: string) => (x === '-' ? null : Number(x));
      // A rename prints "a\tb\t" then the old and new paths as two more fields.
      if (m[3] === '') { counts.set(f[i + 2], [n(m[1]), n(m[2])]); i += 2; } else counts.set(m[3], [n(m[1]), n(m[2])]);
    }
  }
  const changes: FileChange[] = [];
  const f = status.split('\0');
  for (let i = 0; i < f.length && changes.length < MAX_CHANGES; i++) {
    const e = f[i]; if (e.length < 4) continue;
    const xy = e.slice(0, 2), p = e.slice(3);
    let s: FileChange['status'] = 'modified'; let from: string | undefined;
    if (xy === '??') s = 'untracked';
    else if (xy.includes('R')) { s = 'renamed'; from = f[++i]; }
    else if (xy.includes('A')) s = 'added';
    else if (xy.includes('D')) s = 'deleted';
    const c = counts.get(p);
    changes.push({ path: p, status: s, added: c ? c[0] : null, removed: c ? c[1] : null, ...(from ? { from } : {}) });
  }
  // Untracked text files count as all-added lines.
  await Promise.all(changes.filter(c => c.status === 'untracked' && !secretPath(c.path)).slice(0, 200).map(async c => {
    try { const real = await inside(folder, c.path); if (await secretTarget(folder, real)) return; const { data } = await readRegularFile(real, MAX_FILE_BYTES, { root: folder }); const t = data.toString('utf8'); if (t.includes('\0')) return; c.added = t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0; c.removed = 0; } catch { /* stays unknown */ }
  }));
  return { branch: branch?.trim() || null, changes, truncated: f.length / 2 > MAX_CHANGES };
}

/** One file's uncommitted diff (unified, 3 lines of context). */
export async function gitFileDiff(folder: string, rawRel: unknown): Promise<{ path: string; diff: string; truncated: boolean; binary: boolean; hidden: boolean }> {
  const rel = cleanRel(rawRel);
  if (!rel) throw new ProjectPathError('Pick a file');
  if (secretPath(rel)) return { path: rel, diff: '', truncated: false, binary: false, hidden: true };
  let diff = await git(folder, ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', rel], 16 * 1024 * 1024);
  if (diff === null) throw new ProjectPathError('Not a git folder');
  if (!diff) {
    // Untracked: show the whole file as added.
    try {
      const real = await inside(folder, rel);
      if (await secretTarget(folder, real)) return { path: rel, diff: '', truncated: false, binary: false, hidden: true };
      const { data, stat: st, truncated } = await readRegularFile(real, MAX_FILE_BYTES, { root: folder, truncate: true });
      if (st.isFile()) {
        if (truncated) return { path: rel, diff: '', truncated: true, binary: false, hidden: false };
        const t = data.toString('utf8');
        if (t.includes('\0')) return { path: rel, diff: '', truncated: false, binary: true, hidden: false };
        const lines = t.split('\n'); if (t.endsWith('\n')) lines.pop();
        diff = `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}\n`;
      }
    } catch { /* deleted or gone: empty diff */ }
  }
  const binary = /^Binary files /m.test(diff);
  return { path: rel, diff: diff.slice(0, MAX_DIFF_CHARS), truncated: diff.length > MAX_DIFF_CHARS, binary, hidden: false };
}

export type DirEntry = { name: string; kind: 'dir' | 'file'; size: number | null };

/** One folder level: folders first, then files, by name; .git is left out. */
export async function listFolder(folder: string, rawRel: unknown): Promise<{ path: string; entries: DirEntry[]; truncated: boolean }> {
  const rel = cleanRel(rawRel);
  const real = await inside(folder, rel);
  let dirents;
  try { dirents = await fs.readdir(real, { withFileTypes: true }); } catch { throw new ProjectPathError('Not a folder'); }
  const entries: DirEntry[] = [];
  for (const d of dirents) {
    if (d.name === '.git' || d.name === '.DS_Store') continue;
    let kind: DirEntry['kind'] | null = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : null;
    let size: number | null = null;
    if (d.isSymbolicLink()) { try { const t = await inside(folder, path.posix.join(rel, d.name)); const st = await fs.stat(t); kind = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null; if (kind === 'file') size = st.size; } catch { kind = null; } }
    else if (kind === 'file') { try { size = (await fs.stat(path.join(real, d.name))).size; } catch { /* unknown */ } }
    if (kind) entries.push({ name: d.name, kind, size });
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'en', { numeric: true }) : a.kind === 'dir' ? -1 : 1));
  return { path: rel, entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
}

/** A file's text (up to 512 KB); binary and secret files come back without content. */
export async function readFolderFile(folder: string, rawRel: unknown): Promise<{ path: string; text: string | null; size: number; binary: boolean; hidden: boolean; truncated: boolean }> {
  const rel = cleanRel(rawRel);
  if (!rel) throw new ProjectPathError('Pick a file');
  const real = await inside(folder, rel);
  if (secretPath(rel) || await secretTarget(folder, real)) {
    const st = await fs.stat(real);
    return { path: rel, text: null, size: st.size, binary: false, hidden: true, truncated: false };
  }
  try {
    const { data, stat: st, truncated } = await readRegularFile(real, MAX_FILE_BYTES, { root: folder, truncate: true });
    if (data.includes(0)) return { path: rel, text: null, size: st.size, binary: true, hidden: false, truncated: false };
    return { path: rel, text: data.toString('utf8'), size: st.size, binary: false, hidden: false, truncated };
  } catch (error) {
    if (error instanceof FileReadError) throw new ProjectPathError(error.message);
    throw error;
  }
}
