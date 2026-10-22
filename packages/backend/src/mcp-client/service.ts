/**
 * Owner operations on MCP servers (M1): add, change, enable (with launch
 * approval for stdio), disable, refresh discovery, per-tool approval
 * setting, delete. Used by the owner-only routes in api/routes/mcp-servers.ts.
 *
 * B2.2c: mcp_servers / mcp_server_tools are on the process driver (SQL
 * steps). Each change is one transaction together with the grants and
 * bindings it revokes (agent_tool_grants / mcp_grant_bindings, same
 * driver), so on PostgreSQL a target change, a delete or a refresh never
 * leaves grants for tools that are gone, and a refresh never stores tools
 * of a server generation that changed meanwhile. Writes that follow a read
 * lock the server row (FOR UPDATE on PostgreSQL) and check that it is still
 * the row the change was computed from (409 conflict otherwise). Secret
 * values (credential manager, async) are written before the transaction;
 * audit rows are written after it.
 */

import { randomUUID } from 'node:crypto';
import { isExecToolsEnabled, EXEC_TOOLS_ENV_FLAG } from '../tools/exec-policy.js';
import {
  checkCommand, checkSecretMap, checkServerUrl, clampResultBytes, clampTimeout, launchHash, MAX_DESCRIPTION_CHARS,
  McpConfigError, MCP_TRANSPORTS, registryToolName, SERVER_NAME_PATTERN, type McpTransport,
} from './config.js';
import { closeConnection, listServerTools } from './connection.js';
import { sanitizeInputSchema, SchemaError } from './schema.js';
import {
  deleteSecrets, getServerRow, getServerRowByNameStep, getServerRowStep, isLaunchApproved, listServerRowsStep, listToolRowsStep,
  parseList, serverView, serverViewStep, writeSecrets, type McpServerRow, type McpServerView,
} from './store.js';
import { invalidateMcpTools } from './tools.js';
import { grantedNamesWithPrefixStep, revokeMcpGrantsStep, toolFingerprint, type RevokedGrant } from './grant-binding.js';
import { dialect, one, run, sql, type Step } from '../repositories/sql-steps.js';
import { forUpdate, isParam, nowText } from '../db/pg/dialect.js';
import { logAudit } from '../services/audit-logger.js';
import { MCP_TOOL_PREFIX } from './config.js';

/**
 * Remove MCP grants that no longer match a server's tools and audit it
 * (stale-authorization guard: a re-created server, a changed target or a
 * changed/vanished tool never inherits an old grant). The grants are revoked
 * inside the change's transaction (revokeMcpGrantsStep); this audits them.
 */
function auditRevoked(server: { id: string; name: string }, revoked: RevokedGrant[], reason: string, actor: string | null): RevokedGrant[] {
  if (revoked.length) {
    logAudit({
      event_type: 'authz.permission.change', event_category: 'authorization', severity: 'warning',
      user_id: actor ?? undefined, resource_type: 'mcp_server', resource_id: server.id,
      action: 'agent_tool_grants.revoke_mcp', success: true,
      metadata: { server: server.name, reason, revoked },
    });
  }
  return revoked;
}

function serverPrefix(name: string): string {
  return `${MCP_TOOL_PREFIX}${name}__`;
}

export class McpPolicyError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

export interface LaunchSpec { command: string; args: string[]; envNames: string[]; cwd: string }

function execRequired(): void {
  if (!isExecToolsEnabled()) {
    throw new McpPolicyError(`stdio MCP servers start host processes; the server operator must set ${EXEC_TOOLS_ENV_FLAG}=true first`, 403, 'exec_tools_disabled');
  }
}

function launchApprovalError(row: McpServerRow): McpPolicyError {
  return new McpPolicyError('Starting this stdio MCP server needs the owner approval of exactly this launch; send launchHash to approve', 409, 'launch_approval_required', {
    launch: { command: row.command, args: parseList(row.args), envNames: parseList(row.env_names), cwd: `MCP_SERVERS_DIR/${row.name}` },
    launchHash: row.launch_hash,
  });
}

function str(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) throw new McpConfigError(`${field} must be a string (max ${max})`);
  return v;
}

export function listServers(): Promise<McpServerView[]> {
  return sql().read((function* () {
    const views: McpServerView[] = [];
    for (const row of yield* listServerRowsStep()) views.push(yield* serverViewStep(row));
    return views;
  })());
}

export async function getServer(id: string): Promise<McpServerView | null> {
  return sql().read((function* () {
    const row = yield* getServerRowStep(id);
    return row ? yield* serverViewStep(row) : null;
  })());
}

/** A unique-constraint violation on either driver (SQLite code / PostgreSQL SQLSTATE 23505). */
function isUniqueViolation(err: any): boolean {
  return err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || err?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || err?.code === '23505';
}

function notFound(): McpPolicyError {
  return new McpPolicyError('MCP server not found', 404, 'not_found');
}

function conflict(): McpPolicyError {
  return new McpPolicyError('the MCP server was changed meanwhile; reload it and try again', 409, 'conflict');
}

/**
 * The server row, locked for the rest of the transaction (PostgreSQL), and
 * still the row a change was computed from: same target, secrets, generation
 * and enabled state. Throws 404 / 409 otherwise.
 */
function* lockUnchanged(row: McpServerRow): Step<McpServerRow> {
  const d = yield* dialect();
  const cur = yield* one<McpServerRow>(`SELECT * FROM mcp_servers WHERE id = ?${forUpdate(d)}`, row.id);
  if (!cur) throw notFound();
  const same = (k: keyof McpServerRow) => (cur[k] ?? null) === (row[k] ?? null);
  if (!(['launch_hash', 'url', 'allow_remote', 'secret_credential_id', 'generation', 'enabled', 'command', 'args', 'env_names', 'header_names'] as const).every(same)) {
    throw conflict();
  }
  return cur;
}

export interface ServerInput {
  name?: unknown; description?: unknown; transport?: unknown; command?: unknown; args?: unknown; url?: unknown;
  allowRemote?: unknown; env?: unknown; headers?: unknown; timeoutMs?: unknown; startupTimeoutMs?: unknown; maxResultBytes?: unknown;
}

/** Add a server. It starts disabled; enabling is a separate, approved step. */
export async function createServer(input: ServerInput, ownerId: string, options: { dormantImport?: boolean } = {}): Promise<McpServerView> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!SERVER_NAME_PATTERN.test(name)) throw new McpConfigError('name must be 1-24 lowercase letters, digits or "-" (no "_")');
  const nameTaken = () => new McpPolicyError(`an MCP server named "${name}" already exists`, 409, 'name_taken');
  if (await sql().read(getServerRowByNameStep(name))) throw nameTaken();
  const transport = input.transport as McpTransport;
  if (!MCP_TRANSPORTS.includes(transport)) throw new McpConfigError('transport must be stdio, http or sse');
  const description = str(input.description, 'description', MAX_DESCRIPTION_CHARS);
  const timeoutMs = clampTimeout(input.timeoutMs);
  const startupTimeoutMs = input.startupTimeoutMs === undefined ? null : clampTimeout(input.startupTimeoutMs);
  const maxResultBytes = clampResultBytes(input.maxResultBytes);
  const allowRemote = input.allowRemote === true;
  let command: string | null = null;
  let args: string[] = [];
  let url: string | null = null;
  let env: Record<string, string> | undefined;
  let headers: Record<string, string> | undefined;
  if (transport === 'stdio') {
    if (!options.dormantImport) execRequired();
    ({ command, args } = checkCommand(input.command, input.args));
    if (input.url !== undefined || input.headers !== undefined || allowRemote) throw new McpConfigError('url, headers and allowRemote are for http/sse servers');
    env = checkSecretMap(input.env, 'env');
  } else {
    url = checkServerUrl(input.url, allowRemote).toString();
    if (input.command !== undefined || input.args !== undefined || input.env !== undefined) throw new McpConfigError('command, args and env are for stdio servers');
    headers = checkSecretMap(input.headers, 'headers');
  }

  const id = randomUUID();
  const secrets = await writeSecrets(id, null, { env, headers });
  const hash = transport === 'stdio' ? launchHash({ command: command!, args, envNames: secrets.envNames }) : null;
  let revoked: RevokedGrant[];
  try {
    revoked = await sql().tx(() => (function* () {
      if (yield* getServerRowByNameStep(name)) throw nameTaken();
      yield* run(`
        INSERT INTO mcp_servers (id, name, description, transport, command, args, url, allow_remote, env_names, header_names,
          secret_credential_id, enabled, launch_hash, timeout_ms, max_result_bytes, status, created_by, generation, startup_timeout_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'disabled', ?, ?, ?)
      `, id, name, description, transport, command, transport === 'stdio' ? JSON.stringify(args) : null, url, allowRemote ? 1 : 0,
      JSON.stringify(secrets.envNames), JSON.stringify(secrets.headerNames), secrets.credentialId, hash, timeoutMs, maxResultBytes, ownerId, randomUUID(), startupTimeoutMs);
      // A former server with the same name never passes its grants on.
      return yield* revokeMcpGrantsStep(yield* grantedNamesWithPrefixStep(serverPrefix(name)));
    })());
  } catch (err) {
    await deleteSecrets(secrets.credentialId).catch(() => {});
    if (isUniqueViolation(err)) throw nameTaken();
    throw err;
  }
  auditRevoked({ id, name }, revoked, 'server_added', ownerId);
  return serverView((await getServerRow(id))!);
}

/**
 * Change a server. A change to what a stdio server starts (command, args,
 * env names) or where an http/sse server connects (url, allowRemote)
 * disables it; it must be enabled (and for stdio approved) again.
 */
export async function updateServer(id: string, input: ServerInput, ownerId: string): Promise<{ server: McpServerView; disabled: boolean; revokedGrants: RevokedGrant[] }> {
  const row = await getServerRow(id);
  if (!row) throw notFound();
  if (input.name !== undefined && input.name !== row.name) throw new McpConfigError('the name cannot be changed (it is part of the tool names)');
  if (input.transport !== undefined && input.transport !== row.transport) throw new McpConfigError('the transport cannot be changed; add a new server');
  const description = input.description !== undefined ? str(input.description, 'description', MAX_DESCRIPTION_CHARS) : row.description;
  const startupTimeoutMs = input.startupTimeoutMs !== undefined ? clampTimeout(input.startupTimeoutMs) : row.startup_timeout_ms;
  const timeoutMs = input.timeoutMs !== undefined ? clampTimeout(input.timeoutMs) : row.timeout_ms;
  const maxResultBytes = input.maxResultBytes !== undefined ? clampResultBytes(input.maxResultBytes) : row.max_result_bytes;

  let command = row.command;
  let args = parseList(row.args);
  let url = row.url;
  let allowRemote = row.allow_remote === 1;
  let env: Record<string, string> | undefined;
  let headers: Record<string, string> | undefined;
  if (row.transport === 'stdio') {
    if (input.command !== undefined || input.args !== undefined || input.env !== undefined) execRequired();
    if (input.url !== undefined || input.headers !== undefined || input.allowRemote !== undefined) throw new McpConfigError('url, headers and allowRemote are for http/sse servers');
    if (input.command !== undefined || input.args !== undefined) {
      ({ command, args } = checkCommand(input.command ?? row.command, input.args ?? args));
    }
    env = checkSecretMap(input.env, 'env');
  } else {
    if (input.command !== undefined || input.args !== undefined || input.env !== undefined) throw new McpConfigError('command, args and env are for stdio servers');
    if (input.allowRemote !== undefined) allowRemote = input.allowRemote === true;
    if (input.url !== undefined || input.allowRemote !== undefined) url = checkServerUrl(input.url ?? row.url, allowRemote).toString();
    headers = checkSecretMap(input.headers, 'headers');
  }
  const secrets = await writeSecrets(id, row.secret_credential_id, { env, headers });
  const hash = row.transport === 'stdio' ? launchHash({ command: command!, args, envNames: secrets.envNames }) : null;
  const targetChanged = row.transport === 'stdio' ? hash !== row.launch_hash : (url !== row.url || allowRemote !== (row.allow_remote === 1));
  const disable = targetChanged && row.enabled === 1;
  const d = sql().dialect;
  const revokedGrants = await sql().tx(() => (function* () {
    yield* lockUnchanged(row);
    yield* run(`
      UPDATE mcp_servers SET description = ?, command = ?, args = ?, url = ?, allow_remote = ?, env_names = ?, header_names = ?,
        secret_credential_id = ?, launch_hash = ?, timeout_ms = ?, max_result_bytes = ?, startup_timeout_ms = ?,
        enabled = CASE WHEN ? = 1 THEN 0 ELSE enabled END, status = CASE WHEN ? = 1 THEN 'disabled' ELSE status END, updated_at = ${nowText(d)}
      WHERE id = ?
    `, description, command, row.transport === 'stdio' ? JSON.stringify(args) : null, url, allowRemote ? 1 : 0,
    JSON.stringify(secrets.envNames), JSON.stringify(secrets.headerNames), secrets.credentialId, hash, timeoutMs, maxResultBytes, startupTimeoutMs,
    disable ? 1 : 0, disable ? 1 : 0, id);
    if (!targetChanged) return [];
    // New target = new server generation: its tools must be discovered again
    // and granted again (grants revoked in the same transaction).
    yield* run(`UPDATE mcp_servers SET generation = ?, status = CASE WHEN enabled = 1 THEN 'enabled' ELSE status END WHERE id = ?`, randomUUID(), id);
    yield* run('DELETE FROM mcp_server_tools WHERE server_id = ?', id);
    return yield* revokeMcpGrantsStep(yield* grantedNamesWithPrefixStep(serverPrefix(row.name)));
  })());
  if (targetChanged) auditRevoked(row, revokedGrants, 'target_changed', ownerId);
  await closeConnection(id);
  invalidateMcpTools();
  return { server: await serverView((await getServerRow(id))!), disabled: disable, revokedGrants };
}

/**
 * Enable a server. stdio: needs AGENT_EXEC_TOOLS=true and the owner's
 * approval of exactly this launch (launchHash from the 409 answer).
 */
export async function enableServer(id: string, input: { launchHash?: unknown }, ownerId: string): Promise<McpServerView> {
  const row = await getServerRow(id);
  if (!row) throw notFound();
  const d = sql().dialect;
  if (row.transport === 'stdio') {
    execRequired();
    if (!row.launch_hash || input.launchHash !== row.launch_hash) throw launchApprovalError(row);
    // Conditional on the approved hash: a launch change meanwhile approves nothing.
    await sql().read(run(`UPDATE mcp_servers SET enabled = 1, approved_launch_hash = launch_hash, approved_by = ?, approved_at = ${nowText(d)},
                status = 'enabled', last_error = NULL, updated_at = ${nowText(d)} WHERE id = ? AND launch_hash = ?`, ownerId, id, row.launch_hash));
  } else {
    checkServerUrl(row.url, row.allow_remote === 1);
    // Conditional on the checked URL: a target change meanwhile enables nothing.
    await sql().read(run(`UPDATE mcp_servers SET enabled = 1, status = 'enabled', last_error = NULL, updated_at = ${nowText(d)}
                WHERE id = ? AND url ${isParam(d)} AND allow_remote = ?`, id, row.url, row.allow_remote));
  }
  invalidateMcpTools();
  return serverView((await getServerRow(id))!);
}

export async function disableServer(id: string): Promise<McpServerView> {
  const row = await getServerRow(id);
  if (!row) throw notFound();
  await sql().read(run(`UPDATE mcp_servers SET enabled = 0, status = 'disabled', updated_at = ${nowText(sql().dialect)} WHERE id = ?`, id));
  await closeConnection(id);
  invalidateMcpTools();
  return serverView((await getServerRow(id))!);
}

export async function deleteServer(id: string, actor: string | null = null): Promise<McpServerRow & { revokedGrants: RevokedGrant[] }> {
  const row = await getServerRow(id);
  if (!row) throw notFound();
  await closeConnection(id);
  // Grants, bindings and the server row (its tools cascade) in one transaction.
  const revokedGrants = await sql().tx(() => (function* () {
    const d = yield* dialect();
    const cur = yield* one<McpServerRow>(`SELECT * FROM mcp_servers WHERE id = ?${forUpdate(d)}`, id);
    if (!cur) throw notFound();
    const revoked = yield* revokeMcpGrantsStep(yield* grantedNamesWithPrefixStep(serverPrefix(cur.name)));
    yield* run('DELETE FROM mcp_server_tools WHERE server_id = ?', id);
    yield* run('DELETE FROM mcp_servers WHERE id = ?', id);
    return revoked;
  })());
  auditRevoked(row, revokedGrants, 'server_deleted', actor);
  await deleteSecrets(row.secret_credential_id);
  invalidateMcpTools();
  return { ...row, revokedGrants };
}

export interface DiscoveryResult {
  server: McpServerView;
  discovered: number;
  skipped: Array<{ tool: string; reason: string }>;
  truncated: boolean;
  /** Grants removed because their tool vanished or changed (schema/annotations). */
  revokedGrants: RevokedGrant[];
}

/** Reopen an enabled connection, preserving launch approval and grant checks. */
export async function reconnectServer(id:string,actor:string|null=null):Promise<DiscoveryResult>{
 const row=await getServerRow(id);if(!row)throw notFound();
 if(row.enabled!==1)throw new McpPolicyError('enable the MCP server before reconnecting',409,'disabled');
 if(row.transport==='stdio'){execRequired();if(!isLaunchApproved(row))throw launchApprovalError(row);}
 await closeConnection(id);
 return refreshServer(id,actor);
}

/** Connect, tools/list, store the validated tools (replacing the old list). */
export async function refreshServer(id: string, actor: string | null = null): Promise<DiscoveryResult> {
  const row = await getServerRow(id);
  if (!row) throw notFound();
  if (row.enabled !== 1) throw new McpPolicyError('enable the MCP server before discovering its tools', 409, 'disabled');
  if (row.transport === 'stdio') {
    execRequired();
    if (!isLaunchApproved(row)) throw launchApprovalError(row);
  }
  let listed;
  try {
    listed = await listServerTools(row);
  } catch (err: any) {
    const code = typeof err?.code === 'string' ? err.code : 'unavailable';
    await sql().read(run(`UPDATE mcp_servers SET status = 'error', last_error = ?, updated_at = ${nowText(sql().dialect)} WHERE id = ?`,
      `${code}: ${String(err?.message || '').slice(0, 300)}`, id));
    throw new McpPolicyError(`discovery failed: ${err?.message || 'the MCP server could not be reached'}`, 502, `mcp_${code}`);
  }

  const skipped: DiscoveryResult['skipped'] = [];
  const keep: Array<{ tool: string; registry: string; title: string | null; description: string | null; schema: string; annotations: string | null }> = [];
  const seenRegistry = new Set<string>();
  for (const t of listed.tools) {
    const toolName = typeof t?.name === 'string' ? t.name : '';
    if (!toolName || toolName.length > 128) { skipped.push({ tool: toolName.slice(0, 64) || '(unnamed)', reason: 'invalid tool name' }); continue; }
    const registry = registryToolName(row.name, toolName);
    if (!registry) { skipped.push({ tool: toolName, reason: 'name too long for a model tool name (64 characters with the server prefix)' }); continue; }
    if (seenRegistry.has(registry)) { skipped.push({ tool: toolName, reason: 'name collides with another tool of this server' }); continue; }
    let schema: Record<string, any>;
    try {
      schema = sanitizeInputSchema(t.inputSchema);
    } catch (err) {
      skipped.push({ tool: toolName, reason: err instanceof SchemaError ? `invalid input schema: ${err.message}` : 'invalid input schema' });
      continue;
    }
    let annotations: string | null = null;
    if (t.annotations && typeof t.annotations === 'object' && !Array.isArray(t.annotations)) {
      const a: Record<string, boolean> = {};
      for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        if (typeof (t.annotations as any)[key] === 'boolean') a[key] = (t.annotations as any)[key];
      }
      annotations = JSON.stringify(a);
    }
    seenRegistry.add(registry);
    keep.push({
      tool: toolName,
      registry,
      title: typeof t.title === 'string' ? t.title.slice(0, 200) : null,
      description: typeof t.description === 'string' ? t.description.slice(0, MAX_DESCRIPTION_CHARS) : null,
      schema: JSON.stringify(schema),
      annotations,
    });
  }
  const fingerprints = new Map(keep.map((k) => [k.registry, toolFingerprint({ serverId: id, generation: row.generation, toolName: k.tool, inputSchema: k.schema, annotations: k.annotations, title: k.title, description: k.description })]));
  // One transaction: the server row is locked and must still be the
  // generation the fingerprints were computed for; grants of tools that
  // vanished or changed are removed (a changed tool needs a fresh grant)
  // together with the old tool rows, and the new rows are stored.
  const revokedGrants = await sql().tx(() => (function* () {
    const d = yield* dialect();
    yield* lockUnchanged(row);
    const oldTools = yield* listToolRowsStep(id);
    const overrides = new Map(oldTools.map((t) => [t.tool_name, t.requires_approval]));
    const stale = new Set(oldTools.filter((t) => !t.fingerprint || fingerprints.get(t.registry_name) !== t.fingerprint).map((t) => t.registry_name));
    for (const name of yield* grantedNamesWithPrefixStep(serverPrefix(row.name))) if (!fingerprints.has(name)) stale.add(name);
    const revoked = yield* revokeMcpGrantsStep([...stale]);
    yield* run('DELETE FROM mcp_server_tools WHERE server_id = ?', id);
    for (const k of keep) {
      yield* run(`INSERT INTO mcp_server_tools (server_id, tool_name, registry_name, title, description, input_schema, annotations, requires_approval, fingerprint)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, k.tool, k.registry, k.title, k.description, k.schema, k.annotations, overrides.get(k.tool) ?? null, fingerprints.get(k.registry) ?? null);
    }
    yield* run(`UPDATE mcp_servers SET status = 'ready', last_error = NULL, last_discovered_at = ${nowText(d)}, updated_at = ${nowText(d)} WHERE id = ?`, id);
    return revoked;
  })());
  auditRevoked(row, revokedGrants, 'tools_changed_on_refresh', actor);
  invalidateMcpTools();
  return { server: await serverView((await getServerRow(id))!), discovered: keep.length, skipped, truncated: listed.truncated, revokedGrants };
}

/** Owner setting for one tool: requiresApproval true / false / null (= derived from the server's hints). */
export async function setToolApproval(id: string, toolName: string, value: unknown): Promise<McpServerView> {
  const row = await getServerRow(id);
  if (!row) throw notFound();
  if (value !== true && value !== false && value !== null) throw new McpConfigError('requiresApproval must be true, false or null');
  const res = await sql().read(run('UPDATE mcp_server_tools SET requires_approval = ? WHERE server_id = ? AND tool_name = ?',
    value === null ? null : value ? 1 : 0, id, toolName));
  if (res.changes !== 1) throw new McpPolicyError('tool not found on this MCP server', 404, 'tool_not_found');
  invalidateMcpTools();
  return serverView((await getServerRow(id))!);
}
