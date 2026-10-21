/**
 * Conversations other coding agents saved on this computer (MEM-IMPORT-01/02):
 *   claude-code   ~/.claude/projects/<project>/<session>.jsonl
 *   codex         ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl and the
 *                 archived ones, ~/.codex/archived_sessions/rollout-*.jsonl(.zst)
 *   antigravity   ~/.gemini/antigravity/conversation_summaries.db (its search
 *                 index holds each conversation's plain user and agent text; the
 *                 per-conversation step stores are binary and are not read)
 *   gemini-cli    ~/.gemini/tmp/<project>/chats/*.json and …/logs.json
 * Only these exact files are opened (READABLE): never the credential, account or
 * settings files that sit next to them. Read-only: nothing is changed, moved or
 * deleted (a SQLite store is opened from a private temporary copy). Only the human and agent text turns are
 * kept (no tool calls, tool output, thinking or injected system text); the
 * result goes through the import pipeline's secret scan before anything is
 * stored. Sessions are named by an opaque id, never by their path, in every
 * response.
 *
 * MEM-IMPORT-03: every conversation belongs to a project root (its git root;
 * a worktree folder belongs to its repository; a folder that is gone, e.g. from
 * an older computer, is matched by its last folder names). The list reads only
 * the start of large files, so every conversation is listed, not only the newest.
 */
import { createHash } from 'node:crypto';
import { readRegularFile } from '../../services/read-regular-file.js';
import { fileURLToPath } from 'node:url';
import { createReadStream, type Dirent } from 'node:fs';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export const LOCAL_SOURCES = ['claude-code', 'codex', 'antigravity', 'gemini-cli'] as const;
export type LocalSource = (typeof LOCAL_SOURCES)[number];
export const SOURCE_NAMES: Record<LocalSource, string> = { 'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', 'gemini-cli': 'Gemini CLI' };
export type Turn = { role: 'user' | 'assistant'; text: string };
/** One conversation: a file, or one conversation inside a file (`key`). */
export type SessionRef = { source: LocalSource; file: string; key?: string; legacyId?: string };
type Found = SessionRef & { mtime: number; size: number };
/** `turns` is null when only the start of a large file was read; `legacyId` stays on the server. */
export type LocalSession = { id: string; legacyId: string; source: LocalSource; cwd: string | null; root: string | null; rootName: string | null; title: string; startedAt: string | null; updatedAt: string; bytes: number; turns: number | null };

export const MAX_SESSION_BYTES = 60 * 1024 * 1024;
/** Files up to this size are read in full to count their messages; larger ones only from the start. */
const FULL_READ_BYTES = 1024 * 1024;
const HEAD_CHARS = 512 * 1024;

export function sourceRoot(source: LocalSource, home = os.homedir()): string {
  if (source === 'claude-code') return path.join(home, '.claude', 'projects');
  if (source === 'codex') return path.join(home, '.codex');
  if (source === 'antigravity') return path.join(home, '.gemini', 'antigravity');
  return path.join(home, '.gemini', 'tmp');
}
/**
 * Opaque, stable id of a session (no path leaves the server): named by the
 * file's own name (the agent's session id), so it survives a moved home folder
 * or an archived Codex session.
 */
export const sessionId = (source: LocalSource, file: string, key?: string) => createHash('sha256').update(`v2\0${source}\0${path.basename(file).replace(/\.zst$/, '')}${key ? `\0${key}` : ''}`).digest('hex').slice(0, 32);
/** The id earlier versions used (by absolute path): imports and chat links saved under it still count. */
export const legacySessionId = (source: LocalSource, file: string, key?: string) => createHash('sha256').update(`${source}\0${file}${key ? `\0${key}` : ''}`).digest('hex').slice(0, 32);

/**
 * The only files this reader may open, relative to the source root. Credential,
 * account, settings and state files (e.g. ~/.gemini/oauth_creds.json) can never
 * match: they are outside these patterns.
 */
const READABLE: Record<LocalSource, RegExp> = {
  'claude-code': /^[^/]+\/[^/]+\.jsonl$/,
  codex: /^(?:sessions\/(?:[^/]+\/){0,3}[^/]+\.jsonl|archived_sessions\/[^/]+\.jsonl(?:\.zst)?)$/,
  antigravity: /^conversation_summaries\.db$/,
  'gemini-cli': /^[^/]+\/(?:chats\/[^/]+\.json|logs\.json|\.project_root)$/,
};
export function readable(source: LocalSource, file: string, home?: string): boolean {
  const rel = path.relative(sourceRoot(source, home), file);
  return !rel.startsWith('..') && !path.isAbsolute(rel) && READABLE[source].test(rel.split(path.sep).join('/'));
}
function guard(source: LocalSource, file: string, home?: string) { if (!readable(source, file, home)) throw new Error('not a conversation file'); }

async function walk(dir: string, depth: number, out: string[]) {
  let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory() && depth > 0) await walk(p, depth - 1, out);
    else if (e.isFile() && (e.name.endsWith('.jsonl') || e.name.endsWith('.jsonl.zst'))) out.push(p);
  }
}
async function sessionFiles(source: 'claude-code' | 'codex', home?: string): Promise<string[]> {
  const out: string[] = [];
  if (source === 'claude-code') await walk(sourceRoot(source, home), 1, out);
  else { await walk(path.join(sourceRoot(source, home), 'sessions'), 3, out); await walk(path.join(sourceRoot(source, home), 'archived_sessions'), 0, out); }
  return out;
}
async function statOf(file: string): Promise<{ mtime: number; size: number } | null> {
  try { const st = await fs.lstat(file); return st.isFile() && st.size > 0 ? { mtime: st.mtimeMs, size: st.size } : null; } catch { return null; }
}

/** Runs `fn` on a private read-only copy of a SQLite store (the original is never opened for writing or locked). */
async function withSqliteCopy<T>(file: string, fn: (db: Database.Database) => T): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dpro-read-'));
  try {
    const copy = path.join(tmp, 'copy.db');
    await fs.copyFile(file, copy);
    await fs.copyFile(`${file}-wal`, `${copy}-wal`).catch(() => {});
    const db = new Database(copy, { readonly: true, fileMustExist: true });
    try { return fn(db); } finally { db.close(); }
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
}

type AgyRow = { conversation_id: string; chunk_index: number; title: string | null; user_body: string | null; agent_body: string | null };
type AgySummary = { conversation_id: string; title: string; last_modified_time: string; workspace_uris: string };
type AgyConversation = { turns: Turn[]; cwd: string | null; startedAt: string | null; updatedAt: string | null; title: string };
let agyCache: { file: string; stamp: string; data: Map<string, AgyConversation> } | null = null;
/** Antigravity: the conversations in its search index (plain text), grouped by conversation (read once per change of the store). */
async function readAntigravity(file: string): Promise<Map<string, AgyConversation>> {
  const st = await fs.stat(file); const stamp = `${st.mtimeMs}:${st.size}`;
  if (agyCache?.file === file && agyCache.stamp === stamp) return agyCache.data;
  const data = await readAntigravityStore(file);
  agyCache = { file, stamp, data };
  return data;
}
async function readAntigravityStore(file: string): Promise<Map<string, AgyConversation>> {
  return withSqliteCopy(file, (db) => {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all() as { name: string }[]).map(r => r.name));
    const out = new Map<string, { turns: Turn[]; cwd: string | null; startedAt: string | null; updatedAt: string | null; title: string }>();
    if (!tables.has('conversations_fts')) return out;
    const meta = new Map<string, AgySummary>();
    if (tables.has('conversation_summaries')) for (const r of db.prepare('SELECT conversation_id, title, last_modified_time, workspace_uris FROM conversation_summaries').all() as AgySummary[]) meta.set(r.conversation_id, r);
    const rows = db.prepare('SELECT conversation_id, CAST(chunk_index AS INTEGER) AS chunk_index, title, user_body, agent_body FROM conversations_fts ORDER BY conversation_id, CAST(chunk_index AS INTEGER)').all() as AgyRow[];
    for (const r of rows) {
      if (typeof r.conversation_id !== 'string' || !r.conversation_id) continue;
      let c = out.get(r.conversation_id);
      if (!c) {
        const m = meta.get(r.conversation_id);
        const uri = m?.workspace_uris?.match(/file:\/\/[^\s"',\]]+/)?.[0];
        let cwd: string | null = null; try { cwd = uri ? fileURLToPath(uri) : null; } catch { /* not a path */ }
        const when = m?.last_modified_time ? new Date(m.last_modified_time.replace(' ', 'T').replace(/\.(\d{3})\d*/, '.$1')) : null;
        c = { turns: [], cwd, startedAt: null, updatedAt: when && Number.isFinite(when.getTime()) ? when.toISOString() : null, title: m?.title ?? '' };
        out.set(r.conversation_id, c);
      }
      if (r.chunk_index < 0) { if (r.title && !c.title) c.title = r.title; continue; }
      for (const [role, text] of [['user', r.user_body], ['assistant', r.agent_body]] as const) {
        const t = typeof text === 'string' ? humanText(text) : null;
        if (t) pushTurn(c.turns, { role, text: t });
      }
    }
    return out;
  });
}

type GeminiChat = { turns: Turn[]; startedAt: string | null; key: string };
const partsText = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => typeof p?.text === 'string' && !p.thought ? p.text : '').filter(Boolean).join('\n') : '';
/** Gemini CLI: a recorded chat (chats/*.json: user and model messages). */
export function geminiChat(o: any): GeminiChat | null {
  if (!o || typeof o !== 'object' || !Array.isArray(o.messages)) return null;
  const turns: Turn[] = [];
  for (const m of o.messages) {
    const role = m?.type === 'user' ? 'user' : m?.type === 'gemini' || m?.type === 'model' ? 'assistant' : null;
    const t = role ? humanText(partsText(m.content)) : null;
    if (role && t) pushTurn(turns, { role, text: t });
  }
  return { turns, startedAt: typeof o.startTime === 'string' ? o.startTime : null, key: typeof o.sessionId === 'string' ? o.sessionId : '' };
}
/** Gemini CLI: the prompt log (logs.json: the person's messages only), one entry per session. */
export function geminiLog(list: unknown): GeminiChat[] {
  if (!Array.isArray(list)) return [];
  const by = new Map<string, GeminiChat>();
  for (const e of list as any[]) {
    if (e?.type !== 'user' || typeof e.sessionId !== 'string' || typeof e.message !== 'string') continue;
    const t = humanText(e.message); if (!t || t.startsWith('/')) continue;
    let c = by.get(e.sessionId);
    if (!c) { c = { turns: [], startedAt: typeof e.timestamp === 'string' ? e.timestamp : null, key: e.sessionId }; by.set(e.sessionId, c); }
    pushTurn(c.turns, { role: 'user', text: t });
  }
  return [...by.values()];
}
async function readJson(file: string, home?: string): Promise<unknown> {
  const { data } = await readRegularFile(file, MAX_SESSION_BYTES, { root: sourceRoot('gemini-cli', home) });
  return JSON.parse(data.toString('utf8'));
}
async function geminiProjectRoot(dir: string, home?: string): Promise<string | null> {
  const f = path.join(dir, '.project_root');
  if (!readable('gemini-cli', f, home)) return null;
  try { const { data } = await readRegularFile(f, 4096, { root: sourceRoot('gemini-cli', home) }); const t = data.toString('utf8').trim(); return path.isAbsolute(t) ? t : null; } catch { return null; }
}

/** Every conversation of one source, with the file it lives in. */
async function enumerate(source: LocalSource, home?: string): Promise<Found[]> {
  const out: Found[] = [];
  if (source === 'claude-code' || source === 'codex') {
    for (const file of await sessionFiles(source, home)) { const st = await statOf(file); if (st && readable(source, file, home)) out.push({ source, file, ...st }); }
  } else if (source === 'antigravity') {
    const file = path.join(sourceRoot(source, home), 'conversation_summaries.db');
    const st = await statOf(file);
    if (st && st.size <= MAX_SESSION_BYTES) {
      try {
        for (const [key, c] of await readAntigravity(file)) {
          const at = c.updatedAt ? Date.parse(c.updatedAt) : st.mtime;
          out.push({ source, file, key, mtime: at, size: c.turns.reduce((n, t) => n + t.text.length, 0) });
        }
      } catch { /* unreadable: left out */ }
    }
  } else {
    let dirs: Dirent[]; try { dirs = await fs.readdir(sourceRoot(source, home), { withFileTypes: true }); } catch { dirs = []; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(sourceRoot(source, home), d.name);
      const seen = new Set<string>();
      let chats: Dirent[]; try { chats = await fs.readdir(path.join(dir, 'chats'), { withFileTypes: true }); } catch { chats = []; }
      for (const f of chats) {
        const file = path.join(dir, 'chats', f.name);
        if (!f.isFile() || !readable(source, file, home)) continue;
        const st = await statOf(file); if (!st) continue;
        try { const c = geminiChat(await readJson(file, home)); if (c?.key) seen.add(c.key); } catch { /* skipped */ }
        out.push({ source, file, ...st });
      }
      const log = path.join(dir, 'logs.json');
      const st = await statOf(log);
      if (st && readable(source, log, home)) {
        try { for (const c of geminiLog(await readJson(log, home))) if (!seen.has(c.key)) out.push({ source, file: log, key: c.key, mtime: st.mtime, size: c.turns.reduce((n, t) => n + t.text.length, 0) }); } catch { /* skipped */ }
      }
    }
  }
  return out;
}

/** Text a person typed or an agent wrote; not injected tool, command or system text. */
export function humanText(raw: string): string | null {
  // Tool and system wrappers (<tag>…</tag>) and interruption notes are not something a person said.
  const t = raw.replace(/<([a-z][a-z0-9_-]{1,60})(\s[^>]*)?>[\s\S]*?<\/\1>/gi, '')
    .replace(/^\[Request interrupted by user[^\]]*\]\s*/gm, '').trim();
  if (!t) return null;
  if (/^<[a-z][a-z0-9_-]*[\s>]/i.test(t)) return null;
  if (/^(Caveat: The messages below|# AGENTS\.md instructions)/.test(t)) return null;
  return t;
}

/** The human and agent text turns of one parsed log line, if any. */
export function lineTurns(source: LocalSource, o: any): { turns: Turn[]; cwd?: string; at?: string } {
  if (!o || typeof o !== 'object') return { turns: [] };
  if (source === 'claude-code') {
    if ((o.type !== 'user' && o.type !== 'assistant') || o.isSidechain || o.isMeta || !o.message) return { turns: [], cwd: typeof o.cwd === 'string' ? o.cwd : undefined };
    const c = o.message.content;
    const parts: string[] = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((x: any) => x?.type === 'text' && typeof x.text === 'string').map((x: any) => x.text) : [];
    const turns = parts.map(humanText).filter((t): t is string => !!t).map(text => ({ role: o.type as Turn['role'], text }));
    return { turns, cwd: typeof o.cwd === 'string' ? o.cwd : undefined, at: typeof o.timestamp === 'string' ? o.timestamp : undefined };
  }
  if (o.type === 'session_meta' && o.payload && typeof o.payload.cwd === 'string') return { turns: [], cwd: o.payload.cwd, at: typeof o.timestamp === 'string' ? o.timestamp : undefined };
  const p = o.payload;
  if (o.type !== 'response_item' || !p || p.type !== 'message' || (p.role !== 'user' && p.role !== 'assistant') || !Array.isArray(p.content)) return { turns: [] };
  const parts = p.content.filter((x: any) => (x?.type === 'input_text' || x?.type === 'output_text') && typeof x.text === 'string').map((x: any) => x.text);
  return { turns: parts.map(humanText).filter((t: string | null): t is string => !!t).map((text: string) => ({ role: p.role as Turn['role'], text })), at: typeof o.timestamp === 'string' ? o.timestamp : undefined };
}

/** Consecutive turns of the same speaker become one turn. */
function pushTurn(turns: Turn[], t: Turn) {
  const last = turns.at(-1);
  if (last && last.role === t.role) last.text += `\n\n${t.text}`; else turns.push({ ...t });
}

export type SessionText = { turns: Turn[]; cwd: string | null; startedAt: string | null; title?: string };

/** The lines of a JSONL log (a Codex archive is zstd-compressed); at most MAX_SESSION_BYTES of text. */
async function* logLines(file: string): AsyncGenerator<string> {
  const raw = createReadStream(file);
  let input: NodeJS.ReadableStream = raw;
  if (file.endsWith('.zst')) {
    if (typeof (zlib as any).createZstdDecompress !== 'function') { raw.destroy(); throw new Error('unsupported'); }
    input = raw.pipe((zlib as any).createZstdDecompress());
  }
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let used = 0;
  try {
    for await (const line of rl) {
      used += line.length + 1;
      if (used > MAX_SESSION_BYTES) throw new Error('too large');
      yield line;
    }
  } finally { rl.close(); raw.destroy(); }
}

/** Claude Code or Codex log: its turns, folder and start (stops early with `head`, once the folder and first message are known). */
async function readLog(source: 'claude-code' | 'codex', file: string, head = false): Promise<SessionText> {
  const turns: Turn[] = []; let cwd: string | null = null; let startedAt: string | null = null; let chars = 0;
  for await (const line of logLines(file)) {
    if (head && ((cwd && turns.some(t => t.role === 'user')) || (chars += line.length) > HEAD_CHARS)) break;
    if (!line.trim()) continue;
    let o: unknown; try { o = JSON.parse(line); } catch { continue; }
    const r = lineTurns(source, o);
    if (r.cwd && !cwd) cwd = r.cwd;
    if (r.at && !startedAt) startedAt = r.at;
    for (const t of r.turns) pushTurn(turns, t);
  }
  return { turns, cwd, startedAt };
}

/** Reads one conversation into turns plus its working folder. */
export async function readSession(ref: SessionRef, home?: string): Promise<SessionText> {
  const { source, file } = ref;
  guard(source, file, home);
  if (source === 'antigravity') {
    const c = (await readAntigravity(file)).get(ref.key ?? '');
    if (!c) throw new Error('gone');
    return { turns: c.turns, cwd: c.cwd, startedAt: c.updatedAt, title: c.title };
  }
  if (source === 'gemini-cli') {
    const data = await readJson(file, home);
    const c = ref.key ? geminiLog(data).find(x => x.key === ref.key) : geminiChat(data);
    if (!c) throw new Error('gone');
    return { turns: c.turns, cwd: await geminiProjectRoot(path.dirname(ref.key ? file : path.dirname(file)), home), startedAt: c.startedAt };
  }
  const st = await fs.stat(file);
  if (st.size > MAX_SESSION_BYTES) throw new Error('too large');
  const s = await readLog(source, file);
  if (!s.cwd && source === 'claude-code') s.cwd = await claudeFolderCwd(path.dirname(file), home);
  return s;
}

type Head = { cwd: string | null; startedAt: string | null; title: string; turns: number | null };
const heads = new Map<string, { stamp: string; head: Head | null }>();
const headOfText = (s: SessionText, turns: number | null): Head | null => {
  const first = s.turns.find(t => t.role === 'user');
  return first ? { cwd: s.cwd, startedAt: s.startedAt, title: (s.title || first.text).replace(/\s+/g, ' ').slice(0, 120), turns } : null;
};
/** What the list shows of a conversation; small files are read in full, large ones only from the start. Kept until the file changes. */
async function headOf(f: Found, home?: string): Promise<Head | null> {
  const k = `${f.source}\0${f.file}\0${f.key ?? ''}`; const stamp = `${f.mtime}:${f.size}`;
  const hit = heads.get(k); if (hit?.stamp === stamp) return hit.head;
  let head: Head | null = null;
  try {
    guard(f.source, f.file, home);
    if (f.source === 'claude-code' || f.source === 'codex') {
      const full = f.size <= FULL_READ_BYTES && !f.file.endsWith('.zst');
      const s = await readLog(f.source, f.file, !full);
      head = headOfText(s, full ? s.turns.length : null);
    } else { const s = await readSession(f, home); head = headOfText(s, s.turns.length); }
  } catch { head = null; }
  heads.set(k, { stamp, head });
  return head;
}
/** A Claude Code log without a folder: the folder another conversation in the same Claude project folder ran in. */
export async function claudeFolderCwd(dir: string, home?: string): Promise<string | null> {
  let names: string[]; try { names = await fs.readdir(dir); } catch { return null; }
  for (const name of names.filter(n => n.endsWith('.jsonl')).sort()) {
    const file = path.join(dir, name); const st = await statOf(file);
    if (!st || !readable('claude-code', file, home)) continue;
    const h = await headOf({ source: 'claude-code', file, ...st }, home);
    if (h?.cwd) return h.cwd;
  }
  return null;
}

// ---- project roots ----
const segs = (p: string) => p.split(/[\\/]+/).filter(Boolean);
/** The last two folder names: the same project under another home or drive (e.g. an older Windows computer). */
export const tailKey = (p: string) => segs(p).slice(-2).join('/').toLowerCase();
/** A folder that is gone may be a subfolder of its project: its own last two names, then up to two levels up. */
const goneKeys = (p: string) => [0, 1, 2].map(up => segs(p).slice(0, segs(p).length - up)).filter(x => x.length >= 2).map(x => tailKey(x.join('/')));
const WORKTREE = [/^(.+)-wt[\\/][^\\/]+(?:[\\/].*)?$/, /^(.+)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+(?:[\\/].*)?$/];
/** A Codex worktree, `~/.codex/worktrees/<name>/<repo>/…`: only the repository's folder name is known. */
const CODEX_WORKTREE = /[\\/]\.codex[\\/]worktrees[\\/][^\\/]+[\\/]([^\\/]+)/;
/**
 * A worktree folder belongs to its repository: `<repo>-wt/<name>/…` and `<repo>/.claude/worktrees/<name>/…`
 * (the innermost one). Used for folders that are gone; for a folder that exists, git says where its repository is.
 */
export function worktreeOwner(p: string): string { for (const re of WORKTREE) { const m = re.exec(p); if (m) return m[1]; } return p; }
const isDir = async (p: string) => (await fs.stat(p).catch(() => null))?.isDirectory() === true;
/** The git root above a folder; for a linked worktree, its main repository (never above the home folder). */
async function gitRoot(dir: string, home: string): Promise<string | null> {
  const top = await fs.realpath(home).catch(() => home);
  for (let d = dir; d !== top && d !== home; ) {
    const g = path.join(d, '.git');
    const st = await fs.lstat(g).catch(() => null);
    if (st?.isDirectory()) return d;
    if (st?.isFile()) {
      let text = ''; try { text = (await readRegularFile(g, 4096)).data.toString('utf8'); } catch { /* unreadable */ }
      const to = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
      const main = to ? /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(path.resolve(d, to)) : null;
      return main ? main[1] : d;
    }
    const up = path.dirname(d); if (up === d) return null; d = up;
  }
  return null;
}
export type ProjectRoot = { root: string; name: string; here: boolean };
/** The project a conversation's folder belongs to. */
export async function projectRoot(cwd: string | null, home = os.homedir()): Promise<ProjectRoot | null> {
  if (!cwd) return null;
  // A folder that is gone: a worktree folder stands for its repository, if that is here.
  const start = path.isAbsolute(cwd) && await isDir(cwd) ? cwd : worktreeOwner(cwd);
  if (!(path.isAbsolute(start) && await isDir(start))) return { root: start, name: segs(start).at(-1) ?? start, here: false };
  const real = await fs.realpath(start).catch(() => start);
  const root = await gitRoot(real, home) ?? real;
  return { root, name: segs(root).at(-1) ?? root, here: true };
}
const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
/**
 * The owner's project for a conversation: its folder holds the conversation's
 * folder or root (deepest wins); else the only project inside the root; else the
 * same folder on another computer (last two names); else the only project named
 * like the root folder.
 */
export function matchProject<P extends { slug: string; name: string; folder: string | null }>(cwd: string | null, root: string | null, projects: P[]): P | undefined {
  const inside = (p: string | null, f: string) => !!p && (p === f || p.startsWith(f.endsWith(path.sep) ? f : f + path.sep));
  const one = (list: P[]) => (list.length === 1 ? list[0] : undefined);
  const withFolder = projects.filter(p => p.folder);
  const holding = withFolder.filter(p => inside(cwd, p.folder!) || inside(root, p.folder!)).sort((a, b) => b.folder!.length - a.folder!.length)[0];
  if (holding || !root) return holding;
  return one(withFolder.filter(p => inside(p.folder, root)))
    ?? goneKeys(root).map(k => one(withFolder.filter(p => tailKey(worktreeOwner(p.folder!)) === k))).find(Boolean)
    ?? (norm(segs(root).at(-1) ?? '') ? one(projects.filter(p => norm(p.slug) === norm(segs(root).at(-1)!) || norm(p.name) === norm(segs(root).at(-1)!))) : undefined);
}

const TEMPORARY = /(^|[\\/])(tmp|temp|var[\\/]folders|scratchpad)([\\/]|$)/i;
/**
 * The project drawer for a folder no Dpro project claims (`project:<folder name>`),
 * so its project facts never land in the owner's own drawer. None for the home
 * folder, a drive or user folder, or a temporary folder.
 */
export function rootDrawerKey(root: string | null, home = os.homedir()): string | null {
  if (!root || root === home || segs(root).length < 3 || segs(root).at(-1)!.startsWith('.') || /^(?:[a-z]:)?[\\/]*(?:users|home)[\\/][^\\/]+[\\/]*$/i.test(root)) return null;
  const rel = path.relative(home, root);
  if (TEMPORARY.test(rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : root)) return null;
  const key = (segs(root).at(-1) ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(key) ? key : null;
}

async function mapLimit<T, R>(list: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (next < list.length) { const i = next++; out[i] = await fn(list[i]); } }));
  return out;
}
/** Every conversation once (by its stable id), newest first. */
async function everySession(home?: string): Promise<[string, Found][]> {
  const byId = new Map<string, Found>();
  for (const source of LOCAL_SOURCES) for (const f of await enumerate(source, home)) {
    const id = sessionId(f.source, f.file, f.key); const prev = byId.get(id);
    if (!prev || prev.mtime < f.mtime) byId.set(id, f);
  }
  return [...byId].sort((a, b) => b[1].mtime - a[1].mtime);
}

/**
 * Folders that are gone (an older computer, a removed worktree) mapped to the
 * same project here: the same last two folder names, a Codex worktree's repo
 * name, or the same path under a folder named like one of its parents.
 */
export async function relocateGoneRoots(roots: (ProjectRoot | null)[], home: string): Promise<Map<string, ProjectRoot | null>> {
  // A folder that is gone (older computer, removed worktree) joins the project here with the same last two folder names.
  const hereByTail = new Map<string, ProjectRoot | null>();
  for (const r of roots) if (r?.here) { const k = tailKey(r.root); const prev = hereByTail.get(k); hereByTail.set(k, prev === undefined || prev?.root === r.root ? r : null); }
  // …or the same folder found on this computer under a folder with the same name as one of its parents (e.g. C:\MAMP\htdocs\shop → ~/…/htdocs/shop).
  const anchors = new Map<string, Set<string>>();
  for (const r of roots) if (r?.here) for (let d = path.dirname(r.root), i = 0; i < 3 && d !== home && d !== path.dirname(d); d = path.dirname(d), i++) {
    const k = path.basename(d).toLowerCase(); if (!anchors.has(k)) anchors.set(k, new Set()); anchors.get(k)!.add(d);
  }
  const byName = new Map<string, ProjectRoot | null>();
  for (const r of roots) if (r?.here) { const k = r.name.toLowerCase(); const prev = byName.get(k); byName.set(k, prev === undefined || prev?.root === r.root ? r : null); }
  const moved = new Map<string, ProjectRoot | null>();
  for (const r of roots) if (r && !r.here && !moved.has(r.root)) {
    const gone = r.root;
    let found: ProjectRoot | null = goneKeys(gone).map(k => hereByTail.get(k)).find(Boolean) ?? null;
    const codexRepo = CODEX_WORKTREE.exec(gone)?.[1];
    if (!found && codexRepo) found = byName.get(codexRepo.toLowerCase()) ?? null;
    const parts = segs(gone);
    for (let i = parts.length - 2; !found && i >= Math.max(0, parts.length - 5); i--) {
      for (const a of anchors.get(parts[i].toLowerCase()) ?? []) {
        const candidate = path.join(a, ...parts.slice(i + 1));
        if (await isDir(candidate)) { found = await projectRoot(candidate, home); break; }
      }
    }
    moved.set(gone, found?.here ? found : null);
  }
  return moved;
}

/** Every conversation on this computer, newest first, with its project root (title = start of the first human message). */
export async function listLocalSessions(home?: string): Promise<LocalSession[]> {
  const found = (await everySession(home)).filter(([, f]) => f.size <= MAX_SESSION_BYTES);
  const read = await mapLimit(found, 16, async ([id, f]) => ({ id, f, h: await headOf(f, home) }));
  const listed = read.filter((x): x is typeof x & { h: Head } => x.h !== null);
  // A Claude Code log without a folder takes the folder of another log in the same Claude project folder.
  const dirCwd = new Map<string, string>();
  for (const x of listed) if (x.f.source === 'claude-code' && x.h.cwd && !dirCwd.has(path.dirname(x.f.file))) dirCwd.set(path.dirname(x.f.file), x.h.cwd);
  const roots = new Map<string, Promise<ProjectRoot | null>>();
  const rootOf = (cwd: string | null) => { if (!cwd) return Promise.resolve(null); if (!roots.has(cwd)) roots.set(cwd, projectRoot(cwd, home ?? os.homedir())); return roots.get(cwd)!; };
  const rows = await Promise.all(listed.map(async ({ id, f, h }) => {
    const cwd = h.cwd ?? (f.source === 'claude-code' ? dirCwd.get(path.dirname(f.file)) ?? null : null);
    return { id, f, h, cwd, root: await rootOf(cwd) };
  }));
  const moved = await relocateGoneRoots(rows.map(r => r.root), home ?? os.homedir());
  return rows.map(({ id, f, h, cwd, root }) => {
    const r = root && !root.here ? moved.get(root.root) ?? root : root;
    return { id, legacyId: legacySessionId(f.source, f.file, f.key), source: f.source, cwd, root: r?.root ?? null, rootName: r?.name ?? null, title: h.title, startedAt: h.startedAt, updatedAt: new Date(f.mtime).toISOString(), bytes: f.size, turns: h.turns };
  });
}

/** The conversation behind an opaque id, current or earlier form (only conversations under the known roots). */
export async function findSession(id: string, home?: string): Promise<SessionRef | null> {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  for (const source of LOCAL_SOURCES) for (const f of await enumerate(source, home)) {
    const legacyId = legacySessionId(f.source, f.file, f.key);
    if (sessionId(f.source, f.file, f.key) === id || legacyId === id) return { source: f.source, file: f.file, ...(f.key ? { key: f.key } : {}), legacyId };
  }
  return null;
}

/** A transcript as Markdown (for the archive and the memory agent). */
export function transcriptMarkdown(source: LocalSource, s: { turns: Turn[]; cwd: string | null; startedAt: string | null }): string {
  const who = SOURCE_NAMES[source];
  return [`# ${who} conversation`, s.cwd ? `Folder: ${s.cwd}` : '', s.startedAt ? `Started: ${s.startedAt}` : '', '',
    ...s.turns.map(t => `## ${t.role === 'user' ? 'Owner' : who}\n\n${t.text}`)].filter((l, i) => l !== '' || i > 2).join('\n\n');
}
