/**
 * "Found on this computer" (DISCOVER-01, board M17): one scan finds what coding
 * agents left on this computer, grouped by project folder and kind, and hands
 * each item to the part of Dpro that already owns it.
 *
 *   memory  Claude Code memory files  ~/.claude/projects/<folder>/memory/*.md
 *           → one memory each (user → About you, feedback → Lessons,
 *             project / reference → that project's drawer), no model
 *   note    CLAUDE / AGENTS / GEMINI / HANDOFF / BACKLOG / TASKS / … .md in a
 *           project folder (and its docs/), plus the global ones
 *           → the Project files import (local model, facts by project)
 *   skill   SKILL.md folders (~/.claude/skills, ~/.codex/skills, ~/.agents/skills,
 *           <project>/.claude/skills) → the skill library, assigned to no agent
 *   mcp     MCP servers in Claude / Claude Desktop / Codex configs and project
 *           .mcp.json → MCP servers, switched off; a token goes only to the
 *           encrypted store, and only when the owner chooses so
 *   ssh     Host entries of ~/.ssh/config → SSH hosts (names only)
 *
 * Read only: no file here is ever changed, moved or deleted. Never read: private
 * keys (an IdentityFile is named, never opened), .env files, browser, keychain
 * or wallet data. Paths work on macOS, Windows and Linux (os.homedir + path).
 * Every response is redacted; every import carries the previewHash the owner saw.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { q } from '../repositories/sql-steps.js';
import { readRegularFile } from '../services/read-regular-file.js';
import { redactImportText } from '../memory/import/redact.js';
import { claudeFolderCwd, listLocalSessions, matchProject, projectRoot, relocateGoneRoots, rootDrawerKey, type ProjectRoot } from '../memory/import/local-agents.js';
import { registerProjectDocument } from '../memory/import/project-documents.js';
import { startImport } from '../memory/import/local-import.js';
import { listProjects, type Project } from '../repositories/chat-conversations.js';
import { centralSkills, skillBundle, SkillLibraryError } from '../skills/central-store.js';
import { LocalMcpImport, LocalMcpError, type FoundMcp } from '../mcp-client/local-import.js';
import { deleteServer } from '../mcp-client/service.js';
import { approveProposal, createChangeProposal, MemoryFileError, resolveFileAgent, type MemoryChange } from '../memory/memory-files.js';
import { parseDrawerId, type DrawerRef } from '../memory/drawers.js';

export const DISCOVERY_KINDS = ['memory', 'note', 'skill', 'mcp', 'ssh'] as const;
export type DiscoveryKind = (typeof DISCOVERY_KINDS)[number];
export type DiscoveryState = 'new' | 'changed' | 'decision' | 'imported' | 'ignored' | 'gone';
export class DiscoveryError extends Error { constructor(readonly code: string, readonly status = 400) { super(code); } }

/** One thing found (server side; `file` never leaves the server except as a home-relative path in `from`). */
type Found = {
  id: string; kind: DiscoveryKind; name: string; from: string; root: string | null; file: string; hash: string; updatedAt: string;
  memory?: { type: string; description: string; body: string };
  skill?: { origin: string; description: string };
  mcp?: FoundMcp & { secrets: string[] };
  ssh?: { alias: string; host: string | null; user: string | null; port: number | null; key: string | null };
  note?: { root: string };
  skillTaken?: { agents: number };
};
export type DiscoveryItem = { id: string; kind: DiscoveryKind; name: string; from: string; rootId: string | null; to: string; state: DiscoveryState; updatedAt: string };
export type DiscoveryRoot = { id: string; name: string; path: string | null; project: string | null; count: number; fresh: number; watch: boolean };
type Row = { item_id: string; kind: DiscoveryKind; name: string; root: string | null; state: 'imported' | 'ignored' | 'kept'; ref: string | null; hash: string | null };
type Scan = { at: number; ms: number; found: Found[] };

const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const itemId = (kind: DiscoveryKind, rel: string, key = '') => sha(`${kind}\0${rel}\0${key}`).slice(0, 32);
export const rootId = (root: string | null) => (root ? sha(`root\0${root}`).slice(0, 32) : 'computer');
const MAX_MEMORY_FILE = 64 * 1024, MAX_NOTE = 1024 * 1024, MAX_SSH_CONFIG = 256 * 1024;
const NOTE_NAMES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'HANDOFF.md', 'BACKLOG.md', 'TASKS.md', 'PROJECT_MEMORY.md', 'DECISIONS.md'];
const INTERVALS = [15, 30, 60] as const;

let ready: Promise<void> | undefined;
function init() {
  return ready ??= (async () => {
    await q.run('CREATE TABLE IF NOT EXISTS discovery_items (user_id TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, root TEXT, state TEXT NOT NULL, ref TEXT, hash TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, item_id))');
    await q.run('CREATE TABLE IF NOT EXISTS discovery_roots (user_id TEXT NOT NULL, root_id TEXT NOT NULL, watch INTEGER NOT NULL, PRIMARY KEY (user_id, root_id))');
    await q.run('CREATE TABLE IF NOT EXISTS discovery_settings (user_id TEXT PRIMARY KEY, watch INTEGER NOT NULL, interval_minutes INTEGER NOT NULL)');
    await q.run('CREATE TABLE IF NOT EXISTS ssh_hosts (user_id TEXT NOT NULL, alias TEXT NOT NULL, host TEXT, login TEXT, port INTEGER, key_name TEXT, created_at TEXT NOT NULL, PRIMARY KEY (user_id, alias))');
  })().catch((e) => { ready = undefined; throw e; });
}

const homeRel = (home: string, file: string) => { const r = path.relative(home, file); return r && !r.startsWith('..') && !path.isAbsolute(r) ? `~${path.sep}${r}` : file; };
const isDir = async (p: string) => (await fs.lstat(p).catch(() => null))?.isDirectory() === true;
const isFile = async (p: string) => (await fs.lstat(p).catch(() => null))?.isFile() === true;
async function readText(file: string, max: number): Promise<{ text: string; mtime: string } | null> {
  try {
    const { data, stat } = await readRegularFile(file, max);
    const text = data.toString('utf8');
    return text.includes('\0') ? null : { text, mtime: stat.mtime.toISOString() };
  } catch { return null; }
}

// ---- memory files ----
/** `name`, `description`, `type` (or metadata.type) from a memory file's front matter, and its body. */
export function parseMemoryFile(text: string): { name: string | null; description: string; type: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  let meta: any = {};
  if (m) { try { meta = yaml.load(m[1], { schema: yaml.JSON_SCHEMA }) ?? {}; } catch { meta = {}; } }
  const type = String(meta?.type ?? meta?.metadata?.type ?? 'project').toLowerCase();
  return { name: typeof meta?.name === 'string' ? meta.name : null, description: typeof meta?.description === 'string' ? meta.description : '', type: ['user', 'feedback', 'project', 'reference'].includes(type) ? type : 'project', body: (m ? m[2] : text).trim() };
}
/**
 * The folder a Claude Code project folder name stands for, when no conversation
 * says it: `-Users-me-work-shop` → /Users/me/work/shop (each "-" may be a folder
 * break or part of a name; the first path that exists wins).
 */
export async function decodeClaudeFolder(name: string, platformSep = path.sep): Promise<string | null> {
  const drive = /^([A-Za-z])--(.*)$/.exec(name);
  const parts = (drive ? drive[2] : name.replace(/^-/, '')).split('-');
  const start = drive ? `${drive[1]}:${platformSep}` : platformSep;
  let tries = 0;
  const walk = async (base: string, i: number): Promise<string | null> => {
    if (i >= parts.length) return base;
    for (let j = parts.length; j > i; j--) {
      if (++tries > 400) return null;
      for (const glue of ['-', '_', '.', ' ']) {
        const piece = parts.slice(i, j).join(glue);
        if (!piece) continue;
        const next = path.join(base, piece);
        if (await isDir(next)) { const r = await walk(next, j); if (r) return r; }
        if (j - i === 1) break;
      }
    }
    return null;
  };
  return walk(start, 0);
}
async function memoryFiles(home: string, roots: Map<string, ProjectRoot>): Promise<Found[]> {
  const out: Found[] = [];
  const top = path.join(home, '.claude', 'projects');
  let dirs: string[]; try { dirs = await fs.readdir(top); } catch { return out; }
  for (const d of dirs) {
    const mem = path.join(top, d, 'memory');
    if (!(await isDir(mem))) continue;
    let files: string[]; try { files = (await fs.readdir(mem)).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md'); } catch { continue; }
    if (!files.length) continue;
    // The Claude folder name is the folder on this computer; a conversation's folder may be from an older one.
    const cwd = await decodeClaudeFolder(d) ?? await claudeFolderCwd(path.join(top, d), home);
    const pr = await projectRoot(cwd, home);
    if (pr) roots.set(pr.root, pr);
    const root = pr?.root ?? null;
    for (const f of files.slice(0, 500)) {
      const file = path.join(mem, f);
      const t = await readText(file, MAX_MEMORY_FILE); if (!t) continue;
      const p = parseMemoryFile(t.text);
      out.push({ id: itemId('memory', path.relative(home, file)), kind: 'memory', name: (p.name ?? f.replace(/\.md$/, '')).slice(0, 120), from: `Claude Code memory · ${p.type}`, root, file, hash: sha(t.text), updatedAt: t.mtime, memory: { type: p.type, description: p.description, body: p.body } });
    }
  }
  return out;
}

// ---- project notes ----
async function notes(home: string, roots: string[]): Promise<Found[]> {
  const out: Found[] = [];
  const add = async (root: string | null, docRoot: string, file: string, label: string) => {
    if (!(await isFile(file))) return;
    const t = await readText(file, MAX_NOTE); if (!t) return;
    out.push({ id: itemId('note', path.relative(home, file)), kind: 'note', name: path.relative(docRoot, file), from: label, root, file, hash: sha(t.text), updatedAt: t.mtime, note: { root: docRoot } });
  };
  for (const [dir, name] of [[path.join(home, '.claude'), 'CLAUDE.md'], [path.join(home, '.codex'), 'AGENTS.md'], [path.join(home, '.gemini'), 'GEMINI.md']]) await add(null, dir, path.join(dir, name), 'global agent notes');
  for (const root of roots) for (const sub of ['', 'docs']) for (const name of NOTE_NAMES) await add(root, root, path.join(root, sub, name), sub ? 'project notes (docs)' : 'project notes');
  return out;
}

// ---- skills ----
async function skills(home: string, roots: string[]): Promise<Found[]> {
  const out: Found[] = [];
  const places: { dir: string; origin: string; root: string | null }[] = [
    { dir: path.join(home, '.claude', 'skills'), origin: 'claude', root: null },
    { dir: path.join(home, '.codex', 'skills'), origin: 'codex', root: null },
    { dir: path.join(home, '.agents', 'skills'), origin: 'shared', root: null },
    ...roots.map((r) => ({ dir: path.join(r, '.claude', 'skills'), origin: 'project', root: r })),
  ];
  for (const p of places) {
    let entries; try { entries = await fs.readdir(p.dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries.slice(0, 300)) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(p.dir, e.name);
      if (!(await isFile(path.join(dir, 'SKILL.md')))) continue;
      try {
        const b = await skillBundle(dir);
        const st = await fs.stat(path.join(dir, 'SKILL.md'));
        out.push({ id: itemId('skill', path.relative(home, dir)), kind: 'skill', name: b.name, from: `${homeRel(home, dir)}${path.sep}SKILL.md`, root: p.root, file: dir, hash: b.hash, updatedAt: st.mtime.toISOString(), skill: { origin: p.origin, description: b.description.slice(0, 400) } });
      } catch { /* not a valid skill folder */ }
    }
  }
  return out;
}

// ---- MCP servers ----
async function mcpServers(home: string, roots: string[], mcp: LocalMcpImport): Promise<Found[]> {
  const extra = [];
  for (const r of roots) { const f = path.join(r, '.mcp.json'); if (await isFile(f)) extra.push({ origin: 'project', file: f }); }
  const { servers } = await mcp.found(extra);
  const out: Found[] = [];
  for (const s of servers) {
    const root = s.project ? (await projectRoot(s.project, home))?.root ?? s.project : s.origin === 'project' ? path.dirname(s.file) : null;
    const secrets = [...Object.keys(s.input?.env ?? {}), ...Object.keys((s.input as any)?.headers ?? {})];
    const st = await fs.stat(s.file).catch(() => null);
    out.push({ id: itemId('mcp', path.relative(home, s.file), `${s.project ?? ''}\0${s.key}`), kind: 'mcp', name: s.name, from: `${homeRel(home, s.file)}${secrets.length ? ` · ${secrets.length} secret${secrets.length === 1 ? '' : 's'} inside` : ''}${s.issue ? ` · ${s.issue.replace(/_/g, ' ')}` : ''}`, root, file: s.file, hash: s.hash ?? sha(`issue\0${s.issue}`), updatedAt: st?.mtime.toISOString() ?? new Date(0).toISOString(), mcp: { ...s, secrets } });
  }
  return out;
}

// ---- SSH hosts ----
/** Host blocks of an ssh config: alias, HostName, User, Port and the key file's name (never its content). Wildcard hosts are left out. */
export function parseSshConfig(text: string): { alias: string; host: string | null; user: string | null; port: number | null; key: string | null; block: string }[] {
  const out: { alias: string; host: string | null; user: string | null; port: number | null; key: string | null; block: string }[] = [];
  let cur: (typeof out)[number][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const m = /^(\S+)\s*(?:=\s*|\s+)(.*)$/.exec(line); if (!m) continue;
    const key = m[1].toLowerCase(), value = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      cur = value.split(/\s+/).filter((a) => a && !/[*?!]/.test(a)).map((alias) => ({ alias, host: null, user: null, port: null, key: null, block: `Host ${alias}` }));
      out.push(...cur);
    } else if (key === 'match') cur = [];
    else for (const h of cur) {
      if (key === 'hostname') { h.host = value; h.block += `\n  HostName ${value}`; }
      else if (key === 'user') { h.user = value; h.block += `\n  User ${value}`; }
      else if (key === 'port' && /^\d{1,5}$/.test(value)) { h.port = Number(value); h.block += `\n  Port ${value}`; }
      else if (key === 'identityfile') { h.key = value.split(/[\\/]/).pop() ?? null; h.block += `\n  IdentityFile ${h.key} (name only)`; }
    }
  }
  return out.slice(0, 200);
}
async function sshHosts(home: string): Promise<Found[]> {
  const file = path.join(home, '.ssh', 'config');
  const t = await readText(file, MAX_SSH_CONFIG); if (!t) return [];
  return parseSshConfig(t.text).map((h) => ({ id: itemId('ssh', path.relative(home, file), h.alias), kind: 'ssh' as const, name: h.alias, from: `${homeRel(home, file)}`, root: null, file, hash: sha(h.block), updatedAt: t.mtime, ssh: { alias: h.alias, host: h.host, user: h.user, port: h.port, key: h.key } }));
}

// ---- scan, state, list ----
const scans = new Map<string, Scan>();
const running = new Map<string, Promise<Scan>>();
export type DiscoveryOptions = { home?: string; mcp?: LocalMcpImport };
const mcpFor = (o: DiscoveryOptions) => o.mcp ?? new LocalMcpImport(o.home ?? os.homedir());

/** Reads everything (read only) and keeps the result for the list. */
export async function scan(userId: string, opts: DiscoveryOptions = {}): Promise<Scan> {
  await init();
  const prev = running.get(userId); if (prev) return prev;
  const work = (async () => {
    const t0 = Date.now(); const home = opts.home ?? os.homedir();
    const projects = await listProjects(userId).catch(() => [] as Project[]);
    const unwatched = new Set((await q.all<{ root_id: string }>('SELECT root_id FROM discovery_roots WHERE user_id = ? AND watch = 0', userId)).map((r) => r.root_id));
    const known = new Map<string, ProjectRoot>();
    const mem = await memoryFiles(home, known);
    const roots = new Set<string>();
    for (const r of known.values()) if (r.here) roots.add(r.root);
    for (const s of await listLocalSessions(home).catch(() => [])) if (s.root && path.isAbsolute(s.root) && await isDir(s.root)) roots.add(s.root);
    for (const p of projects) if (p.folder && await isDir(p.folder)) roots.add(p.folder);
    // A folder from an older computer (or a removed worktree) joins the same project here.
    const here = () => [...roots].map((r) => ({ root: r, name: path.basename(r), here: true }));
    let moved = await relocateGoneRoots([...known.values(), ...here()], home);
    for (const m of mem) { const to = m.root ? moved.get(m.root) : null; if (to) { m.root = to.root; roots.add(to.root); } }
    const list = [...roots].filter((r) => r !== home);
    const mcp = await mcpServers(home, list, mcpFor(opts));
    const mcpRoots = await Promise.all([...new Set(mcp.map((m) => m.root).filter((r): r is string => !!r && !roots.has(r)))].map((r) => projectRoot(r, home)));
    moved = await relocateGoneRoots([...mcpRoots, ...here()], home);
    for (const m of mcp) { const to = m.root ? moved.get(m.root) : null; if (to) m.root = to.root; }
    const found = [...mem, ...await notes(home, list), ...await skills(home, list), ...mcp, ...await sshHosts(home)]
      .filter((f) => !unwatched.has(rootId(f.root)));
    const s: Scan = { at: Date.now(), ms: Date.now() - t0, found };
    scans.set(userId, s);
    return s;
  })().finally(() => running.delete(userId));
  running.set(userId, work);
  return work;
}

type Ctx = { projects: Project[]; home: string };
/** A Dpro skill with this name, and whether this page added it (only then may it be replaced). */
async function skillInDpro(userId: string, name: string, saved: Row | undefined) {
  const s = await q.one<{ id: string; content_hash: string }>('SELECT id, content_hash FROM central_skills WHERE name = ?', name).catch(() => undefined);
  if (!s) return null;
  const agents = (await q.one<{ n: number }>('SELECT COUNT(*) AS n FROM central_agent_skills WHERE skill_id = ?', s.id).catch(() => undefined))?.n ?? 0;
  return { ...s, agents: Number(agents), ours: saved?.ref === s.id };
}
/** Where an item goes in Dpro, and the memory drawer for memory files. */
function destination(f: Pick<Found, 'kind' | 'root' | 'memory' | 'mcp'> & { skillTaken?: { agents: number } }, ctx: Ctx): { to: string; drawer: string } {
  const project = f.root ? matchProject(f.root, f.root, ctx.projects) : undefined;
  const key = project?.slug ?? rootDrawerKey(f.root, ctx.home);
  const projectDrawer = key ? `project:${key}` : 'owner';
  const label = key ? `Projects · ${project?.name ?? key}` : 'About you';
  if (f.kind === 'memory') {
    const t = f.memory?.type;
    if (t === 'user') return { to: 'About you', drawer: 'owner' };
    if (t === 'feedback') return { to: 'Lessons', drawer: 'experience' };
    return { to: label, drawer: projectDrawer };
  }
  if (f.kind === 'note') return { to: `${label} · read by the local model`, drawer: projectDrawer };
  if (f.kind === 'skill') return { to: f.skillTaken ? `Skills · replaces the skill this page added${f.skillTaken.agents ? ` (used by ${f.skillTaken.agents} agent${f.skillTaken.agents === 1 ? '' : 's'})` : ''}` : 'Skills · off until assigned', drawer: '' };
  if (f.kind === 'mcp') return { to: `MCP · off${f.mcp?.secrets.length ? ' · secret → Credentials' : ''}`, drawer: '' };
  return { to: 'SSH hosts · names only', drawer: '' };
}

async function rows(userId: string): Promise<Map<string, Row>> {
  await init();
  return new Map((await q.all<Row>('SELECT item_id, kind, name, root, state, ref, hash FROM discovery_items WHERE user_id = ?', userId)).map((r) => [r.item_id, r]));
}
async function stateOf(f: Found, row: Row | undefined, mcp: LocalMcpImport): Promise<DiscoveryState> {
  if (row?.state === 'ignored') return 'ignored';
  if (row?.state === 'imported' || row?.state === 'kept') return row.hash === f.hash ? 'imported' : 'changed';
  if (f.kind === 'skill') {
    const s = await q.one<{ content_hash: string }>('SELECT content_hash FROM central_skills WHERE name = ?', f.name).catch(() => undefined);
    return s ? (s.content_hash === f.hash ? 'imported' : 'decision') : 'decision';
  }
  if (f.kind === 'mcp') return f.mcp?.input && await mcp.existing(f.mcp.input) ? 'imported' : 'decision';
  return 'new';
}

export type DiscoveryView = { scannedAt: string | null; ms: number; settings: { watch: boolean; intervalMinutes: number }; roots: DiscoveryRoot[]; items: DiscoveryItem[] };
/** The page: projects, items and their state (scans first when nothing was read yet). */
export async function view(userId: string, opts: DiscoveryOptions & { rescan?: boolean } = {}): Promise<DiscoveryView> {
  await init();
  const s = !opts.rescan && scans.get(userId) || await scan(userId, opts);
  const home = opts.home ?? os.homedir(); const mcp = mcpFor(opts);
  const ctx: Ctx = { projects: await listProjects(userId).catch(() => []), home };
  const saved = await rows(userId);
  const items: DiscoveryItem[] = [];
  const seen = new Set<string>();
  for (const f of s.found) {
    seen.add(f.id);
    items.push({ id: f.id, kind: f.kind, name: redactImportText(f.name).text, from: redactImportText(f.from).text, rootId: f.root ? rootId(f.root) : null, to: destination(f, ctx).to, state: await stateOf(f, saved.get(f.id), mcp), updatedAt: f.updatedAt });
  }
  const unwatched = new Set((await q.all<{ root_id: string }>('SELECT root_id FROM discovery_roots WHERE user_id = ? AND watch = 0', userId)).map((r) => r.root_id));
  for (const r of saved.values()) if (!seen.has(r.item_id) && r.state === 'imported' && !unwatched.has(rootId(r.root))) {
    items.push({ id: r.item_id, kind: r.kind, name: r.name, from: 'no longer on this computer', rootId: r.root ? rootId(r.root) : null, to: destination({ kind: r.kind, root: r.root }, ctx).to, state: 'gone', updatedAt: '' });
  }
  const byRoot = new Map<string, { root: string | null; count: number; fresh: number }>();
  const rootPaths = new Map<string, string | null>([['computer', null]]);
  for (const f of s.found) rootPaths.set(rootId(f.root), f.root);
  for (const r of saved.values()) if (r.root) rootPaths.set(rootId(r.root), r.root);
  for (const it of items) {
    const k = it.rootId ?? 'computer'; const g = byRoot.get(k) ?? { root: rootPaths.get(k) ?? null, count: 0, fresh: 0 };
    g.count++; if (it.state === 'new' || it.state === 'changed' || it.state === 'decision') g.fresh++; byRoot.set(k, g);
  }
  const roots: DiscoveryRoot[] = [...byRoot].map(([id, g]) => {
    const project = g.root ? matchProject(g.root, g.root, ctx.projects) : undefined;
    const key = project ? null : rootDrawerKey(g.root, home);
    return { id, name: g.root ? path.basename(g.root) || g.root : 'This computer', path: g.root ? homeRel(home, g.root) : null, project: project ? `Dpro project ${project.name}` : key ? `Projects · ${key}` : g.root ? 'About you' : 'not a project · SSH, user skills', count: g.count, fresh: g.fresh, watch: true };
  });
  for (const id of unwatched) roots.push({ id, name: 'Not watched', path: null, project: null, count: 0, fresh: 0, watch: false });
  roots.sort((a, b) => (a.id === 'computer' ? -1 : b.id === 'computer' ? 1 : b.count - a.count));
  return { scannedAt: new Date(s.at).toISOString(), ms: s.ms, settings: await settings(userId), roots, items };
}

function foundItem(userId: string, id: string): Found {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new DiscoveryError('invalid_input');
  const f = scans.get(userId)?.found.find((x) => x.id === id);
  if (!f) throw new DiscoveryError('not_found', 404);
  return f;
}
/** What the owner sees before importing; previewHash binds the import to it. */
export async function preview(userId: string, id: string, opts: DiscoveryOptions = {}) {
  await init();
  if (!scans.get(userId)) await scan(userId, opts);
  const f = foundItem(userId, id);
  const home = opts.home ?? os.homedir();
  const ctx: Ctx = { projects: await listProjects(userId).catch(() => []), home };
  const saved = (await rows(userId)).get(id);
  const inDpro = f.kind === 'skill' ? await skillInDpro(userId, f.name, saved) : null;
  const taken = inDpro && inDpro.content_hash !== f.hash ? inDpro : null;
  const dest = destination({ ...f, ...(taken?.ours ? { skillTaken: { agents: taken.agents } } : {}) }, ctx);
  let text = '';
  if (f.kind === 'memory') text = memoryContent(f);
  else if (f.kind === 'note') text = (await readText(f.file, MAX_NOTE))?.text ?? '';
  else if (f.kind === 'skill') text = (await readText(path.join(f.file, 'SKILL.md'), 200_000))?.text ?? '';
  else if (f.kind === 'mcp') {
    const i = f.mcp?.input as any;
    text = i ? JSON.stringify({ command: i.command, args: i.args, url: i.url, env: Object.fromEntries(Object.keys(i.env ?? {}).map((k) => [k, '••••••••'])), headers: Object.fromEntries(Object.keys(i.headers ?? {}).map((k) => [k, '••••••••'])) }, null, 2) : `Cannot be added: ${f.mcp?.issue?.replace(/_/g, ' ')}`;
  } else if (f.ssh) text = [`Host ${f.ssh.alias}`, f.ssh.host ? `  HostName ${f.ssh.host}` : '', f.ssh.user ? `  User ${f.ssh.user}` : '', f.ssh.port ? `  Port ${f.ssh.port}` : '', f.ssh.key ? `  IdentityFile ${f.ssh.key} (name only; the key is never read)` : ''].filter(Boolean).join('\n');
  const clean = redactImportText(text).text;
  return {
    id, kind: f.kind, name: redactImportText(f.name).text, from: redactImportText(f.from).text, to: dest.to, state: await stateOf(f, saved, mcpFor(opts)),
    text: clean.slice(0, 20000), truncated: clean.length > 20000, secrets: f.mcp?.secrets ?? [], blocked: f.mcp?.issue ?? (taken && !taken.ours ? 'skill_name_taken' : null),
    previewHash: sha(`${f.kind}\0${f.id}\0${f.hash}\0${dest.to}\0${inDpro?.content_hash ?? ''}`),
  };
}

const MEMORY_TYPE: Record<string, string> = { user: 'preference', feedback: 'insight', project: 'fact', reference: 'fact' };
function memoryContent(f: Found): string {
  const m = f.memory!;
  const head = m.description ? `${f.name}: ${m.description}` : f.name;
  return redactImportText(`${head}${m.body ? `\n\n${m.body}` : ''}`).text.slice(0, 4000);
}
async function applyMemory(userId: string, drawerText: string, changes: MemoryChange[], reason: string) {
  const drawer = parseDrawerId(drawerText) as DrawerRef;
  const p = await createChangeProposal({ userId, agentId: await resolveFileAgent(), drawer, changes, source: 'import', reasons: [reason], createdBy: userId, skipPendingLimit: true });
  return approveProposal(userId, p.id, userId, p.reviewHash);
}
async function currentMemory(userId: string, id: string) {
  const m = await q.one<{ type: string; importance_score: number | null; content: string }>("SELECT type, importance_score, content FROM memories WHERE id = ? AND user_id = ? AND (status IS NULL OR status = 'active')", id, userId);
  // The same 1-10 importance the memory files use (memory-files.ts importanceOf).
  return m ? { type: m.type, importance: Math.min(10, Math.max(1, Math.round((typeof m.importance_score === 'number' ? m.importance_score : 0.5) * 10))), content: m.content } : undefined;
}
async function save(userId: string, f: Pick<Found, 'id' | 'kind' | 'name' | 'root'>, state: Row['state'], ref: string | null, hash: string | null) {
  await q.run(`INSERT INTO discovery_items (user_id, item_id, kind, name, root, state, ref, hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, item_id) DO UPDATE SET kind = excluded.kind, name = excluded.name, root = excluded.root, state = excluded.state, ref = excluded.ref, hash = excluded.hash, updated_at = excluded.updated_at`,
  userId, f.id, f.kind, redactImportText(f.name).text.slice(0, 200), f.root, state, ref, hash, new Date().toISOString());
}

export type ImportResult = { id: string; ok: boolean; state?: DiscoveryState; code?: string; jobId?: string };
/** Import or update items the owner previewed (each with its previewHash). */
export async function importItems(userId: string, items: { id: string; previewHash: string; secret?: 'credentials' | 'leave' }[], opts: DiscoveryOptions = {}): Promise<ImportResult[]> {
  await init();
  if (!scans.get(userId)) await scan(userId, opts);
  const out: ImportResult[] = []; const noteDocs: { f: Found; doc: string }[] = [];
  const mcp = mcpFor(opts);
  for (const it of items) {
    try {
      const p = await preview(userId, it.id, opts);
      if (p.previewHash !== it.previewHash) throw new DiscoveryError('preview_changed', 409);
      const f = foundItem(userId, it.id);
      const saved = (await rows(userId)).get(f.id);
      const ctx: Ctx = { projects: await listProjects(userId).catch(() => []), home: opts.home ?? os.homedir() };
      if (f.kind === 'memory') {
        const after = { type: MEMORY_TYPE[f.memory!.type] ?? 'fact', importance: f.memory!.type === 'feedback' ? 7 : 6, content: memoryContent(f) };
        const before = saved?.ref ? await currentMemory(userId, saved.ref) : undefined;
        const drawer = destination(f, ctx).drawer;
        const r = before && saved?.ref
          ? await applyMemory(userId, drawer, [{ op: 'update', id: saved.ref, before, after }], 'Claude Code memory file changed')
          : await applyMemory(userId, drawer, [{ op: 'add', after }], 'Claude Code memory file');
        await save(userId, f, 'imported', r.applied.updated[0] ?? r.applied.added[0] ?? saved?.ref ?? null, f.hash);
      } else if (f.kind === 'note') {
        noteDocs.push({ f, doc: await registerProjectDocument(userId, f.note!.root, f.file) });
        continue;
      } else if (f.kind === 'skill') {
        const existing = await skillInDpro(userId, f.name, saved);
        // Only a skill this page added may be replaced; another skill with the name stays as it is.
        if (existing && existing.content_hash !== f.hash && !existing.ours) throw new DiscoveryError('skill_name_taken', 409);
        const r = await centralSkills().installFolder(f.file, f.skill!.origin, f.hash, existing && existing.content_hash !== f.hash ? existing.content_hash : undefined);
        // Remove may later delete only what this page added, never a skill that was already there.
        await save(userId, f, 'imported', r.duplicate && !existing?.ours ? null : r.skill.id, f.hash);
      } else if (f.kind === 'mcp') {
        const r = await mcp.importFound(userId, f.mcp!, f.mcp!.hash ?? '', it.secret !== 'leave');
        // A server that was already in Dpro is not this page's to remove later.
        await save(userId, f, 'imported', r.duplicate ? null : r.id, f.hash);
      } else {
        const h = f.ssh!;
        await q.run(`INSERT INTO ssh_hosts (user_id, alias, host, login, port, key_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (user_id, alias) DO UPDATE SET host = excluded.host, login = excluded.login, port = excluded.port, key_name = excluded.key_name`, userId, h.alias, h.host, h.user, h.port, h.key, new Date().toISOString());
        await save(userId, f, 'imported', h.alias, f.hash);
      }
      out.push({ id: it.id, ok: true, state: 'imported' });
    } catch (e) { out.push({ id: it.id, ok: false, code: codeOf(e) }); }
  }
  if (noteDocs.length) {
    // One job for the selected notes (the local model reads them; the job keeps its progress).
    try {
      const job = await startImport(userId, noteDocs.map((n) => n.doc));
      for (const n of noteDocs) { await save(userId, n.f, 'imported', n.doc, n.f.hash); out.push({ id: n.f.id, ok: true, state: 'imported', jobId: job.id }); }
    } catch (e) { for (const n of noteDocs) out.push({ id: n.f.id, ok: false, code: codeOf(e) }); }
  }
  return out;
}
function codeOf(e: unknown): string {
  if (e instanceof DiscoveryError || e instanceof SkillLibraryError || e instanceof LocalMcpError) return e.code;
  if ((e as { code?: unknown })?.code === 'import_running') return 'import_running';
  if (e instanceof MemoryFileError) return 'memory_refused';
  return 'import_failed';
}

/** Ignore an item (on) or stop ignoring it (off). */
export async function ignore(userId: string, id: string, on: boolean) {
  await init();
  if (!/^[a-f0-9]{32}$/.test(id) || typeof on !== 'boolean') throw new DiscoveryError('invalid_input');
  const saved = (await rows(userId)).get(id);
  if (on) {
    const f = scans.get(userId)?.found.find((x) => x.id === id);
    if (!f && !saved) throw new DiscoveryError('not_found', 404);
    await save(userId, f ?? { id, kind: saved!.kind, name: saved!.name, root: saved!.root }, 'ignored', saved?.ref ?? null, saved?.hash ?? null);
  } else if (saved?.state === 'ignored') {
    if (saved.ref) await q.run("UPDATE discovery_items SET state = 'imported' WHERE user_id = ? AND item_id = ?", userId, id);
    else await q.run('DELETE FROM discovery_items WHERE user_id = ? AND item_id = ?', userId, id);
  }
  return { id, ignored: on };
}

/** Take an imported item out of Dpro (the file here stays); it is then ignored so it is not offered again. */
export async function remove(userId: string, id: string) {
  await init();
  if (!/^[a-f0-9]{32}$/.test(id)) throw new DiscoveryError('invalid_input');
  const saved = (await rows(userId)).get(id);
  if (!saved || !saved.ref || saved.state === 'ignored') throw new DiscoveryError('not_imported', 409);
  if (saved.kind === 'note') throw new DiscoveryError('not_removable', 409);
  if (saved.kind === 'memory') {
    const before = await currentMemory(userId, saved.ref);
    if (before) {
      const d = await q.one<{ drawer_kind: string | null; drawer_key: string | null }>('SELECT drawer_kind, drawer_key FROM memories WHERE id = ?', saved.ref);
      const drawer = d?.drawer_kind ? (d.drawer_key ? `${d.drawer_kind}:${d.drawer_key}` : d.drawer_kind) : 'owner';
      await applyMemory(userId, drawer, [{ op: 'delete', id: saved.ref, before }], 'Removed from Found on this computer');
    }
  } else if (saved.kind === 'skill') await centralSkills().remove(saved.ref);
  else if (saved.kind === 'mcp') await deleteServer(saved.ref, `user:${userId}`).catch((e) => { if ((e as { status?: number })?.status !== 404) throw e; });
  else await q.run('DELETE FROM ssh_hosts WHERE user_id = ? AND alias = ?', userId, saved.ref);
  await q.run("UPDATE discovery_items SET state = 'ignored', ref = NULL, updated_at = ? WHERE user_id = ? AND item_id = ?", new Date().toISOString(), userId, id);
  return { id, removed: true };
}
/** Gone from this computer: keep what Dpro has (stop showing it as gone). */
export async function keep(userId: string, id: string) {
  await init();
  if (!/^[a-f0-9]{32}$/.test(id)) throw new DiscoveryError('invalid_input');
  const r = await q.run("UPDATE discovery_items SET state = 'kept', updated_at = ? WHERE user_id = ? AND item_id = ? AND state = 'imported'", new Date().toISOString(), userId, id);
  if (!r.changes) throw new DiscoveryError('not_found', 404);
  return { id, kept: true };
}

export async function settings(userId: string) {
  await init();
  const r = await q.one<{ watch: number; interval_minutes: number }>('SELECT watch, interval_minutes FROM discovery_settings WHERE user_id = ?', userId);
  return { watch: r ? r.watch === 1 : true, intervalMinutes: r?.interval_minutes ?? 30 };
}
export async function setSettings(userId: string, input: unknown) {
  await init();
  const b = input as Record<string, unknown>;
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).sort().join(',') !== 'intervalMinutes,watch' || typeof b.watch !== 'boolean' || !(INTERVALS as readonly unknown[]).includes(b.intervalMinutes)) throw new DiscoveryError('invalid_input');
  await q.run('INSERT INTO discovery_settings (user_id, watch, interval_minutes) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET watch = excluded.watch, interval_minutes = excluded.interval_minutes', userId, b.watch ? 1 : 0, b.intervalMinutes as number);
  return settings(userId);
}
/** Stop (or start again) watching one project folder; its items leave the list. */
export async function setRootWatch(userId: string, id: string, watch: unknown) {
  await init();
  if (!/^(?:[a-f0-9]{32}|computer)$/.test(id) || typeof watch !== 'boolean') throw new DiscoveryError('invalid_input');
  if (watch) await q.run('DELETE FROM discovery_roots WHERE user_id = ? AND root_id = ?', userId, id);
  else await q.run('INSERT INTO discovery_roots (user_id, root_id, watch) VALUES (?, ?, 0) ON CONFLICT (user_id, root_id) DO UPDATE SET watch = 0', userId, id);
  scans.delete(userId);
  return { id, watch };
}

// ---- watching: a fresh read every N minutes for owners who keep it on (no import) ----
let timer: ReturnType<typeof setInterval> | undefined;
export async function runDueDiscoveryScans(now = Date.now()) {
  await init();
  for (const r of await q.all<{ user_id: string; interval_minutes: number }>("SELECT s.user_id, s.interval_minutes FROM discovery_settings s JOIN users u ON u.id = s.user_id WHERE s.watch = 1 AND u.role = 'owner' AND u.status = 'active'")) {
    const last = scans.get(r.user_id)?.at ?? 0;
    if (now - last >= r.interval_minutes * 60_000) await scan(r.user_id).catch(() => undefined);
  }
}
export function startDiscoveryWatch() { if (timer) return; timer = setInterval(() => { void runDueDiscoveryScans().catch(() => {}); }, 60_000); timer.unref(); }
export function stopDiscoveryWatch() { clearInterval(timer); timer = undefined; }
/** Tests: forget cached scans. */
export function resetDiscoveryCache() { scans.clear(); }
export const newOperationId = () => randomUUID();
