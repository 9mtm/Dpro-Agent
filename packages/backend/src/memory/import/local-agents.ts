/**
 * Conversations other coding agents saved on this computer (MEM-IMPORT-01/02):
 *   claude-code   ~/.claude/projects/<project>/<session>.jsonl
 *   codex         ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
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
 */
import { createHash } from 'node:crypto';
import { readRegularFile } from '../../services/read-regular-file.js';
import { fileURLToPath } from 'node:url';
import { createReadStream, type Dirent } from 'node:fs';
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
export type SessionRef = { source: LocalSource; file: string; key?: string };
type Found = SessionRef & { mtime: number; size: number };
export type LocalSession = { id: string; source: LocalSource; cwd: string | null; title: string; startedAt: string | null; updatedAt: string; bytes: number; turns: number };

export const MAX_SESSION_BYTES = 60 * 1024 * 1024;
const MAX_SESSIONS = 400;

export function sourceRoot(source: LocalSource, home = os.homedir()): string {
  if (source === 'claude-code') return path.join(home, '.claude', 'projects');
  if (source === 'codex') return path.join(home, '.codex', 'sessions');
  if (source === 'antigravity') return path.join(home, '.gemini', 'antigravity');
  return path.join(home, '.gemini', 'tmp');
}
/** Opaque, stable id of a session (no path leaves the server). */
export const sessionId = (source: LocalSource, file: string, key?: string) => createHash('sha256').update(`${source}\0${file}${key ? `\0${key}` : ''}`).digest('hex').slice(0, 32);

/**
 * The only files this reader may open, relative to the source root. Credential,
 * account, settings and state files (e.g. ~/.gemini/oauth_creds.json) can never
 * match: they are outside these patterns.
 */
const READABLE: Record<LocalSource, RegExp> = {
  'claude-code': /^[^/]+\/[^/]+\.jsonl$/,
  codex: /^(?:[^/]+\/){0,3}[^/]+\.jsonl$/,
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
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
}
async function sessionFiles(source: 'claude-code' | 'codex', home?: string): Promise<string[]> {
  const out: string[] = [];
  await walk(sourceRoot(source, home), source === 'claude-code' ? 1 : 3, out);
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
/** Antigravity: the conversations in its search index (plain text), grouped by conversation. */
async function readAntigravity(file: string): Promise<Map<string, { turns: Turn[]; cwd: string | null; startedAt: string | null; updatedAt: string | null; title: string }>> {
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
  const turns: Turn[] = []; let cwd: string | null = null; let startedAt: string | null = null;
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o: unknown; try { o = JSON.parse(line); } catch { continue; }
    const r = lineTurns(source, o);
    if (r.cwd && !cwd) cwd = r.cwd;
    if (r.at && !startedAt) startedAt = r.at;
    for (const t of r.turns) pushTurn(turns, t);
  }
  return { turns, cwd, startedAt };
}

/** Sessions on this computer, newest first (title = start of the first human message). */
export async function listLocalSessions(home?: string): Promise<LocalSession[]> {
  const found: Found[] = [];
  for (const source of LOCAL_SOURCES) found.push(...await enumerate(source, home));
  found.sort((a, b) => b.mtime - a.mtime);
  const out: LocalSession[] = [];
  for (const f of found.slice(0, MAX_SESSIONS)) {
    if (f.size > MAX_SESSION_BYTES) continue;
    try {
      const s = await readSession(f, home);
      const first = s.turns.find(t => t.role === 'user');
      if (!first) continue;
      out.push({ id: sessionId(f.source, f.file, f.key), source: f.source, cwd: s.cwd, title: (s.title || first.text).replace(/\s+/g, ' ').slice(0, 120), startedAt: s.startedAt, updatedAt: new Date(f.mtime).toISOString(), bytes: f.size, turns: s.turns.length });
    } catch { /* unreadable: left out */ }
  }
  return out;
}

/** The conversation behind an opaque id (only conversations under the known roots). */
export async function findSession(id: string, home?: string): Promise<SessionRef | null> {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  for (const source of LOCAL_SOURCES) for (const f of await enumerate(source, home)) if (sessionId(f.source, f.file, f.key) === id) return { source: f.source, file: f.file, ...(f.key ? { key: f.key } : {}) };
  return null;
}

/** A transcript as Markdown (for the archive and the memory agent). */
export function transcriptMarkdown(source: LocalSource, s: { turns: Turn[]; cwd: string | null; startedAt: string | null }): string {
  const who = SOURCE_NAMES[source];
  return [`# ${who} conversation`, s.cwd ? `Folder: ${s.cwd}` : '', s.startedAt ? `Started: ${s.startedAt}` : '', '',
    ...s.turns.map(t => `## ${t.role === 'user' ? 'Owner' : who}\n\n${t.text}`)].filter((l, i) => l !== '' || i > 2).join('\n\n');
}
