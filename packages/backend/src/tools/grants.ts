/**
 * Per-agent tool grants (S1.2).
 *
 * The tools a model is offered, and the tools the registry runs, are the
 * intersection of:
 *   server exec gate (exec-policy.ts) ∩ channel policy (channel-policy.ts)
 *   ∩ the agent's grants (this module).
 *
 * Rules:
 *  - Grants are per agent (agents_config.id), stored in agent_tool_grants.
 *  - Agents that existed before grants (profile 'legacy-pending') get, on
 *    first use, the tools registered at that time that are not exec-class,
 *    so nothing breaks for the owner. Exec-class tools always need an
 *    explicit owner grant (and the server exec gate).
 *  - Agents without a profile (created later, by any code path) get the
 *    minimal safe set DEFAULT_AGENT_TOOLS.
 *  - A registry without an agent gets DEFAULT_AGENT_TOOLS too (fail closed).
 *  - A sub-agent (profile.parent_agent_id) and a delegated run (task spawned
 *    by another agent) only get the intersection with the parent's grants:
 *    delegation never expands permissions.
 *  - Personality, prompts and model output never change grants. Only the
 *    owner grants API (S1.4) writes them.
 *  - MCP tools (M1, mcp__<server>__<tool>) are never granted by default:
 *    not in the default set, not seeded for legacy agents, and never for
 *    the small agent. The grants API accepts `mcp:<server>:<tool>` too.
 *    Each MCP grant is bound to the tool's current fingerprint
 *    (mcp-client/grant-binding.ts); a stale binding is not a grant.
 *  - A grant may carry scopes, e.g. {"destinations": ["123"]} for a send tool:
 *    the call's destination must be in the list.
 */

import { all, atomic, dialect, one, run, sql, sqliteSync, type Step } from '../repositories/sql-steps.js';
import { forUpdate, nowText } from '../db/pg/dialect.js';
import type { Tool, ToolResult } from './types.js';
import { isToolExecClass } from './exec-policy.js';
import { isMcpToolName, NO_MCP_AGENTS, normalizeToolNameInput } from '../mcp-client/config.js';
import { currentMcpToolStep, isMcpGrantBoundStep, writeMcpBindingsStep } from '../mcp-client/grant-binding.js';

export interface GrantScopes {
  /** Allowed destinations for a send/call tool (chat ids, channels, numbers). */
  destinations?: string[];
}

export interface AgentToolGrants {
  /** Agent the grants belong to; undefined = no agent (default set). */
  agentId?: string;
  /** Granted tool name -> scopes (null = no extra scope limit). */
  tools: ReadonlyMap<string, GrantScopes | null>;
}

/** Minimal safe set for new agents and for registries without an agent. */
export const DEFAULT_AGENT_TOOLS: readonly string[] = [
  'memory_search',
  'memory_save',
  'memory_reflect',
  'memory_stats',
  'memory_edit',   // CORE-05: versioned; important memories via owner-approved proposals
  'memory_delete', // CORE-05: versioned (reversible); important memories via proposals
  'memory_forget', // CORE-07: complete removal; every call needs one-time owner approval (S1.3)
  'memory_doctor', // CORE-MEM-DOCTOR: read-only health check, owner's own turns only
  'memory_doctor_fix', // CORE-MEM-DOCTOR: safe fixes; every call needs one-time owner approval
  'memory_graph',  // CORE-MEM-GRAPH: read-only, owner's runs, open drawers only
  'memory_scopes', // MEM-SCALE-01: read-only scope tree, access, previews; owner's own turns only
  'memory_scope_apply', // MEM-SCALE-01: project lifecycle, departments, pinned facts; every call needs owner approval
  'memory_access_apply', // MEM-SCALE-01: inherited access policies; every call needs owner approval
  'memory_scope_forget', // MEM-SCALE-01: forget a whole project; every call needs owner approval
  'memory_trash', // MEM-TRASH-01: read-only Trash list; owner's own turns only
  'memory_restore', // MEM-TRASH-01: undo a delete (memory or project); owner's own turns only
  'memory_trash_empty', // MEM-TRASH-01: forget what is in the Trash; every call needs owner approval
  'memory_project_trash', // MEM-TRASH-01: move a project to the Trash; every call needs owner approval
  'memory_groups', // MEM-UX-02: read-only groups of projects; owner's own turns only
  'memory_group_apply', // MEM-UX-02: groups of projects + share within; every call needs owner approval
  'project_design', // DESIGN-FIND-01: read the project's design; runs with that project open, or the owner's own turn
  'project_design_apply', // DESIGN-FIND-01: main logo / colour, DESIGN.md switch, undo; every call needs owner approval
  'project_databases', // PROJECT-TECH-01: the project's databases as this agent's level allows (never rows or passwords)
  'project_databases_apply', // PROJECT-TECH-01: an agent's database level; every call needs owner approval
  'memory_move',   // MEM-CACHE-01: owner's runs, both drawers open; every call needs one-time owner approval
  'memory_review', // CORE-MEM-CONFLICT: read-only list of conflicts, owner's own turns, open drawers only
  'memory_review_decide', // CORE-MEM-CONFLICT: keep new / old / both; every call needs one-time owner approval
  'memory_review_routine', // MEM-GAPS-02: accept all routine reviews of a preview; every call needs one-time owner approval
  'memory_graph_review', // CORE-MEM-GRAPH: approve / reject a pending link; every call needs one-time owner approval
  'memory_graph_topic', // MEM-GRAPH-CLUSTER: cluster -> topic or dismiss; every call needs one-time owner approval
  'memory_graph_sync', // MEM-FINISH-01: rebuild the map (M14); every call needs one-time owner approval
  'memory_recall', // MEM-CACHE-01: read-only trace of the agent's own replies, summaries, cache metrics
  'storage_search',
  // BOARD-02: the agent's own board cards only (list, comment, move)
  'board_my_cards',
  'board_comment',
  'board_move',
  'board_checklist',
  'board_check',
];

/** Destination parameter of known send/call tools (for destination scopes). */
export const DESTINATION_PARAMS: Readonly<Record<string, string>> = {
  telegram_send: 'chatId',
  discord_send: 'channelId',
  slack_send: 'channel',
  whatsapp_send: 'to',
  make_call: 'toNumber',
};

/** Delegation from a principal without grants of its own: at most the default set. */
export const UNKNOWN_PRINCIPAL = '(unknown-principal)';

export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PARENT_DEPTH = 8;

export function staticGrants(names: Iterable<string>, agentId?: string): AgentToolGrants {
  const tools = new Map<string, GrantScopes | null>();
  for (const name of names) tools.set(name, null);
  return { agentId, tools };
}

export function defaultGrants(): AgentToolGrants {
  return staticGrants(DEFAULT_AGENT_TOOLS);
}

/** Sanitize a scopes object from storage or the API. Throws on bad input. */
export function normalizeScopes(raw: unknown): GrantScopes | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('scopes must be an object');
  const out: GrantScopes = {};
  for (const key of Object.keys(raw as object)) {
    if (key !== 'destinations') throw new Error(`unknown scope "${key}"`);
  }
  const dest = (raw as any).destinations;
  if (dest !== undefined) {
    if (!Array.isArray(dest) || dest.length > 100) throw new Error('destinations must be an array (max 100)');
    out.destinations = dest.map((d: unknown) => {
      if (typeof d !== 'string' || d.length === 0 || d.length > 200) throw new Error('invalid destination');
      return d;
    });
  }
  return Object.keys(out).length ? out : null;
}

function intersectScopes(a: GrantScopes | null, b: GrantScopes | null): GrantScopes | null {
  if (!a) return b;
  if (!b) return a;
  const out: GrantScopes = {};
  if (a.destinations || b.destinations) {
    if (!a.destinations) out.destinations = [...b.destinations!];
    else if (!b.destinations) out.destinations = [...a.destinations];
    else out.destinations = a.destinations.filter((d) => b.destinations!.includes(d));
  }
  return out;
}

/** Grants of `child` limited to what `parent` has (delegation subset). */
export function intersectGrants(child: AgentToolGrants, parent: AgentToolGrants): AgentToolGrants {
  const tools = new Map<string, GrantScopes | null>();
  for (const [name, scopes] of child.tools) {
    if (!parent.tools.has(name)) continue;
    tools.set(name, intersectScopes(scopes, parent.tools.get(name) ?? null));
  }
  return { agentId: child.agentId, tools };
}

export function isToolGranted(grants: AgentToolGrants, name: string): boolean {
  return grants.tools.has(name);
}

function refusal(name: string, reason: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Tool "${name}" is not permitted for this agent: ${reason}` }],
    error: 'Tool refused by agent grants',
  };
}

/**
 * Check a concrete call against the agent's grants. Returns a refusal or
 * null when the call may proceed.
 */
export function grantCallRefusal(
  grants: AgentToolGrants,
  name: string,
  tool: Pick<Tool, 'name'> & { destinationParam?: string } | undefined,
  params: Record<string, any> | undefined
): ToolResult | null {
  if (!grants.tools.has(name)) {
    return refusal(name, 'the owner has not granted it to this agent.');
  }
  const scopes = grants.tools.get(name);
  if (scopes?.destinations) {
    const param = tool?.destinationParam || DESTINATION_PARAMS[name];
    const destination = param ? params?.[param] : undefined;
    if (!param) return refusal(name, 'its destination cannot be checked against the granted destinations.');
    if (typeof destination !== 'string' || !scopes.destinations.includes(destination)) {
      return refusal(name, 'this destination is not in the granted destinations.');
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

interface ProfileRow { agent_id: string; source: string; parent_agent_id: string | null; version?: number }

type Available = ReadonlyArray<Pick<Tool, 'name' | 'execClass'>>;

function* agentExists(agentId: string, lock = false): Step<boolean> {
  const d = yield* dialect();
  return !!(yield* one(`SELECT id FROM agents_config WHERE id = ?${lock ? forUpdate(d) : ''}`, agentId));
}

function* readProfile(agentId: string): Step<ProfileRow | undefined> {
  return yield* one<ProfileRow>('SELECT agent_id, source, parent_agent_id, version FROM agent_grant_profiles WHERE agent_id = ?', agentId);
}

function* readGrantRows(agentId: string): Step<Map<string, GrantScopes | null>> {
  const rows = yield* all<{ tool_name: string; scopes: string | null }>('SELECT tool_name, scopes FROM agent_tool_grants WHERE agent_id = ?', agentId);
  const tools = new Map<string, GrantScopes | null>();
  for (const row of rows) {
    let scopes: GrantScopes | null = null;
    try {
      scopes = row.scopes ? normalizeScopes(JSON.parse(row.scopes)) : null;
    } catch {
      continue; // unreadable scopes: fail closed (tool not granted)
    }
    // M1: an MCP grant only counts while bound to the tool's current server
    // instance + fingerprint (a re-created server or changed tool needs a fresh grant).
    // The binding is read with the grants (process driver; mcp-client/grant-binding.ts).
    if (isMcpToolName(row.tool_name) && !(yield* isMcpGrantBoundStep(agentId, row.tool_name))) continue;
    tools.set(row.tool_name, scopes);
  }
  return tools;
}

function* writeGrantRows(agentId: string, entries: Array<{ tool: string; scopes: GrantScopes | null }>, by: string | null): Step<void> {
  yield* run('DELETE FROM agent_tool_grants WHERE agent_id = ?', agentId);
  for (const e of entries) {
    yield* run('INSERT INTO agent_tool_grants (agent_id, tool_name, scopes, granted_by) VALUES (?, ?, ?, ?)', agentId, e.tool, e.scopes ? JSON.stringify(e.scopes) : null, by);
  }
}

/**
 * Make sure an existing agent has a grant profile; seeds legacy or default
 * grants once (one transaction; on PostgreSQL the agent row is locked, so
 * two first uses at the same time seed once). `available` = tools
 * registered right now.
 */
function* ensureGrantProfileStep(agentId: string, available: Available): Step<ProfileRow | undefined> {
  if (!(yield* agentExists(agentId))) return undefined;
  return yield* atomic(function* () {
    const d = yield* dialect();
    if (!(yield* agentExists(agentId, true))) return undefined;
    const profile = yield* readProfile(agentId);
    if (profile && profile.source !== 'legacy-pending') return profile;
    if (profile) {
      const names = available.filter((t) => !isToolExecClass(t) && !isMcpToolName(t.name)).map((t) => t.name);
      yield* writeGrantRows(agentId, names.map((tool) => ({ tool, scopes: null })), 'system:legacy');
      yield* run(`UPDATE agent_grant_profiles SET source = 'legacy', updated_at = ${nowText(d)} WHERE agent_id = ?`, agentId);
    } else {
      yield* writeGrantRows(agentId, DEFAULT_AGENT_TOOLS.map((tool) => ({ tool, scopes: null })), 'system:default');
      yield* run(`INSERT INTO agent_grant_profiles (agent_id, source) VALUES (?, 'default')`, agentId);
    }
    return yield* readProfile(agentId);
  });
}

export function ensureGrantProfile(agentId: string, available: Available): Promise<ProfileRow | undefined> {
  return sql().read(ensureGrantProfileStep(agentId, available));
}

function* loadAgentGrantsStep(agentId: string, available: Available, delegatedFrom: string[]): Step<AgentToolGrants> {
  try {
    const own = yield* loadOwn(agentId, available, new Set());
    let grants = own;
    for (const parent of delegatedFrom) {
      if (parent === UNKNOWN_PRINCIPAL || !parent) { grants = intersectGrants(grants, defaultGrants()); continue; }
      if (parent === agentId) continue;
      grants = intersectGrants(grants, yield* loadOwn(parent, available, new Set()));
    }
    return grants;
  } catch (err: any) {
    console.warn(`[Grants] Could not load grants for ${agentId}: ${err?.message || 'error'}`);
    return { agentId, tools: defaultGrants().tools };
  }
}

/**
 * Effective grants for an agent: its own grants, intersected with every
 * parent up the chain and with `delegatedFrom` agents (task spawners).
 * Unknown agent -> nothing granted. DB errors -> default set (fail closed).
 */
export function loadAgentGrants(agentId: string, available: Available, delegatedFrom: string[] = []): Promise<AgentToolGrants> {
  return sql().read(loadAgentGrantsStep(agentId, available, delegatedFrom));
}

/**
 * loadAgentGrants, synchronously: SQLite only (createToolsRegistry's
 * synchronous path). Throws SyncOnPostgresError on PostgreSQL, where the
 * grants are loaded with loadAgentGrants() (tools/index.ts
 * createAgentToolsRegistry).
 */
export function loadAgentGrantsSync(agentId: string, available: Available, delegatedFrom: string[] = []): AgentToolGrants {
  return sqliteSync(loadAgentGrantsStep(agentId, available, delegatedFrom));
}

function* loadOwn(agentId: string, available: Available, seen: Set<string>): Step<AgentToolGrants> {
  const profile = yield* ensureGrantProfileStep(agentId, available);
  if (!profile) return { agentId, tools: new Map() }; // unknown agent: nothing
  const own = yield* readGrantRows(agentId);
  if (NO_MCP_AGENTS.has(agentId)) for (const name of [...own.keys()]) if (isMcpToolName(name)) own.delete(name);
  let grants: AgentToolGrants = { agentId, tools: own };
  seen.add(agentId);
  const parent = profile.parent_agent_id;
  if (parent) {
    if (seen.has(parent) || seen.size >= MAX_PARENT_DEPTH) return { agentId, tools: new Map() }; // cycle: fail closed
    grants = intersectGrants(grants, yield* loadOwn(parent, available, seen));
  }
  return grants;
}

export interface GrantView {
  agentId: string;
  source: string;
  parentAgentId: string | null;
  grants: Array<{ tool: string; scopes: GrantScopes | null }>;
  /** BE-UI-01: optimistic-concurrency token; PUT replaces only when it matches. */
  version: number;
}

/** Stored grants of an agent (own, not intersected), seeding if needed. */
export function getAgentGrantView(agentId: string, available: Available): Promise<GrantView | null> {
  return sql().read((function* () {
    const profile = yield* ensureGrantProfileStep(agentId, available);
    if (!profile) return null;
    const tools = yield* readGrantRows(agentId);
    return {
      agentId,
      source: profile.source,
      parentAgentId: profile.parent_agent_id,
      version: (yield* readProfile(agentId))?.version ?? 1,
      grants: [...tools.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tool, scopes]) => ({ tool, scopes })),
    };
  })());
}

export class GrantValidationError extends Error {}
/** BE-UI-01: the grants changed since the caller read them (expectedVersion mismatch). */
export class GrantConflictError extends Error {
  constructor(readonly currentVersion: number) { super('The grants were changed by someone else; reload them and try again'); }
}

/**
 * Replace an agent's grants (owner API). A sub-agent may only receive a
 * subset of its parent's effective grants. Returns before/after tool names.
 */
export function setAgentGrants(
  agentId: string,
  input: { grants: unknown; parentAgentId?: unknown; expectedVersion?: number | null },
  by: string,
  available: Available,
): Promise<{ before: string[]; after: string[]; parentAgentId: string | null; version: number }> {
  return sql().read(setAgentGrantsStep(agentId, input, by, available));
}

export function* setAgentGrantsStep(
  agentId: string,
  input: { grants: unknown; parentAgentId?: unknown; expectedVersion?: number | null },
  by: string,
  available: Available,
): Step<{ before: string[]; after: string[]; parentAgentId: string | null; version: number }> {
  const profile = yield* ensureGrantProfileStep(agentId, available);
  if (!profile) throw new GrantValidationError('Agent not found');
  if (!Array.isArray(input.grants) || input.grants.length > 500) throw new GrantValidationError('grants must be an array (max 500)');

  const entries: Array<{ tool: string; scopes: GrantScopes | null }> = [];
  const seenNames = new Set<string>();
  for (const item of input.grants) {
    const rawTool = typeof item === 'string' ? item : (item as any)?.tool;
    const tool = typeof rawTool === 'string' ? normalizeToolNameInput(rawTool) : rawTool;
    if (typeof tool !== 'string' || !TOOL_NAME_PATTERN.test(tool)) throw new GrantValidationError('invalid tool name');
    if (isMcpToolName(tool) && NO_MCP_AGENTS.has(agentId)) throw new GrantValidationError(`"${tool}": this agent may never use MCP tools`);
    if (isMcpToolName(tool) && !(yield* currentMcpToolStep(tool))) throw new GrantValidationError(`"${tool}" is not a discovered MCP tool; refresh its server first`);
    if (seenNames.has(tool)) throw new GrantValidationError(`duplicate tool "${tool}"`);
    seenNames.add(tool);
    let scopes: GrantScopes | null;
    try {
      scopes = typeof item === 'string' ? null : normalizeScopes((item as any).scopes);
    } catch (err: any) {
      throw new GrantValidationError(`${tool}: ${err.message}`);
    }
    entries.push({ tool, scopes });
  }

  let parentAgentId: string | null = profile.parent_agent_id;
  if (input.parentAgentId !== undefined) {
    if (input.parentAgentId === null || input.parentAgentId === '') parentAgentId = null;
    else if (typeof input.parentAgentId !== 'string' || !(yield* agentExists(input.parentAgentId))) throw new GrantValidationError('parent agent not found');
    else if (input.parentAgentId === agentId) throw new GrantValidationError('an agent cannot be its own parent');
    else parentAgentId = input.parentAgentId;
  }
  if (parentAgentId) {
    // No cycles: the parent's chain must not contain this agent.
    let cursor: string | null = parentAgentId;
    for (let i = 0; cursor && i < MAX_PARENT_DEPTH + 1; i++) {
      if (cursor === agentId) throw new GrantValidationError('parent chain would form a cycle');
      const next: ProfileRow | undefined = yield* readProfile(cursor);
      cursor = next?.parent_agent_id ?? null;
    }
    const parent = yield* loadOwn(parentAgentId, available, new Set());
    for (const e of entries) {
      if (!parent.tools.has(e.tool)) throw new GrantValidationError(`"${e.tool}" is not granted to the parent agent; a sub-agent only gets a subset of its parent's grants`);
      const p = parent.tools.get(e.tool);
      if (p?.destinations) {
        const want = e.scopes?.destinations;
        if (!want || want.some((d) => !p.destinations!.includes(d))) {
          throw new GrantValidationError(`"${e.tool}" destinations must be a subset of the parent's destinations`);
        }
      }
    }
  }

  const before = [...(yield* readGrantRows(agentId)).keys()].sort();
  const expected = input.expectedVersion ?? null;
  yield* atomic(function* () {
    const d = yield* dialect();
    // Compare-and-set first: nothing is written when the version moved on
    // (on PostgreSQL a concurrent writer holds the row lock; this UPDATE then
    // re-checks the version and changes nothing).
    const r = yield* run(`UPDATE agent_grant_profiles SET source = 'owner', parent_agent_id = ?, updated_by = ?, updated_at = ${nowText(d)}, version = version + 1
                          WHERE agent_id = ?${expected !== null ? ' AND version = ?' : ''}`,
      parentAgentId, by, agentId, ...(expected !== null ? [expected] : []));
    if (r.changes === 0) throw new GrantConflictError((yield* readProfile(agentId))?.version ?? 1);
    yield* writeGrantRows(agentId, entries, by);
    // The MCP bindings in the same transaction as the grant rows (both drivers).
    yield* writeMcpBindingsStep(agentId, entries.map((e) => e.tool).filter(isMcpToolName), by);
  });
  return { before, after: entries.map((e) => e.tool).sort(), parentAgentId, version: (yield* readProfile(agentId))?.version ?? 1 };
}
