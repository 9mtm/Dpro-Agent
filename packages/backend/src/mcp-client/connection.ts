/**
 * MCP connections (M1), built on the official @modelcontextprotocol/sdk.
 *
 *  - stdio: the owner's command runs only when the server env enables exec
 *    tools (AGENT_EXEC_TOOLS=true) and the owner approved exactly this
 *    command/args/env names. The child gets minimalChildEnv() plus only the
 *    env vars the owner listed, and runs in its own folder outside the
 *    backend tree and the data directory. Its stderr is drained, not logged.
 *  - http / sse: loopback URLs only unless the owner set allowRemote for the
 *    server. Every request (incl. any later one) is re-checked against that
 *    rule and redirects are never followed.
 *
 * One live connection per server, closed after an idle period or when the
 * server is changed, disabled or deleted. Errors are mapped to short, clean
 * codes; raw messages (which may hold paths, stack traces or secrets) are
 * never returned to a model.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';
import { isExecToolsEnabled, minimalChildEnv } from '../tools/exec-policy.js';
import { checkServerUrl, ensureServerWorkDir, isLoopbackHost, MAX_TOOLS_PER_SERVER, McpConfigError } from './config.js';
import { isLaunchApproved, parseList, readSecrets, type McpSecrets, type McpServerRow } from './store.js';

const CLIENT_INFO = { name: 'agent-player', version: '1.3.0' };
const IDLE_CLOSE_MS = 5 * 60_000;
const MAX_LIST_PAGES = 10;

export type McpErrorCode =
  | 'timeout' | 'unavailable' | 'invalid_arguments' | 'unknown_tool'
  | 'server_error' | 'not_allowed' | 'protocol_error';

export class McpCallError extends Error {
  constructor(readonly code: McpErrorCode, message: string) { super(message); }
}

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;
let fetchOverride: FetchLike | null = null;

/** Test hook: route http/sse requests to an in-process fake instead of the network. */
export function __setMcpFetchForTests(fn: FetchLike | null): void {
  fetchOverride = fn;
}

/** fetch that refuses non-loopback hosts (unless allowed) and never follows redirects. */
function guardedFetch(allowRemote: boolean): FetchLike {
  return async (url, init) => {
    const target = new URL(typeof url === 'string' ? url : url.toString());
    if (!isLoopbackHost(target.hostname) && (!allowRemote || target.protocol !== 'https:')) {
      throw new McpCallError('not_allowed', 'request to a host this MCP server may not reach');
    }
    const impl = fetchOverride ?? fetch;
    const res = await impl(target, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) throw new McpCallError('not_allowed', 'the MCP server answered with a redirect, which is not followed');
    return res;
  };
}

/** Map any error to a clean code + message (no raw text from the server or OS). */
export function mapMcpError(err: unknown, timeoutMs: number): McpCallError {
  if (err instanceof McpCallError) return err;
  if (err instanceof McpConfigError) return new McpCallError('not_allowed', err.message);
  if (err instanceof McpError) {
    switch (err.code) {
      case ErrorCode.RequestTimeout: return new McpCallError('timeout', `the MCP server did not answer within ${Math.round(timeoutMs / 1000)} s`);
      case ErrorCode.InvalidParams: return new McpCallError('invalid_arguments', 'the MCP server rejected the arguments');
      case ErrorCode.MethodNotFound: return new McpCallError('unknown_tool', 'the MCP server does not offer this tool or method');
      case ErrorCode.ConnectionClosed: return new McpCallError('unavailable', 'the connection to the MCP server closed');
      default: return new McpCallError('server_error', 'the MCP server returned an error');
    }
  }
  const code = (err as any)?.code;
  if (typeof code === 'string' && /^(ENOENT|EACCES|ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT)$/.test(code)) {
    return new McpCallError('unavailable', 'the MCP server could not be reached or started');
  }
  if ((err as any)?.name === 'AbortError') return new McpCallError('timeout', `the MCP server did not answer within ${Math.round(timeoutMs / 1000)} s`);
  return new McpCallError('unavailable', 'the MCP server could not be reached');
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new McpCallError('timeout', `the MCP server did not answer within ${Math.round(ms / 1000)} s`));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Connection pool
// ---------------------------------------------------------------------------

interface Live {
  key: string;
  client: Promise<Client>;
  idle?: NodeJS.Timeout;
  connected?: boolean;
}

const live = new Map<string, Live>();

function connectionKey(row: McpServerRow, secrets: McpSecrets): string {
  return createHash('sha256').update(JSON.stringify({
    t: row.transport, c: row.command, a: row.args, u: row.url, r: row.allow_remote,
    h: row.approved_launch_hash, s: secrets,
  })).digest('hex');
}

async function openClient(row: McpServerRow, secrets: McpSecrets): Promise<Client> {
  const startupTimeout = row.startup_timeout_ms ?? row.timeout_ms;
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  if (row.transport === 'stdio') {
    if (!isExecToolsEnabled()) throw new McpCallError('not_allowed', 'stdio MCP servers need AGENT_EXEC_TOOLS=true in the server environment');
    if (!isLaunchApproved(row)) throw new McpCallError('not_allowed', 'the owner has not approved this server launch');
    const cwd = ensureServerWorkDir(row.name);
    const env = minimalChildEnv(secrets.env) as Record<string, string>;
    const transport = new StdioClientTransport({ command: row.command!, args: parseList(row.args), env, cwd, stderr: 'pipe' });
    transport.stderr?.on('data', () => { /* drained, not logged: may hold secrets */ });
    await withTimeout(client.connect(transport, { timeout: startupTimeout }), startupTimeout, () => { void transport.close().catch(() => {}); });
    return client;
  }
  const allowRemote = row.allow_remote === 1;
  const url = checkServerUrl(row.url, allowRemote);
  const headers = { ...secrets.headers };
  const guarded = guardedFetch(allowRemote);
  const transport = row.transport === 'http'
    ? new StreamableHTTPClientTransport(url, { fetch: guarded, requestInit: { headers } })
    : new SSEClientTransport(url, {
      fetch: guarded,
      requestInit: { headers },
      eventSourceInit: { fetch: (u: string | URL, init?: RequestInit) => guarded(u, { ...init, headers: { ...(init?.headers as any), ...headers } }) } as any,
    });
  await withTimeout(client.connect(transport, { timeout: startupTimeout }), startupTimeout, () => { void transport.close().catch(() => {}); });
  return client;
}

function touch(id: string, entry: Live): void {
  if (entry.idle) clearTimeout(entry.idle);
  entry.idle = setTimeout(() => { void closeConnection(id); }, IDLE_CLOSE_MS);
  entry.idle.unref?.();
}

async function getClient(row: McpServerRow): Promise<Client> {
  const secrets = await readSecrets(row);
  const key = connectionKey(row, secrets);
  const existing = live.get(row.id);
  if (existing && existing.key === key) {
    touch(row.id, existing);
    return existing.client;
  }
  if (existing) await closeConnection(row.id);
  const entry: Live = { key, client: openClient(row, secrets) };
  live.set(row.id, entry);
  entry.client.then((c) => {
    entry.connected = true;
    c.onclose = () => { if (live.get(row.id) === entry) live.delete(row.id); };
  }, () => { if (live.get(row.id) === entry) live.delete(row.id); });
  touch(row.id, entry);
  return entry.client;
}

export function connectionState(serverId:string):'connected'|'connecting'|'disconnected'{const entry=live.get(serverId);return !entry?'disconnected':entry.connected?'connected':'connecting';}

export async function closeConnection(serverId: string): Promise<void> {
  const entry = live.get(serverId);
  if (!entry) return;
  live.delete(serverId);
  if (entry.idle) clearTimeout(entry.idle);
  try { await (await entry.client).close(); } catch { /* already gone */ }
}

export async function closeAllConnections(): Promise<void> {
  await Promise.all([...live.keys()].map((id) => closeConnection(id)));
}

/** The secret values of a server (to scrub them from tool output). */
export async function serverSecretValues(row: McpServerRow): Promise<string[]> {
  try {
    const s = await readSecrets(row);
    return [...Object.values(s.env), ...Object.values(s.headers)].filter((v) => typeof v === 'string' && v.length >= 4);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface RawTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
}

/** tools/list (all pages, bounded). */
export async function listServerTools(row: McpServerRow): Promise<{ tools: RawTool[]; truncated: boolean }> {
  try {
    const client = await getClient(row);
    const tools: RawTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const res = await withTimeout(client.listTools(cursor ? { cursor } : undefined, { timeout: row.timeout_ms }), row.timeout_ms);
      for (const t of res.tools ?? []) {
        tools.push(t as RawTool);
        if (tools.length > MAX_TOOLS_PER_SERVER) return { tools: tools.slice(0, MAX_TOOLS_PER_SERVER), truncated: true };
      }
      cursor = typeof res.nextCursor === 'string' && res.nextCursor ? res.nextCursor : undefined;
      if (!cursor) break;
    }
    return { tools, truncated: !!cursor };
  } catch (err) {
    await closeConnection(row.id);
    throw mapMcpError(err, row.timeout_ms);
  }
}

export interface RawCallResult {
  content?: Array<Record<string, any>>;
  structuredContent?: unknown;
  isError?: boolean;
}

/** tools/call with the server's timeout (default 30 s, max 120 s). */
export async function callServerTool(row: McpServerRow, toolName: string, args: Record<string, unknown>): Promise<RawCallResult> {
  const controller = new AbortController();
  try {
    const client = await getClient(row);
    const res = await withTimeout(
      client.callTool({ name: toolName, arguments: args }, undefined, { timeout: row.timeout_ms, signal: controller.signal }),
      row.timeout_ms,
      () => controller.abort(),
    );
    return res as RawCallResult;
  } catch (err) {
    const mapped = mapMcpError(err, row.timeout_ms);
    if (mapped.code === 'unavailable' || mapped.code === 'protocol_error') await closeConnection(row.id);
    throw mapped;
  }
}
