/**
 * Per-agent memory scope and permission modes (CORE-PERMS-01, D-AGENT-PERMS).
 *
 * The owner sets, per agent:
 *  - memoryRead / memoryWrite: the drawer kinds the agent may read and write
 *    (write is a subset of read). The tools registry narrows the run's
 *    drawers to memoryRead (tools/memory/scope.ts) and the memory repository
 *    refuses writes outside memoryWrite (repositories/scope.ts drawerWritable).
 *  - sharedMemory: whether the agent may see memories other agents shared
 *    with the team. Agent runs do not read shared memories yet, so today this
 *    only records the owner's choice (off = never, also later).
 *  - modes: off / ask / allow per tool category. off = the tool is neither
 *    offered nor run; ask = every call waits for a one-time owner approval;
 *    allow = runs without approval. "allow" for money, install or delete
 *    must be confirmed explicitly by the owner (confirmRisky).
 *
 * No stored row = the behaviour before CORE-PERMS-01 (LEGACY_PERMISSIONS);
 * agents created from now on get a row with every category on "ask"
 * (NEW_AGENT_PERMISSIONS, the safe default of D-AGENT-PERMS).
 */

import { all, dialect, one, run, sql, sqliteSync, type Step } from '../repositories/sql-steps.js';
import { nowText } from '../db/pg/dialect.js';
import { DRAWER_KINDS, type DrawerKind } from '../memory/drawers.js';
import { APPROVAL_REQUIRED_TOOLS } from './approvals.js';
import type { Tool } from './types.js';
import { accessSnapshot, accessSnapshotSync, narrowPermissions, type AccessSnapshot } from '../memory/scopes/access.js';

export const PERMISSION_CATEGORIES = ['browser', 'network', 'message', 'delete', 'install', 'money', 'settings'] as const;
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];
export const PERMISSION_MODES = ['off', 'ask', 'allow'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
/** Categories whose "allow" the owner must confirm explicitly. */
export const RISKY_CATEGORIES: ReadonlySet<PermissionCategory> = new Set(['money', 'install', 'delete']);

export interface AgentPermissions {
  agentId: string;
  memoryRead: DrawerKind[];
  memoryWrite: DrawerKind[];
  sharedMemory: boolean;
  modes: Record<PermissionCategory, PermissionMode>;
  /** 0 = no stored row (defaults); stored rows start at 1. */
  version: number;
  /**
   * MEM-GAPS-02: the scope columns of the owner's access grid this run may
   * read / write ('company' = company pinned facts, 'department' = the
   * project's department facts). Set once the owner's policies narrowed the
   * run (narrowPermissions); absent = not narrowed (no cap).
   */
  scopeRead?: Array<'company' | 'department'>;
  scopeWrite?: Array<'company' | 'department'>;
}

const ALL_KINDS = [...DRAWER_KINDS] as DrawerKind[];
const modesOf = (m: Partial<Record<PermissionCategory, PermissionMode>>, rest: PermissionMode) =>
  Object.fromEntries(PERMISSION_CATEGORIES.map((c) => [c, m[c] ?? rest])) as Record<PermissionCategory, PermissionMode>;

/** Before CORE-PERMS-01: every drawer; browser and network ran freely; the risky categories asked. */
export const LEGACY_MODES = modesOf({ browser: 'allow', network: 'allow' }, 'ask');
export const NEW_AGENT_MODES = modesOf({}, 'ask');

export function legacyPermissions(agentId: string): AgentPermissions {
  return { agentId, memoryRead: [...ALL_KINDS], memoryWrite: [...ALL_KINDS], sharedMemory: false, modes: { ...LEGACY_MODES }, version: 0 };
}

const BROWSER_TOOL = /^browser_/;
const NETWORK_TOOLS: ReadonlySet<string> = new Set(['web_fetch', 'web_search', 'http_request']);

/**
 * The permission category of a tool, or null (not covered by a mode).
 * browser_* -> browser; web fetch/search and MCP tools -> network; the known
 * risky tools and *_send by their approval category.
 */
export function permissionCategory(tool: Pick<Tool, 'name'> & { mcp?: unknown }): PermissionCategory | null {
  const name = tool.name;
  if (BROWSER_TOOL.test(name)) return 'browser';
  if (NETWORK_TOOLS.has(name) || tool.mcp || name.startsWith('mcp__')) return 'network';
  const known = APPROVAL_REQUIRED_TOOLS[name];
  if (known && known !== 'other') return known as PermissionCategory;
  if (/_send$/.test(name)) return 'message';
  if (name === 'memory_delete') return 'delete';
  return null;
}

export function modeFor(p: AgentPermissions | undefined, tool: Pick<Tool, 'name'> & { mcp?: unknown }): PermissionMode | null {
  const cat = permissionCategory(tool);
  if (!cat) return null;
  return (p?.modes ?? LEGACY_MODES)[cat];
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface Row { agent_id: string; memory_read: string; memory_write: string; shared_memory: number; modes: string; version: number }

const kindsFrom = (text: string): DrawerKind[] => {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? ALL_KINDS.filter((k) => v.includes(k)) : [];
  } catch { return []; }
};

function fromRow(r: Row): AgentPermissions {
  let raw: Record<string, unknown> = {};
  try { const v = JSON.parse(r.modes); if (v && typeof v === 'object' && !Array.isArray(v)) raw = v; } catch { /* fail closed below */ }
  // A missing or broken mode reads as 'ask' (fail closed), never as 'allow'.
  const modes = Object.fromEntries(PERMISSION_CATEGORIES.map((c) => [c, (PERMISSION_MODES as readonly unknown[]).includes(raw[c]) ? raw[c] : 'ask'])) as Record<PermissionCategory, PermissionMode>;
  const memoryRead = kindsFrom(r.memory_read);
  return {
    agentId: r.agent_id,
    memoryRead,
    memoryWrite: kindsFrom(r.memory_write).filter((k) => memoryRead.includes(k)),
    sharedMemory: Number(r.shared_memory) === 1,
    modes,
    version: Number(r.version),
  };
}

function* loadStep(agentId: string): Step<AgentPermissions> {
  const r = yield* one<Row>('SELECT agent_id, memory_read, memory_write, shared_memory, modes, version FROM agent_permissions WHERE agent_id = ?', agentId);
  return r ? fromRow(r) : legacyPermissions(agentId);
}

/** The agent's permissions (defaults when none are stored). DB errors -> every category off, no drawers (fail closed). */
export async function loadAgentPermissions(agentId: string): Promise<AgentPermissions> {
  try { return await sql().read(loadStep(agentId)); } catch { return closedPermissions(agentId); }
}

const MODE_RANK: Record<PermissionMode, number> = { off: 0, ask: 1, allow: 2 };

/**
 * The strictest of several agents' permissions (a delegated run must never
 * get more than any agent it was delegated from): per category the most
 * restrictive mode, memory kinds intersected, shared memory only when all allow it.
 */
export function strictest(agentId: string, list: readonly AgentPermissions[]): AgentPermissions {
  const [first, ...rest] = list;
  const both = <T>(a: T[] | undefined, b: T[] | undefined): T[] | undefined => (a && b ? a.filter((k) => b.includes(k)) : a ?? b);
  return rest.reduce<AgentPermissions>((acc, p) => ({
    agentId,
    memoryRead: acc.memoryRead.filter((k) => p.memoryRead.includes(k)),
    memoryWrite: acc.memoryWrite.filter((k) => p.memoryWrite.includes(k)),
    ...(acc.scopeRead || p.scopeRead ? { scopeRead: both(acc.scopeRead, p.scopeRead) } : {}),
    ...(acc.scopeWrite || p.scopeWrite ? { scopeWrite: both(acc.scopeWrite, p.scopeWrite) } : {}),
    sharedMemory: acc.sharedMemory && p.sharedMemory,
    modes: Object.fromEntries(PERMISSION_CATEGORIES.map((c) => [c, MODE_RANK[p.modes[c]] < MODE_RANK[acc.modes[c]] ? p.modes[c] : acc.modes[c]])) as Record<PermissionCategory, PermissionMode>,
    version: acc.version,
  }), { ...first, agentId });
}

/**
 * MEM-SCALE-01: where a run happens. With a user, every agent's memory kinds
 * are narrowed by that owner's inherited access policies for the project
 * (company -> department -> project -> agent exceptions, role template);
 * the policies only ever narrow, so the agent's own permissions stay the cap.
 */
export interface RunScope { userId?: string | null; project?: string | null }

function narrowed(list: AgentPermissions[], scope: RunScope | undefined, snap: () => AccessSnapshot): AgentPermissions[] {
  if (!scope?.userId) return list;
  try {
    const s = snap();
    return list.map((p) => narrowPermissions(p, s, scope.project ?? null));
  } catch {
    // Policies unreadable: no drawers (fail closed), modes unchanged.
    return list.map((p) => ({ ...p, memoryRead: [], memoryWrite: [], scopeRead: [], scopeWrite: [] }));
  }
}

/** The permissions a run of `agentId` gets: its own, narrowed by every agent it was delegated from (and by the owner's policies for the run's project). */
export async function loadRunPermissions(agentId: string, delegatedFrom: readonly string[] = [], scope?: RunScope): Promise<AgentPermissions> {
  const ids = [agentId, ...delegatedFrom.filter((d) => d && d !== agentId)];
  const list = await Promise.all(ids.map((id) => loadAgentPermissions(id)));
  let snap: AccessSnapshot | null = null;
  if (scope?.userId) { try { snap = await accessSnapshot(scope.userId); } catch { snap = null; } }
  return strictest(agentId, narrowed(list, scope, () => { if (!snap) throw new Error('policies unavailable'); return snap; }));
}

/** loadRunPermissions, synchronously: SQLite only. */
export function loadRunPermissionsSync(agentId: string, delegatedFrom: readonly string[] = [], scope?: RunScope): AgentPermissions {
  const ids = [agentId, ...delegatedFrom.filter((d) => d && d !== agentId)];
  return strictest(agentId, narrowed(ids.map((id) => loadAgentPermissionsSync(id)), scope, () => accessSnapshotSync(scope!.userId!)));
}

/** loadAgentPermissions, synchronously: SQLite only (createToolsRegistry's synchronous path). */
export function loadAgentPermissionsSync(agentId: string): AgentPermissions {
  try { return sqliteSync(loadStep(agentId)); } catch { return closedPermissions(agentId); }
}

function closedPermissions(agentId: string): AgentPermissions {
  return { agentId, memoryRead: [], memoryWrite: [], sharedMemory: false, modes: modesOf({}, 'off'), version: 0 };
}

/** Seed the safe default row for a new agent. A step: run it in the agent's create transaction. */
export function* seedNewAgentPermissionsStep(agentId: string, by: string | null): Step<void> {
  const d = yield* dialect();
  yield* run(`INSERT INTO agent_permissions (agent_id, memory_read, memory_write, shared_memory, modes, version, updated_by, updated_at)
    VALUES (?, ?, ?, 0, ?, 1, ?, ${nowText(d)})`,
  agentId, JSON.stringify(ALL_KINDS), JSON.stringify(ALL_KINDS), JSON.stringify(NEW_AGENT_MODES), by);
}

export class PermissionsInputError extends Error {
  constructor(message: string, readonly code = 'invalid_permissions') { super(message); }
}
export class PermissionsConflictError extends Error {
  constructor(readonly current: AgentPermissions) { super('These permissions were changed meanwhile. Reload and review them.'); }
}
export class PermissionsNotFoundError extends Error {}

export interface PermissionsInput { memoryRead?: unknown; memoryWrite?: unknown; sharedMemory?: unknown; modes?: unknown; confirmRisky?: unknown }

function parseKinds(v: unknown, field: string): DrawerKind[] {
  if (!Array.isArray(v) || v.length > ALL_KINDS.length || !v.every((k) => (ALL_KINDS as readonly unknown[]).includes(k)) || new Set(v).size !== v.length) {
    throw new PermissionsInputError(`${field} must be a list of drawer kinds (${ALL_KINDS.join(', ')})`);
  }
  return ALL_KINDS.filter((k) => v.includes(k));
}

/** Validated full replacement. allow on money / install / delete needs confirmRisky: true. */
export function parsePermissionsInput(agentId: string, input: PermissionsInput): Omit<AgentPermissions, 'version'> {
  const memoryRead = parseKinds(input.memoryRead, 'memoryRead');
  const memoryWrite = parseKinds(input.memoryWrite, 'memoryWrite');
  if (memoryWrite.some((k) => !memoryRead.includes(k))) throw new PermissionsInputError('memoryWrite may only name drawers that memoryRead also names');
  if (typeof input.sharedMemory !== 'boolean') throw new PermissionsInputError('sharedMemory must be true or false');
  const m = input.modes;
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new PermissionsInputError('modes must be an object of category -> off | ask | allow');
  const keys = Object.keys(m);
  if (keys.length !== PERMISSION_CATEGORIES.length || !PERMISSION_CATEGORIES.every((c) => keys.includes(c))) {
    throw new PermissionsInputError(`modes must give every category: ${PERMISSION_CATEGORIES.join(', ')}`);
  }
  const modes = {} as Record<PermissionCategory, PermissionMode>;
  for (const c of PERMISSION_CATEGORIES) {
    const v = (m as Record<string, unknown>)[c];
    if (!(PERMISSION_MODES as readonly unknown[]).includes(v)) throw new PermissionsInputError(`modes.${c} must be off, ask or allow`);
    modes[c] = v as PermissionMode;
  }
  if (input.confirmRisky !== undefined && typeof input.confirmRisky !== 'boolean') throw new PermissionsInputError('confirmRisky must be true or false');
  const risky = PERMISSION_CATEGORIES.filter((c) => RISKY_CATEGORIES.has(c) && modes[c] === 'allow');
  if (risky.length && input.confirmRisky !== true) {
    throw new PermissionsInputError(`Allowing ${risky.join(', ')} without approval must be confirmed (confirmRisky: true)`, 'risky_not_confirmed');
  }
  return { agentId, memoryRead, memoryWrite, sharedMemory: input.sharedMemory, modes };
}

/** The agent's permissions for the owner view, or null for an unknown agent. */
export async function getAgentPermissionsView(agentId: string): Promise<AgentPermissions | null> {
  return sql().read((function* () {
    const agent = yield* one<{ id: string }>('SELECT id FROM agents_config WHERE id = ?', agentId);
    if (!agent) return null;
    return yield* loadStep(agentId);
  })());
}

/**
 * Replace the agent's permissions when `expected` matches the current
 * version (0 = no row yet). Returns the stored permissions.
 */
export async function setAgentPermissions(agentId: string, input: PermissionsInput, expected: number, by: string): Promise<{ before: AgentPermissions; after: AgentPermissions }> {
  const next = parsePermissionsInput(agentId, input);
  return sql().tx(function* () {
    const d = yield* dialect();
    const agent = yield* one<{ id: string }>('SELECT id FROM agents_config WHERE id = ?', agentId);
    if (!agent) throw new PermissionsNotFoundError('Agent not found');
    const before = yield* loadStep(agentId);
    if (before.version !== expected) throw new PermissionsConflictError(before);
    const values = [JSON.stringify(next.memoryRead), JSON.stringify(next.memoryWrite), next.sharedMemory ? 1 : 0, JSON.stringify(next.modes), by] as const;
    if (before.version === 0) {
      yield* run(`INSERT INTO agent_permissions (agent_id, memory_read, memory_write, shared_memory, modes, version, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ${nowText(d)})`, agentId, ...values);
    } else {
      const r = yield* run(`UPDATE agent_permissions SET memory_read = ?, memory_write = ?, shared_memory = ?, modes = ?, updated_by = ?, version = version + 1, updated_at = ${nowText(d)}
        WHERE agent_id = ? AND version = ?`, ...values, agentId, expected);
      if (r.changes !== 1) throw new PermissionsConflictError(yield* loadStep(agentId));
    }
    return { before, after: yield* loadStep(agentId) };
  }, { immediate: true });
}

/** Ids of agents with a stored row (tests and audits). */
export function storedPermissionAgents(): Promise<string[]> {
  return sql().read(all<{ agent_id: string }>('SELECT agent_id FROM agent_permissions ORDER BY agent_id')).then((r) => r.map((x) => x.agent_id));
}
