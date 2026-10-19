/**
 * MCP client configuration rules (M1): names, transports, URL policy,
 * launch approval hash, the dedicated working folder and limits.
 *
 * Tool names: an MCP tool is identified as `mcp:<server>:<tool>` (qualified
 * name, shown to the owner). Model APIs only accept `[A-Za-z0-9_-]{1,64}` as
 * tool names, so the registry name is `mcp__<server>__<tool>` (the tool part
 * sanitized). Server names cannot contain `_`, so the split is unambiguous.
 */

import { dataPathOr } from '../config/data-root.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isInsideDataDir } from '../tools/exec-policy.js';

export type McpTransport = 'stdio' | 'http' | 'sse';
export const MCP_TRANSPORTS: readonly McpTransport[] = ['stdio', 'http', 'sse'];

export const SERVER_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
export const MCP_TOOL_PREFIX = 'mcp__';

/** Agents that never get MCP tools (MCP-01 small agent; mirrors SMALL_AGENT_ID in services/small-agent.ts). */
export const NO_MCP_AGENTS: ReadonlySet<string> = new Set(['small-local-agent']);

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_RESULT_BYTES = 64 * 1024;
export const MAX_RESULT_BYTES = 1024 * 1024;
export const MIN_RESULT_BYTES = 1024;
export const MAX_TOOLS_PER_SERVER = 200;
export const MAX_DESCRIPTION_CHARS = 2_000;
export const MAX_ARGS = 64;
export const MAX_ARG_CHARS = 4_096;
export const MAX_COMMAND_CHARS = 1_024;
export const MAX_ENV_ENTRIES = 32;
export const MAX_SECRET_VALUE_CHARS = 8_192;
export const MAX_URL_CHARS = 2_048;

/** Headers the owner may not set (transport-managed or hop-by-hop). */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'content-type', 'accept', 'connection', 'transfer-encoding', 'mcp-session-id', 'mcp-protocol-version']);
/** Env vars the owner may not set for a stdio server (loader / interpreter hijack, server secrets). */
const RESERVED_ENV = new Set([
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'NODE_OPTIONS',
  'ENCRYPTION_KEY', 'JWT_SECRET', 'DATABASE_PATH', 'AGENT_EXEC_TOOLS', 'AGENT_PLAYER_DATA_DIR',
]);

export class McpConfigError extends Error {}

export function qualifiedToolName(server: string, tool: string): string {
  return `mcp:${server}:${tool}`;
}

/** Registry (model-facing) name, or null when it cannot be made valid (too long / empty). */
export function registryToolName(server: string, tool: string): string | null {
  const safe = String(tool).replace(/[^A-Za-z0-9_-]/g, '_');
  if (!safe || /^_+$/.test(safe)) return null;
  const name = `${MCP_TOOL_PREFIX}${server}__${safe}`;
  return name.length <= 64 ? name : null;
}

export function isMcpToolName(name: string): boolean {
  return typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX);
}

/** `mcp:<server>:<tool>` -> registry name (used by the grants API); other names unchanged. */
export function normalizeToolNameInput(name: string): string {
  const m = /^mcp:([a-z0-9-]{1,24}):(.{1,128})$/.exec(name);
  if (!m) return name;
  return registryToolName(m[1], m[2]) ?? name;
}

export function clampTimeout(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_TIMEOUT_MS;
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_TIMEOUT_MS || n > MAX_TIMEOUT_MS) {
    throw new McpConfigError(`timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  return n;
}

export function clampResultBytes(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_MAX_RESULT_BYTES;
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_RESULT_BYTES || n > MAX_RESULT_BYTES) {
    throw new McpConfigError(`maxResultBytes must be an integer between ${MIN_RESULT_BYTES} and ${MAX_RESULT_BYTES}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// URL policy (http / sse)
// ---------------------------------------------------------------------------

/** True for 127.0.0.0/8, ::1, ::ffff:127.x and the name `localhost`. */
export function isLoopbackHost(hostname: string): boolean {
  let h = hostname.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (net.isIPv4(h)) return h.split('.')[0] === '127';
  if (net.isIPv6(h)) {
    if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    return !!mapped && mapped[1].split('.')[0] === '127';
  }
  return false;
}

/**
 * Check a server URL. Loopback only, unless the owner set allowRemote for
 * this server; remote URLs must use https. No credentials in the URL.
 */
export function checkServerUrl(raw: unknown, allowRemote: boolean): URL {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URL_CHARS) throw new McpConfigError('url is required');
  let url: URL;
  try { url = new URL(raw); } catch { throw new McpConfigError('url is not a valid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new McpConfigError('url must use http or https');
  if (url.username || url.password) throw new McpConfigError('url must not contain credentials; use a secret header');
  if (!isLoopbackHost(url.hostname)) {
    if (!allowRemote) throw new McpConfigError('only loopback URLs (localhost, 127.0.0.1, ::1) are allowed unless allowRemote is set for this server');
    if (url.protocol !== 'https:') throw new McpConfigError('remote MCP servers must use https');
  }
  return url;
}

// ---------------------------------------------------------------------------
// stdio launch
// ---------------------------------------------------------------------------

export function checkCommand(command: unknown, args: unknown): { command: string; args: string[] } {
  if (typeof command !== 'string' || !command.trim() || command.length > MAX_COMMAND_CHARS || /[\u0000-\u001f]/.test(command)) {
    throw new McpConfigError('command is required');
  }
  const list = args === undefined || args === null ? [] : args;
  if (!Array.isArray(list) || list.length > MAX_ARGS) throw new McpConfigError(`args must be an array (max ${MAX_ARGS})`);
  for (const a of list) {
    if (typeof a !== 'string' || a.length > MAX_ARG_CHARS || a.includes('\u0000')) throw new McpConfigError('every arg must be a string');
  }
  return { command: command.trim(), args: list as string[] };
}

/** Owner-supplied env vars or headers: names checked, values kept for the secret store. */
export function checkSecretMap(raw: unknown, kind: 'env' | 'headers'): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new McpConfigError(`${kind} must be an object`);
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_ENV_ENTRIES) throw new McpConfigError(`${kind} allows at most ${MAX_ENV_ENTRIES} entries`);
  const safe: Array<[string, string]> = [];
  for (const [name, value] of entries) {
    if (kind === 'env') {
      if (!ENV_NAME_PATTERN.test(name)) throw new McpConfigError(`invalid env name "${name.slice(0, 64)}"`);
      if (RESERVED_ENV.has(name.toUpperCase())) throw new McpConfigError(`env "${name}" may not be set for an MCP server`);
    } else {
      if (!HEADER_NAME_PATTERN.test(name)) throw new McpConfigError(`invalid header name "${name.slice(0, 64)}"`);
      if (RESERVED_HEADERS.has(name.toLowerCase())) throw new McpConfigError(`header "${name}" is managed by the transport`);
    }
    if (typeof value !== 'string' || value.length > MAX_SECRET_VALUE_CHARS || /[\r\n\u0000]/.test(value)) {
      throw new McpConfigError(`${kind} "${name}" must be a single-line string`);
    }
    safe.push([name, value]);
  }
  return Object.fromEntries(safe);
}

/**
 * Hash of everything that decides what process a stdio server starts. An
 * owner approval is bound to it; any change needs a new approval.
 */
export function launchHash(spec: { command: string; args: string[]; envNames: string[] }): string {
  const payload = JSON.stringify({ command: spec.command, args: spec.args, envNames: [...spec.envNames].sort() });
  return createHash('sha256').update(payload).digest('hex');
}

// ---------------------------------------------------------------------------
// Dedicated working folder
// ---------------------------------------------------------------------------

/** The backend source tree (never a working directory for an MCP server). */
export function backendTreeDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function real(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Base folder for stdio MCP servers: MCP_SERVERS_DIR, else <data root>/mcp-servers or ~/.agent-player/mcp-servers. */
export function mcpServersBaseDir(): string {
  const configured = (process.env.MCP_SERVERS_DIR || '').trim();
  // RUN-ISO F1: under AGENT_PLAYER_DATA_DIR when set. That folder is a data
  // directory, so ensureServerWorkDir refuses it (fails closed) unless
  // MCP_SERVERS_DIR names a folder outside it.
  return path.resolve(configured || dataPathOr(path.join(os.homedir(), '.agent-player', 'mcp-servers'), 'mcp-servers'));
}

/**
 * Create (if needed) and return the working folder of one stdio server.
 * Refused when it would be inside the backend tree, the process working
 * directory or the data directory.
 */
export function ensureServerWorkDir(serverName: string): string {
  if (!SERVER_NAME_PATTERN.test(serverName)) throw new McpConfigError('invalid server name');
  const base = mcpServersBaseDir();
  const dir = path.join(base, serverName);
  const forbidden = [backendTreeDir(), process.cwd()].map(real);
  const check = (p: string) => {
    const r = real(p);
    if (forbidden.some((f) => inside(r, f)) || isInsideDataDir(r)) {
      throw new McpConfigError('the MCP server folder must be outside the backend tree and the data directory (set MCP_SERVERS_DIR)');
    }
  };
  check(base);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new McpConfigError('the MCP server folder is not a directory');
  check(dir);
  return real(dir);
}
