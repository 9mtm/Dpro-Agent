/**
 * Actor: who is acting (B1-core).
 *
 * Every repository method takes an Actor first and decides the scope from it
 * (see scope.ts). An Actor is built in exactly two places:
 *
 *  - per request by the auth gate (auth/auth-gate.ts -> `request.actor`), from
 *    the verified bearer token or a live server-created channel turn;
 *  - per tool call by the tools registry (`context.actor`), from the run's
 *    trusted context (user, agent, channel policy, open memory drawers).
 *
 * Nothing else builds one: no route reads a user id from the body or query,
 * and model output never reaches these builders. `SYSTEM_ACTOR` is for server
 * jobs (recovery, schedulers, migrations) only and is never given to a route.
 *
 * Kinds:
 *  - 'user'    a signed-in account; role owner | admin | user | guest
 *  - 'agent'   a tool call inside an agent run for `userId` (for memory in a
 *              board task run: the run's owner, see toolMemoryActor), limited to the
 *              run's open memory `drawers`; never owner-wide, whatever the
 *              user's role (`role` is the run user's role, for information)
 *  - 'service' a server-created channel/phone turn (an outsider is answered);
 *              `userId` is the account the turn runs as, `channel` its channel
 *  - 'system'  server-internal code with no request behind it
 */

import { getDatabase } from '../db/index.js';
import { dbDriver } from '../db/pg/config.js';
import { pgOne } from '../db/pg/pool.js';
import type { UserRole } from '../auth/route-guards.js';
import type { DrawerRef } from '../memory/drawers.js';
import type { ToolExecutionContext } from '../tools/types.js';
import { toolMemoryDrawers, toolMemoryWriteKinds } from '../tools/memory/scope.js';

export type ActorKind = 'user' | 'agent' | 'service' | 'system';
export type ActorRole = UserRole | 'none';

export interface Actor {
  readonly kind: ActorKind;
  /** The account acted for. Always set for 'user'; the run's user for 'agent'. */
  readonly userId?: string;
  /** agents_config.id of the agent run ('agent' only). */
  readonly agentId?: string;
  readonly role: ActorRole;
  /** Channel of a channel turn ('service', or an 'agent' run inside one). */
  readonly channel?: string;
  /** Memory drawers open for an agent run (CORE-03); absent = not an agent run. */
  readonly drawers?: readonly DrawerRef[];
  /** CORE-PERMS-01: drawer kinds an agent run may write; absent = every open drawer. */
  readonly writeKinds?: readonly DrawerRef['kind'][];
  /** Durable task run the tool call belongs to (CORE-08), for audit only. */
  readonly runId?: string;
}

const ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'user', 'guest']);

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

/** Actor of a signed-in account (built by the auth gate from the verified token). */
export function userActor(user: { id: string; role: string }): Actor {
  const role: ActorRole = ROLES.has(user.role) ? user.role as UserRole : 'none';
  return freeze({ kind: 'user' as const, userId: user.id, role });
}

/** Actor of a live server-created channel turn (built by the auth gate). */
export function serviceActor(turn: { channel?: string; userId?: string }): Actor {
  return freeze({
    kind: 'service' as const,
    role: 'none' as const,
    ...(turn.userId ? { userId: turn.userId } : {}),
    channel: turn.channel || 'unknown',
  });
}

/** Server-internal code (recovery, schedulers). Never derived from a request. */
export const SYSTEM_ACTOR: Actor = freeze({ kind: 'system' as const, role: 'none' as const });

function roleOfRow(row: { role: string; status?: string | null } | undefined): ActorRole {
  if (!row || row.status !== 'active' || !ROLES.has(row.role)) return 'none';
  return row.role as UserRole;
}

/**
 * Role of an active account, or 'none' (missing, inactive or unknown role).
 * Synchronous: SQLite only. On PostgreSQL there is no synchronous lookup, so
 * it fails closed ('none') instead of reading the SQLite file; callers that
 * can await use activeRoleAsync.
 */
function activeRole(userId: string): ActorRole {
  if (dbDriver() === 'postgres') return 'none';
  try {
    return roleOfRow(getDatabase().prepare('SELECT role, status FROM users WHERE id = ?').get(userId) as { role: string; status: string } | undefined);
  } catch {
    return 'none';
  }
}

/** activeRole on the configured driver (B2.2b). Any error -> 'none' (fails closed). */
export async function activeRoleAsync(userId: string): Promise<ActorRole> {
  if (dbDriver() !== 'postgres') return activeRole(userId);
  try {
    return roleOfRow(await pgOne<{ role: string; status: string }>('SELECT role, status FROM users WHERE id = ?', userId));
  } catch {
    return 'none';
  }
}

function buildToolActor(context: ToolExecutionContext | undefined, userId: string | undefined, role: ActorRole): Actor {
  return freeze({
    kind: 'agent' as const,
    role,
    ...(userId ? { userId } : {}),
    ...(context?.agentId ? { agentId: context.agentId } : {}),
    ...(context?.toolPolicy ? { channel: context.toolPolicy.channel } : {}),
    drawers: Object.freeze([...toolMemoryDrawers(context)]),
    ...(toolMemoryWriteKinds(context) ? { writeKinds: Object.freeze(toolMemoryWriteKinds(context)!) } : {}),
    ...(context?.taskRun?.runId ? { runId: context.taskRun.runId } : {}),
  });
}

const contextUserId = (context?: ToolExecutionContext): string | undefined =>
  typeof context?.userId === 'string' && context.userId ? context.userId : undefined;

/**
 * Actor of one tool call, from the run's trusted context only (the user,
 * agent, channel policy and drawers set by server code). Fails closed: no run
 * user -> no userId (every scoped repository call is refused).
 * Synchronous (role lookup on SQLite only, see activeRole).
 */
export function actorFromToolContext(context?: ToolExecutionContext): Actor {
  const userId = contextUserId(context);
  return buildToolActor(context, userId, userId ? activeRole(userId) : 'none');
}

/** actorFromToolContext with the role read on the configured driver (B2.2b; the tools registry uses this). */
export async function actorFromToolContextAsync(context?: ToolExecutionContext): Promise<Actor> {
  const userId = contextUserId(context);
  return buildToolActor(context, userId, userId ? await activeRoleAsync(userId) : 'none');
}

/** The tool call's actor: the one the registry attached, else built from the context. */
export function toolActor(context?: ToolExecutionContext): Actor {
  return context?.actor ?? actorFromToolContext(context);
}

/**
 * MEM-OWNER-01: the actor of a memory tool call. In a board task run the tool
 * user is the agent, but the memory belongs to the run's owner
 * (`accessOwnerId`): the same agent actor (agent id, channel, open drawers,
 * write kinds, run) for that owner, with the owner's role, so saves land as
 * the owner's memories with `source_agent_id` = the agent and important ones
 * become the owner's proposals, as in the owner's chats. Otherwise toolActor.
 */
export async function toolMemoryActor(context?: ToolExecutionContext): Promise<Actor> {
  const owner = typeof context?.accessOwnerId === 'string' && context.accessOwnerId ? context.accessOwnerId : undefined;
  const user = contextUserId(context);
  if (!owner || !user || owner === user) return toolActor(context);
  return buildToolActor(context, owner, await activeRoleAsync(owner));
}

/** Short label for logs/audit metadata (no secrets): `user:<id>`, `agent:<id>`, ... */
export function actorLabel(actor: Actor): string {
  if (actor.kind === 'agent') return `agent:${actor.agentId ?? 'unknown'}`;
  if (actor.kind === 'service') return `service:${actor.channel ?? 'unknown'}`;
  if (actor.kind === 'system') return 'system';
  return `user:${actor.userId}`;
}
