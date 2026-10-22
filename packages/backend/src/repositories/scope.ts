/**
 * Central scope rules for the repositories (B1-core).
 *
 * One place answers "may this actor touch this record?" for identity,
 * credentials, agents, memory, task runs and audit. Routes and tools call the
 * repositories; the repositories call these rules. The auth gate's route tiers
 * (S0-A) stay in front as the first line.
 *
 * Rules (fail closed, unknown -> denied):
 *  - system  : everything (server code only).
 *  - user    : guest -> only their own identity; user -> own records;
 *              admin -> own records + admin areas (audit read, own
 *              credentials); owner -> owner-wide areas (every user's task
 *              runs and credentials (masked), agents, audit config).
 *  - agent   : only the run's own user, never owner-wide (even when that user
 *              is the owner); memory only in the run's open drawers (in a
 *              channel turn: only memory, as the outsider policy allows); no
 *              permission/config changes (grants, personality, credentials,
 *              audit config). May record audit entries for its own user.
 *  - service : a channel turn; no stored data at all, may record audit.
 *
 * Denials carry the status the routes already used: 401 no actor, 403 wrong
 * role/kind, 404 a record outside the actor's scope (never reveal it exists).
 */

import type { FastifyReply } from 'fastify';
import type { Actor } from './actor.js';
import { sameDrawer, type DrawerRef } from '../memory/drawers.js';

export class ScopeError extends Error {
  constructor(readonly status: 401 | 403 | 404, message: string, readonly code = status === 404 ? 'not_found' : status === 401 ? 'unauthenticated' : 'forbidden') {
    super(message);
  }
}

export const MSG = {
  auth: 'Authentication required',
  guest: 'Guest accounts can only use public rooms',
  owner: 'This action requires the owner account',
  admin: 'This action requires an owner or admin account',
  agent: 'Not available to an agent run',
  service: 'Not available to a channel turn',
} as const;

export function isSystem(actor: Actor | null | undefined): boolean {
  return actor?.kind === 'system';
}

export function isOwner(actor: Actor | null | undefined): boolean {
  return actor?.kind === 'user' && actor.role === 'owner';
}

export function isAdminOrOwner(actor: Actor | null | undefined): boolean {
  return actor?.kind === 'user' && (actor.role === 'owner' || actor.role === 'admin');
}

/** Present actor, else 401. */
export function requireActor(actor: Actor | null | undefined): Actor {
  if (!actor) throw new ScopeError(401, MSG.auth);
  return actor;
}

/** A signed-in non-guest account (owner/admin/user), or system. */
export function requireMember(actor: Actor | null | undefined): Actor {
  const a = requireActor(actor);
  if (a.kind === 'system') return a;
  if (a.kind === 'agent') throw new ScopeError(403, MSG.agent);
  if (a.kind === 'service') throw new ScopeError(403, MSG.service);
  if (a.role === 'guest') throw new ScopeError(403, MSG.guest);
  if (a.role !== 'owner' && a.role !== 'admin' && a.role !== 'user') throw new ScopeError(403, MSG.auth);
  if (!a.userId) throw new ScopeError(401, MSG.auth);
  return a;
}

/** The owner account, or system. */
export function requireOwner(actor: Actor | null | undefined): Actor {
  const a = requireMember(actor);
  if (a.kind === 'system' || a.role === 'owner') return a;
  throw new ScopeError(403, MSG.owner);
}

/** Owner or admin account, or system. */
export function requireAdmin(actor: Actor | null | undefined): Actor {
  const a = requireMember(actor);
  if (a.kind === 'system' || a.role === 'owner' || a.role === 'admin') return a;
  throw new ScopeError(403, MSG.admin);
}

/** A signed-in account incl. guest (own identity only), or system. */
export function requireAccount(actor: Actor | null | undefined): Actor {
  const a = requireActor(actor);
  if (a.kind === 'system') return a;
  if (a.kind !== 'user') throw new ScopeError(403, a.kind === 'agent' ? MSG.agent : MSG.service);
  if (!a.userId || a.role === 'none') throw new ScopeError(401, MSG.auth);
  return a;
}

/**
 * A member account or an agent run with a user: the user whose own records
 * the actor may reach. Service actors, agent runs without an active user and
 * (unless allowOutsider) agent runs inside a channel turn are refused.
 */
export function requireOwnUser(actor: Actor | null | undefined, opts: { allowOutsider?: boolean } = {}): Actor {
  const a = requireActor(actor);
  if (a.kind === 'system') return a;
  if (a.kind === 'service') throw new ScopeError(403, MSG.service);
  if (a.kind === 'agent') {
    // An agent run inside a channel turn answers an outsider: only areas
    // that apply their own outsider policy (memory drawers) let it through.
    if (a.channel && !opts.allowOutsider) throw new ScopeError(403, MSG.service);
    // The run's user must be an active account (any role: a guest's run
    // still only reaches that guest's own records, as before B1-core).
    if (!a.userId || a.role === 'none') throw new ScopeError(403, MSG.agent);
    return a;
  }
  return requireMember(a);
}

/**
 * Owner-wide read over a per-user table: undefined = every user (owner as a
 * user account, or system); otherwise the actor's own user id.
 */
export function ownerWideUserFilter(actor: Actor): string | undefined {
  if (actor.kind === 'system' || isOwner(actor)) return undefined;
  return actor.userId;
}

/**
 * May the actor see a record owned by `recordUserId`?
 * ownerWide: the owner (user account) sees every user's record.
 */
export function canSeeRecord(actor: Actor, recordUserId: string | null | undefined, opts: { ownerWide?: boolean; ownerSeesUnowned?: boolean } = {}): boolean {
  if (actor.kind === 'system') return true;
  if (actor.kind === 'service') return false;
  if (actor.kind === 'user' && actor.role === 'guest') return false;
  if (opts.ownerWide && isOwner(actor)) return true;
  if (!recordUserId) return !!opts.ownerSeesUnowned && isOwner(actor);
  return !!actor.userId && recordUserId === actor.userId;
}

/** The record or a 404 with `message` (outside the actor's scope looks like missing). */
export function inScopeOr404<T>(value: T | null | undefined, visible: boolean, message: string): T {
  if (value === null || value === undefined || !visible) throw new ScopeError(404, message);
  return value;
}

/** CORE-PERMS-01: for agent runs, open for this run AND a kind the owner lets it write. Other actors: always true. */
export function drawerWritable(actor: Actor, drawer: DrawerRef): boolean {
  if (actor.kind !== 'agent') return true;
  return drawerOpen(actor, drawer) && !(actor.drawers??[]).some(d=>sameDrawer(d,drawer)&&d.readOnly===true) && (!actor.writeKinds || actor.writeKinds.includes(drawer.kind));
}

/** For agent runs: is the drawer open for this run? Other actors: always true. */
export function drawerOpen(actor: Actor, drawer: DrawerRef): boolean {
  if (actor.kind !== 'agent') return true;
  return (actor.drawers ?? []).some((d) => sameDrawer(d, drawer));
}

/** Send a ScopeError as the route's usual `{ error }` body; rethrow anything else. */
export function sendScopeError(reply: FastifyReply, err: unknown) {
  if (err instanceof ScopeError) return reply.code(err.status).send({ error: err.message });
  throw err;
}

/**
 * Route helper: run a scope rule on the request's actor; on denial send the
 * usual `{ error }` and return null. Used before input validation so the
 * answer order (401/403 before 400) stays as it was.
 */
export function actorOrReply(
  reply: FastifyReply,
  actor: Actor | null | undefined,
  rule: (actor: Actor | null | undefined) => Actor,
): Actor | null {
  try {
    return rule(actor);
  } catch (err) {
    if (err instanceof ScopeError) { reply.code(err.status).send({ error: err.message }); return null; }
    throw err;
  }
}
