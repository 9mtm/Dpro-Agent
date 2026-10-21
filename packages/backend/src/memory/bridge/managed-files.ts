/**
 * Managed memory files in a project folder (MEM-BRIDGE-01, the fallback for
 * agents that do not use the MCP server):
 *
 *   AGENTS.md   the canonical brief (Codex and Antigravity read it; Claude Code
 *               and Gemini CLI through the adapters)
 *   CLAUDE.md   thin adapter: `@AGENTS.md` (Claude Code import syntax)
 *   GEMINI.md   thin adapter: `@./AGENTS.md` (Gemini CLI import syntax)
 *
 * Dpro writes ONLY between its two markers. Text outside them is the owner's
 * (or another agent's) and is kept byte for byte; a file without markers gets
 * the section appended. Broken markers (one missing, or more than one pair),
 * a symlink or an oversized file is a conflict: nothing is written to that
 * folder. Every write goes through a dry-run preview first; the apply call
 * carries the preview hash, so a file that changed in between is refused.
 * The brief is redacted (brief.ts) and checked again here: a block that
 * still holds anything the secret scan finds is never written.
 * Files Dpro creates are listed in `.git/info/exclude` (inside its own
 * markers) unless the owner turns that off.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { redactImportText } from '../import/redact.js';
import { briefMarkdown, type ProjectBrief } from './brief.js';
import { SERVER_NAME } from './clients.js';

export const MARK_START = '<!-- dpro-memory:start — managed by Dpro: the text between these two markers is replaced on every sync; write your own notes outside them -->';
export const MARK_END = '<!-- dpro-memory:end -->';
const START_RE = /<!-- dpro-memory:start\b[^\n]*?-->/g;
const END_RE = /<!-- dpro-memory:end -->/g;
const GIT_START = '# dpro-memory:start (managed by Dpro)';
const GIT_END = '# dpro-memory:end';
export const MAX_MANAGED_FILE_BYTES = 1024 * 1024;
export const MANAGED_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'] as const;
export type ManagedName = (typeof MANAGED_FILES)[number];

export class ManagedFileError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'invalid_request') { super(message); }
}

type Split = { before: string; inside: string; after: string };
/** A pair of Dpro markers: the memory section here, the design section in DESIGN.md (DESIGN-FIND-01). */
export interface Marks { start: string; end: string; startRe: RegExp; endRe: RegExp }
const MEMORY_MARKS: Marks = { start: MARK_START, end: MARK_END, startRe: START_RE, endRe: END_RE };

/** The text around Dpro's section; null when there is none, 'broken' when the markers are not exactly one ordered pair. */
export function splitManaged(text: string, marks: Marks = MEMORY_MARKS): Split | null | 'broken' {
  const starts = [...text.matchAll(marks.startRe)];
  const ends = [...text.matchAll(marks.endRe)];
  if (!starts.length && !ends.length) return null;
  if (starts.length !== 1 || ends.length !== 1) return 'broken';
  const s = starts[0], e = ends[0];
  if (e.index! < s.index!) return 'broken';
  return { before: text.slice(0, s.index!), inside: text.slice(s.index! + s[0].length, e.index!), after: text.slice(e.index! + e[0].length) };
}

/** `text` with Dpro's section set to `block`; outside text unchanged. */
export function replaceManaged(text: string, block: string, marks: Marks = MEMORY_MARKS): string {
  const section = `${marks.start}\n${block.trim()}\n${marks.end}`;
  const split = splitManaged(text, marks);
  if (split === 'broken') throw new ManagedFileError('The Dpro markers in this file are broken', 409, 'markers_broken');
  if (split) return split.before + section + split.after;
  if (!text) return `${section}\n`;
  return `${text}${text.endsWith('\n') ? '' : '\n'}\n${section}\n`;
}

/** The owner's own text: everything outside Dpro's section. */
export function outsideManaged(text: string): string {
  const split = splitManaged(text);
  if (!split || split === 'broken') return text;
  return `${split.before}${split.after}`;
}

export function adapterBlock(name: ManagedName): string {
  if (name === 'CLAUDE.md') return `@AGENTS.md\n\nThe Dpro project memory for this folder is in AGENTS.md (imported above). Live tools: the \`${SERVER_NAME}\` MCP server.`;
  return `@./AGENTS.md\n\nThe Dpro project memory for this folder is in AGENTS.md (imported above). Live tools: the \`${SERVER_NAME}\` MCP server.`;
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export interface FilePlan {
  name: string;
  /** Path relative to the project folder. */
  relative: string;
  action: 'create' | 'update' | 'unchanged' | 'conflict';
  reason?: string;
  beforeSha256: string | null;
  afterSha256: string | null;
  /** Dpro's section before (-) and after (+); outside text is never part of a change. */
  diff: string;
}
export interface FilesPreview { projectId: string; folder: string; files: FilePlan[]; previewHash: string; conflicts: number; changes: number }
type Planned = FilePlan & { abs: string; after: string | null; mode: number | null };

function readExisting(abs: string): { text: string | null; mode: number | null; problem?: string } {
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch (e: any) { if (e.code === 'ENOENT') return { text: null, mode: null }; return { text: null, mode: null, problem: 'unreadable' }; }
  if (st.isSymbolicLink()) return { text: null, mode: null, problem: 'is a symbolic link' };
  if (!st.isFile()) return { text: null, mode: null, problem: 'is not a regular file' };
  if (st.size > MAX_MANAGED_FILE_BYTES) return { text: null, mode: null, problem: 'is larger than 1 MiB' };
  const text = fs.readFileSync(abs, 'utf8');
  if (text.includes('\0')) return { text: null, mode: null, problem: 'is not a text file' };
  return { text, mode: st.mode & 0o777 };
}

function blockDiff(oldBlock: string | null, newBlock: string): string {
  const out: string[] = [];
  if (oldBlock !== null) for (const l of oldBlock.trim().split('\n')) out.push(`-${l}`);
  for (const l of newBlock.trim().split('\n')) out.push(`+${l}`);
  return out.join('\n');
}

function planFile(folder: string, relative: string, block: string): Planned {
  const abs = path.join(folder, relative);
  const cur = readExisting(abs);
  const base = { name: path.basename(relative), relative, abs, mode: cur.mode };
  if (cur.problem) return { ...base, action: 'conflict', reason: `${relative} ${cur.problem}`, beforeSha256: null, afterSha256: null, diff: '', after: null };
  const split = cur.text === null ? null : splitManaged(cur.text);
  if (split === 'broken') return { ...base, action: 'conflict', reason: `${relative} has broken Dpro markers; fix or remove them by hand`, beforeSha256: sha(cur.text!), afterSha256: null, diff: '', after: null };
  const after = replaceManaged(cur.text ?? '', block);
  const before = cur.text;
  const action = before === null ? 'create' : before === after ? 'unchanged' : 'update';
  return { ...base, action, beforeSha256: before === null ? null : sha(before), afterSha256: sha(after), diff: action === 'unchanged' ? '' : blockDiff(split ? split.inside : null, block), after };
}

/** `.git/info/exclude` with Dpro's list of files it created (only when the folder is a git work tree). */
function planGitExclude(folder: string, created: string[]): Planned | null {
  const gitDir = path.join(folder, '.git');
  try { if (!fs.lstatSync(gitDir).isDirectory()) return null; } catch { return null; }
  const relative = path.join('.git', 'info', 'exclude');
  const abs = path.join(folder, relative);
  const cur = readExisting(abs);
  const base = { name: 'exclude', relative, abs, mode: cur.mode };
  if (cur.problem) return { ...base, action: 'conflict', reason: `${relative} ${cur.problem}`, beforeSha256: null, afterSha256: null, diff: '', after: null };
  const text = cur.text ?? '';
  const s = text.indexOf(GIT_START), e = text.indexOf(GIT_END);
  const listed = s >= 0 && e > s ? text.slice(s + GIT_START.length, e).split('\n').map((l) => l.trim()).filter(Boolean) : [];
  const names = [...new Set([...listed, ...created.map((c) => `/${c}`)])].sort();
  if (!created.length || created.every((c) => listed.includes(`/${c}`))) return null;
  const section = `${GIT_START}\n${names.join('\n')}\n${GIT_END}`;
  const after = s >= 0 && e > s ? text.slice(0, s) + section + text.slice(e + GIT_END.length) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${section}\n`;
  return { ...base, action: cur.text === null ? 'create' : 'update', beforeSha256: cur.text === null ? null : sha(cur.text), afterSha256: sha(after), diff: names.map((n) => `${listed.includes(n) ? ' ' : '+'}${n}`).join('\n'), after };
}

function checkFolder(folder: string | null): string {
  if (!folder) throw new ManagedFileError('This project has no folder', 400, 'no_folder');
  let real: string;
  try { real = fs.realpathSync.native(folder); } catch { throw new ManagedFileError('The project folder does not exist', 404, 'folder_missing'); }
  if (!fs.statSync(real).isDirectory()) throw new ManagedFileError('The project folder is not a folder', 400, 'no_folder');
  return real;
}

/** A managed block must hold nothing the secret scan finds (brief.ts already redacted it). */
function assertNoSecret(block: string): void {
  const r = redactImportText(block);
  if (Object.values(r.counts).some((n) => Number(n) > 0)) throw new ManagedFileError('The brief still contains something that looks like a secret; nothing was written', 422, 'secret_found');
}

function plan(brief: ProjectBrief, folderRaw: string | null, gitExclude: boolean): { folder: string; files: Planned[] } {
  const folder = checkFolder(folderRaw);
  const canonical = briefMarkdown(brief);
  assertNoSecret(canonical);
  const files: Planned[] = MANAGED_FILES.map((name) => planFile(folder, name, name === 'AGENTS.md' ? canonical : adapterBlock(name)));
  if (gitExclude) {
    const g = planGitExclude(folder, files.filter((f) => f.action === 'create').map((f) => f.relative));
    if (g) files.push(g);
  }
  return { folder, files };
}

const hashOf = (folder: string, files: FilePlan[]) => sha(JSON.stringify([folder, files.map((f) => [f.relative, f.action, f.beforeSha256, f.afterSha256])]));
const visible = ({ abs: _a, after: _b, mode: _m, ...f }: Planned): FilePlan => f;

/** Dry run: what the folder's files would look like (nothing is written). */
export function previewFiles(projectId: string, brief: ProjectBrief, folder: string | null, gitExclude = true): FilesPreview {
  const p = plan(brief, folder, gitExclude);
  const files = p.files.map(visible);
  return { projectId, folder: p.folder, files, previewHash: hashOf(p.folder, files), conflicts: files.filter((f) => f.action === 'conflict').length, changes: files.filter((f) => f.action === 'create' || f.action === 'update').length };
}

function writeAtomic(abs: string, text: string, mode: number | null): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomUUID()}.tmp`);
  fs.writeFileSync(tmp, text, { flag: 'wx', mode: mode ?? 0o644 });
  try { if (mode !== null) fs.chmodSync(tmp, mode); fs.renameSync(tmp, abs); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

/**
 * Writes the planned files. `expectedHash` = the preview the owner saw, or
 * null for a regeneration of an already confirmed folder (still all-or-nothing:
 * any conflict writes nothing).
 */
export function applyFiles(projectId: string, brief: ProjectBrief, folder: string | null, gitExclude: boolean, expectedHash: string | null): FilesPreview {
  const p = plan(brief, folder, gitExclude);
  const files = p.files.map(visible);
  const hash = hashOf(p.folder, files);
  if (expectedHash !== null && hash !== expectedHash) throw new ManagedFileError('The files or the memory changed since the preview; preview again', 409, 'preview_stale');
  const conflicts = p.files.filter((f) => f.action === 'conflict');
  if (conflicts.length) throw new ManagedFileError(`Nothing written: ${conflicts.map((c) => c.reason).join('; ')}`, 409, 'conflict');
  for (const f of p.files) if ((f.action === 'create' || f.action === 'update') && f.after !== null) writeAtomic(f.abs, f.after, f.mode);
  return { projectId, folder: p.folder, files, previewHash: hash, conflicts: 0, changes: files.filter((f) => f.action === 'create' || f.action === 'update').length };
}

/**
 * Write one Dpro section into one file (DESIGN-FIND-01: DESIGN.md), between
 * `marks`: the same rules as the managed memory files (outside text kept byte
 * for byte, a symlink / non-text / oversized file or broken markers = conflict,
 * nothing written) and the same secret check. Atomic.
 */
export function writeSection(folderRaw: string | null, relative: string, block: string, marks: Marks): { action: 'create' | 'update' | 'unchanged'; file: string } {
  const folder = checkFolder(folderRaw);
  assertNoSecret(block);
  const abs = path.join(folder, relative);
  const cur = readExisting(abs);
  if (cur.problem) throw new ManagedFileError(`${relative} ${cur.problem}`, 409, 'conflict');
  if (cur.text !== null && splitManaged(cur.text, marks) === 'broken') throw new ManagedFileError(`${relative} has broken Dpro markers; fix or remove them by hand`, 409, 'markers_broken');
  const after = replaceManaged(cur.text ?? '', block, marks);
  if (cur.text === after) return { action: 'unchanged', file: abs };
  writeAtomic(abs, after, cur.mode);
  return { action: cur.text === null ? 'create' : 'update', file: abs };
}
