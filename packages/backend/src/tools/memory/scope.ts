/**
 * Memory scope of a tool run (CORE-03).
 *
 * The user is always the run's user (context.userId; in a board task run its
 * owner, context.accessOwnerId), never a model-supplied `userId` parameter.
 * The drawers are the ones selected for the turn (context.memoryDrawers, see
 * memory/drawers.ts selectDrawers). Without a run
 * user nothing is read or written. Without a
 * selection, the user's own owner + experience drawers are used. A channel
 * turn (an outsider is answered) reads no drawers unless the server opted in
 * with OUTSIDER_AGENT_MEMORY=true (S0-A.14).
 */

import type { ToolExecutionContext } from '../types.js';
import { MAX_PEOPLE_DRAWERS, normalizeDrawer, sameDrawer, selectDrawers, type DrawerRef } from '../../memory/drawers.js';
import { outsiderAgentMemoryEnabled } from '../../services/outsider-memory.js';

/**
 * The run's memory owner, or null (fail closed). A `userId` in tool params is
 * never used. MEM-OWNER-01: a board task run's memory belongs to the run's
 * owner (`accessOwnerId`; its tool user is the agent), else the run's user.
 */
export function toolMemoryUser(context?: ToolExecutionContext): string | null {
  if (typeof context?.userId !== 'string' || !context.userId) return null; // no run user: nothing (also with an owner)
  return typeof context.accessOwnerId === 'string' && context.accessOwnerId ? context.accessOwnerId : context.userId;
}

/**
 * MEM-OWNER-01: false in a run for the owner without the owner's own turn (a
 * board task run). Owner-only memory tools (review, graph, scopes, doctor,
 * move, recall trace) stay refused there, as before.
 */
export function toolOwnerTurn(context?: ToolExecutionContext): boolean {
  return !context?.accessOwnerId || context.accessOwnerId === context.userId;
}

/** Narrowness order used to pick the drawer a derived memory is saved into. */
const NARROWEST: ReadonlyArray<DrawerRef['kind']> = ['task', 'people', 'project', 'experience', 'owner'];

/** The narrowest of the given drawers (e.g. task before project before owner), or null. */
export function narrowestDrawer(drawers: readonly DrawerRef[]): DrawerRef | null {
  for (const kind of NARROWEST) {
    const d = drawers.find((x) => x.kind === kind);
    if (d) return d;
  }
  return null;
}

export function toolMemoryDrawers(context?: ToolExecutionContext): DrawerRef[] {
  if (context?.toolPolicy && !outsiderAgentMemoryEnabled()) return selectDrawers({ audience: 'outsider' });
  const drawers = context?.memoryDrawers ?? selectDrawers({ audience: 'owner' });
  // CORE-PERMS-01: only the drawer kinds the owner lets this agent read.
  const read = context?.permissions?.memoryRead;
  return read ? drawers.filter((d) => read.includes(d.kind)) : drawers;
}

/** CORE-PERMS-01: drawer kinds the agent may write, or undefined (no limit beyond the open drawers). */
export function toolMemoryWriteKinds(context?: ToolExecutionContext): DrawerRef['kind'][] | undefined {
  return context?.permissions ? [...context.permissions.memoryWrite] : undefined;
}

/** At most this many drawers are kept in an approval's stored run scope. */
export const MAX_APPROVAL_DRAWERS = 4 + MAX_PEOPLE_DRAWERS;

/**
 * Drawers an approved tool call re-runs with (CORE-07b): exactly the drawers
 * stored with the approval at request time, intersected with what the
 * policies allow now. A channel/outsider policy (without the server opt-in)
 * allows none; invalid or duplicate entries are dropped; at most 10 people
 * drawers and MAX_APPROVAL_DRAWERS in total. Never wider than the stored
 * list; not a list -> none (fail closed).
 */
export function approvalRunDrawers(stored: unknown, context: Pick<ToolExecutionContext, 'toolPolicy'>): DrawerRef[] {
  if (!Array.isArray(stored)) return [];
  if (context.toolPolicy && !outsiderAgentMemoryEnabled()) return [];
  const out: DrawerRef[] = [];
  let people = 0;
  for (const raw of stored) {
    let d: DrawerRef;
    try { d = normalizeDrawer(raw); } catch { continue; }
    if (out.some((x) => sameDrawer(x, d))) continue;
    if (d.kind === 'people' && ++people > MAX_PEOPLE_DRAWERS) continue;
    out.push(d);
    if (out.length >= MAX_APPROVAL_DRAWERS) break;
  }
  return out;
}
