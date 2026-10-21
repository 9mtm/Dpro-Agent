/**
 * Registering the dpro-memory MCP server in a CLI's own config file
 * (MEM-BRIDGE-01). Three steps, each one an owner action:
 *
 *   preview   the exact new file text (and a diff of the server entry); nothing written
 *   apply     only with the preview hash and confirm: the original file is copied
 *             first (0600, Dpro data folder), then the new text replaces it atomically
 *   undo      restores the backup byte for byte when the file is still exactly what
 *             Dpro wrote; if the CLI changed the file since, only Dpro's entry is
 *             taken out and everything else the CLI wrote stays
 *
 * Formats (official docs, 2026-10-21): JSON `mcpServers` for Claude Code
 * (~/.claude.json, user scope, `type: "stdio"`), Gemini CLI (settings.json)
 * and Antigravity (mcp_config.json); TOML `[mcp_servers.<name>]` for Codex.
 * The TOML table goes between Dpro's comment markers so undo can find it.
 * No token or secret is ever written: the server fetches its own token from
 * the backend at start (auth.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dataPath } from '../../config/data-root.js';
import { CLIENT_NAMES, clientConfigFile, launchReady, SERVER_NAME, serverLaunch, type BridgeClient, type BridgeEnv, type ServerLaunch } from './clients.js';
import { addRegistration, getRegistration, markUndone, type Registration } from './store.js';

export class RegistrationError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'invalid_request') { super(message); }
}

const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const TOML_START = `# >>> ${SERVER_NAME} (managed by Dpro; Dpro's undo removes this block)`;
const TOML_END = `# <<< ${SERVER_NAME}`;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export interface RegistrationPreview {
  client: BridgeClient;
  name: string;
  configPath: string;
  action: 'create' | 'update' | 'unchanged' | 'conflict';
  reason?: string;
  /** The server entry Dpro adds (no secret in it). */
  entry: Record<string, unknown>;
  /** Server entry before (-) and after (+). */
  diff: string;
  beforeSha256: string | null;
  afterSha256: string | null;
  previewHash: string;
  warnings: string[];
}

function readConfig(file: string): { bytes: Buffer | null; mode: number | null; problem?: string } {
  let st: fs.Stats;
  try { st = fs.lstatSync(file); } catch (e: any) { return e.code === 'ENOENT' ? { bytes: null, mode: null } : { bytes: null, mode: null, problem: 'cannot be read' }; }
  if (st.isSymbolicLink()) return { bytes: null, mode: null, problem: 'is a symbolic link' };
  if (!st.isFile()) return { bytes: null, mode: null, problem: 'is not a regular file' };
  if (st.size > MAX_CONFIG_BYTES) return { bytes: null, mode: null, problem: 'is too large' };
  return { bytes: fs.readFileSync(file), mode: st.mode & 0o777 };
}

function jsonEntry(client: BridgeClient, l: ServerLaunch): Record<string, unknown> {
  if (client === 'claude-code') return { type: 'stdio', command: l.command, args: l.args, env: l.env };
  if (client === 'gemini-cli') return { command: l.command, args: l.args, env: l.env, timeout: 30000, trust: false };
  return { command: l.command, args: l.args, env: l.env };
}

const indentOf = (text: string): string | number => { const m = text.match(/^\{\s*\n([ \t]+)"/); return m ? m[1] : 2; };

function jsonPlan(text: string | null, entry: Record<string, unknown>): { after: string; before: unknown } {
  let obj: any = {};
  if (text !== null && text.trim()) {
    try { obj = JSON.parse(text); } catch { throw new RegistrationError('The config file is not plain JSON (comments or a syntax error); add the server by hand or fix the file first', 409, 'config_unparsable'); }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new RegistrationError('The config file is not a JSON object', 409, 'config_unparsable');
  }
  const servers = obj.mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) throw new RegistrationError('"mcpServers" in the config file is not an object', 409, 'config_unparsable');
  const before = servers?.[SERVER_NAME];
  const next = { ...obj, mcpServers: { ...(servers ?? {}), [SERVER_NAME]: entry } };
  const after = JSON.stringify(next, null, text ? indentOf(text) : 2) + (text === null || text.endsWith('\n') ? '\n' : '');
  return { after, before };
}

const tomlString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;

export function tomlBlock(l: ServerLaunch): string {
  return [TOML_START, `[mcp_servers.${SERVER_NAME}]`, `command = ${tomlString(l.command)}`, `args = [${l.args.map(tomlString).join(', ')}]`, 'startup_timeout_sec = 20', '',
    `[mcp_servers.${SERVER_NAME}.env]`, ...Object.entries(l.env).map(([k, v]) => `${k} = ${tomlString(v)}`), TOML_END].join('\n');
}

function tomlRange(text: string): { start: number; end: number } | null {
  const s = text.indexOf(TOML_START), e = text.indexOf(TOML_END);
  if (s < 0 && e < 0) return null;
  if (s < 0 || e < s || text.indexOf(TOML_START, s + 1) >= 0) throw new RegistrationError(`Dpro's markers in the Codex config are broken; remove the ${SERVER_NAME} block by hand`, 409, 'markers_broken');
  return { start: s, end: e + TOML_END.length };
}

function tomlPlan(text: string | null, l: ServerLaunch): { after: string; before: string | null } {
  const cur = text ?? '';
  const block = tomlBlock(l);
  const range = tomlRange(cur);
  if (range) return { after: cur.slice(0, range.start) + block + cur.slice(range.end), before: cur.slice(range.start, range.end) };
  const outside = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${SERVER_NAME}"|'${SERVER_NAME}'|${SERVER_NAME})\\s*[\\].]`, 'm');
  if (outside.test(cur)) throw new RegistrationError(`The Codex config already has its own "${SERVER_NAME}" server; remove or rename it first`, 409, 'name_taken');
  return { after: `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${cur ? '\n' : ''}${block}\n`, before: null };
}

const linesOf = (prefix: string, v: unknown) => (v === undefined || v === null ? [] : (typeof v === 'string' ? v : JSON.stringify(v, null, 2)).split('\n').map((x) => `${prefix}${x}`));

type Plan = RegistrationPreview & { after: string | null };

/**
 * The exact change for one CLI; nothing is written. The whole new file text
 * stays on the server (a CLI config can hold other servers' keys); the
 * preview shows the server entry and the hashes of the file before/after.
 */
export function previewRegistration(client: BridgeClient, where: BridgeEnv = {}, launch?: ServerLaunch): RegistrationPreview {
  const { after: _, ...p } = planRegistration(client, where, launch);
  return p;
}

function planRegistration(client: BridgeClient, where: BridgeEnv = {}, launch: ServerLaunch = serverLaunch(client)): Plan {
  const configPath = clientConfigFile(client, where);
  const warnings: string[] = [];
  if (!launchReady(launch)) warnings.push('The dpro-memory server entry file was not found in this install; build the backend first.');
  const entry = client === 'codex' ? { command: launch.command, args: launch.args, env: launch.env, startup_timeout_sec: 20 } : jsonEntry(client, launch);
  const base = { client, name: CLIENT_NAMES[client], configPath, entry, warnings };
  const cur = readConfig(configPath);
  const conflict = (reason: string): Plan => ({ ...base, action: 'conflict', reason, diff: '', after: null, beforeSha256: cur.bytes ? sha(cur.bytes) : null, afterSha256: null, previewHash: sha(JSON.stringify([client, configPath, 'conflict', reason])) });
  if (cur.problem) return conflict(`${configPath} ${cur.problem}`);
  const text = cur.bytes === null ? null : cur.bytes.toString('utf8');
  let after: string; let before: unknown;
  try {
    ({ after, before } = client === 'codex' ? tomlPlan(text, launch) : jsonPlan(text, entry));
  } catch (err) {
    if (err instanceof RegistrationError) return conflict(err.message);
    throw err;
  }
  const beforeSha256 = cur.bytes ? sha(cur.bytes) : null;
  const afterSha256 = sha(after);
  const action = text === null ? 'create' : beforeSha256 === afterSha256 ? 'unchanged' : 'update';
  const diff = action === 'unchanged' ? '' : [...linesOf('-', before), ...linesOf('+', client === 'codex' ? tomlBlock(launch) : entry)].join('\n');
  return { ...base, action, diff, after, beforeSha256, afterSha256, previewHash: sha(JSON.stringify([client, configPath, beforeSha256, afterSha256])) };
}

function backupDir(): string {
  const dir = dataPath('memory-bridge', 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function writeAtomic(file: string, data: Buffer | string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  fs.writeFileSync(tmp, data, { flag: 'wx', mode });
  try { fs.chmodSync(tmp, mode); fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

/** Writes the previewed change after the owner's confirm; the original is backed up first. */
export async function applyRegistration(ownerId: string, client: BridgeClient, input: { previewHash?: unknown; confirm?: unknown }, where: BridgeEnv = {}, launch?: ServerLaunch): Promise<{ registration: Registration | null; preview: RegistrationPreview }> {
  if (input.confirm !== true) throw new RegistrationError('Send confirm: true after reviewing the preview', 400, 'confirm_required');
  const { after, ...p } = planRegistration(client, where, launch);
  if (typeof input.previewHash !== 'string' || input.previewHash !== p.previewHash) throw new RegistrationError('The config file changed since the preview; preview again', 409, 'preview_stale');
  if (p.action === 'conflict') throw new RegistrationError(p.reason ?? 'conflict', 409, 'conflict');
  if (p.action === 'unchanged') return { registration: null, preview: p };
  const cur = readConfig(p.configPath);
  if ((cur.bytes ? sha(cur.bytes) : null) !== p.beforeSha256) throw new RegistrationError('The config file changed since the preview; preview again', 409, 'preview_stale');
  let backupPath: string | null = null;
  if (cur.bytes) {
    backupPath = path.join(backupDir(), `${client}-${Date.now()}-${randomUUID().slice(0, 8)}.bak`);
    fs.writeFileSync(backupPath, cur.bytes, { flag: 'wx', mode: 0o600 });
  }
  writeAtomic(p.configPath, after!, cur.mode ?? 0o600);
  const registration = await addRegistration(ownerId, { client, configPath: p.configPath, backupPath, existed: cur.bytes !== null, beforeSha256: p.beforeSha256, afterSha256: p.afterSha256! });
  return { registration, preview: p };
}

/** Only Dpro's entry taken out of the current text (the CLI changed the file after Dpro wrote it). */
function withoutEntry(client: BridgeClient, text: string): string {
  if (client === 'codex') {
    const r = tomlRange(text);
    if (!r) return text;
    let start = r.start, end = r.end;
    if (text[end] === '\n') end++;
    if (start >= 2 && text.slice(start - 2, start) === '\n\n') start--;
    return text.slice(0, start) + text.slice(end);
  }
  let obj: any;
  try { obj = JSON.parse(text); } catch { throw new RegistrationError('The config file is no longer plain JSON; remove the dpro-memory entry by hand', 409, 'config_unparsable'); }
  if (!obj?.mcpServers || !(SERVER_NAME in obj.mcpServers)) return text;
  const { [SERVER_NAME]: _, ...rest } = obj.mcpServers;
  const next = { ...obj, mcpServers: rest };
  if (!Object.keys(rest).length) delete next.mcpServers;
  return JSON.stringify(next, null, indentOf(text)) + (text.endsWith('\n') ? '\n' : '');
}

export interface UndoResult { registration: Registration; mode: 'restored' | 'entry-removed' | 'already-gone' }

/** Undo an applied registration. */
export async function undoRegistration(ownerId: string, id: string): Promise<UndoResult> {
  const reg = await getRegistration(ownerId, id);
  if (!reg) throw new RegistrationError('Not found', 404, 'not_found');
  if (reg.status === 'undone') throw new RegistrationError('This registration was already undone', 409, 'already_undone');
  const cur = readConfig(reg.configPath);
  if (cur.problem) throw new RegistrationError(`${reg.configPath} ${cur.problem}`, 409, 'conflict');
  let mode: UndoResult['mode'];
  if (cur.bytes && sha(cur.bytes) === reg.afterSha256) {
    if (reg.existed) {
      if (!reg.backupPath) throw new RegistrationError('The backup is missing', 409, 'backup_missing');
      const backup = fs.readFileSync(reg.backupPath);
      if (reg.beforeSha256 && sha(backup) !== reg.beforeSha256) throw new RegistrationError('The backup does not match the original; nothing restored', 409, 'backup_changed');
      writeAtomic(reg.configPath, backup, cur.mode ?? 0o600);
    } else {
      fs.rmSync(reg.configPath);
    }
    mode = 'restored';
  } else if (cur.bytes) {
    const text = cur.bytes.toString('utf8');
    const next = withoutEntry(reg.client, text);
    if (next === text) mode = 'already-gone';
    else { writeAtomic(reg.configPath, next, cur.mode ?? 0o600); mode = 'entry-removed'; }
  } else {
    mode = 'already-gone';
  }
  await markUndone(ownerId, id);
  return { registration: (await getRegistration(ownerId, id))!, mode };
}
