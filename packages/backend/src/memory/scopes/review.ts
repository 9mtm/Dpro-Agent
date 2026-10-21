/**
 * Review inbox at scale (MEM-GAPS-02): waiting reviews grouped by scope,
 * department or agent, and "accept all routine" with preview -> confirm.
 *
 * Routine = a waiting proposal that only asks because the owner reviews
 * every chat memory ('chat') or the scope's rules ask for routine facts too
 * ('scope-rule'): learned or agent-made, adds only, no conflict. Anything
 * important, a conflict, an import or a file edit is never in it.
 *
 * Accept all routine: the preview lists the proposals (id + reviewHash) and
 * its previewHash; the apply recomputes the list and refuses (409
 * preview_changed) when it differs, then approves each one with its own
 * reviewHash through the normal approve path (versioned). A proposal decided
 * meanwhile is skipped, never applied twice.
 *
 * A department's reviewer (scope rules) is shown on its group; the owner
 * still approves every decision.
 */

import { createHash } from 'node:crypto';
import { all, sql } from '../../repositories/sql-steps.js';
import { approveProposal, listPendingProposals, MemoryFileError, proposalSourceAgent, type MemoryProposal } from '../memory-files.js';
import { GENERAL_DEPARTMENT, ScopeInputError } from './store.js';

export const REVIEW_GROUP_BY = ['scope', 'department', 'agent'] as const;
export type ReviewGroupBy = (typeof REVIEW_GROUP_BY)[number];
/** Reasons that make a waiting proposal routine. */
export const ROUTINE_REVIEW_REASONS: ReadonlySet<string> = new Set(['chat', 'scope-rule']);
export const MAX_ACCEPT = 200;

export function isRoutineProposal(p: MemoryProposal): boolean {
  return p.status === 'pending' && !p.conflictWith && (p.source === 'learning' || p.source === 'agent')
    && p.reasons.length > 0 && p.reasons.every((r) => ROUTINE_REVIEW_REASONS.has(r))
    && p.changes.length > 0 && p.changes.every((c) => c.op === 'add');
}

/** Who made a proposal: an agent id, a coding app (`bridge:<client>`), the owner or another source. */
export function proposalMaker(p: Pick<MemoryProposal, 'createdBy' | 'userId'>): string {
  const agent = proposalSourceAgent(p.createdBy);
  if (agent) return `agent:${agent}`;
  if (/^bridge:[a-z0-9-]{1,40}$/.test(p.createdBy)) return p.createdBy;
  if (p.createdBy === p.userId) return 'owner';
  return /^[a-z][a-z_-]{0,31}$/.test(p.createdBy) ? p.createdBy : 'other';
}

export interface ReviewGroup {
  key: string;
  count: number;
  conflicts: number;
  routine: number;
  /** The department's reviewer agent (department groups, and project groups through their department). */
  reviewerAgentId: string | null;
  /** Oldest first, at most 200. */
  proposalIds: string[];
}

async function departments(ownerId: string): Promise<{ deptOf: Map<string, string>; reviewer: Map<string, string> }> {
  const rows = await sql().read(all<{ slug: string; department_id: string | null }>('SELECT slug, department_id FROM memory_project_scopes WHERE owner_id = ?', ownerId));
  const rules = await sql().read(all<{ scope_id: string; reviewer_agent_id: string | null }>(
    "SELECT scope_id, reviewer_agent_id FROM memory_scope_rules WHERE owner_id = ? AND scope_kind = 'department' AND reviewer_agent_id IS NOT NULL", ownerId)).catch(() => []);
  return {
    deptOf: new Map(rows.map((r) => [r.slug, r.department_id || GENERAL_DEPARTMENT])),
    reviewer: new Map(rules.map((r) => [r.scope_id, r.reviewer_agent_id!])),
  };
}

const departmentOf = (p: MemoryProposal, deptOf: Map<string, string>): string | null =>
  p.drawer.kind === 'project' ? deptOf.get(p.drawer.key || '') ?? GENERAL_DEPARTMENT : null;

/** Waiting reviews in groups, most waiting first. */
export async function reviewGroups(ownerId: string, byInput: unknown = 'scope'): Promise<{ by: ReviewGroupBy; total: number; groups: ReviewGroup[] }> {
  if (!(REVIEW_GROUP_BY as readonly unknown[]).includes(byInput)) throw new ScopeInputError(`by must be one of ${REVIEW_GROUP_BY.join(', ')}`);
  const by = byInput as ReviewGroupBy;
  const pending = await listPendingProposals(ownerId);
  const { deptOf, reviewer } = await departments(ownerId);
  const groups = new Map<string, ReviewGroup>();
  for (const p of pending) {
    const dept = departmentOf(p, deptOf);
    const key = by === 'scope' ? p.drawerId : by === 'department' ? (dept ? `department:${dept}` : 'company') : proposalMaker(p);
    let g = groups.get(key);
    if (!g) {
      g = { key, count: 0, conflicts: 0, routine: 0, reviewerAgentId: by === 'agent' ? null : (dept ? reviewer.get(dept) ?? null : null), proposalIds: [] };
      groups.set(key, g);
    }
    g.count++;
    if (p.conflictWith) g.conflicts++;
    if (isRoutineProposal(p)) g.routine++;
    if (g.proposalIds.length < 200) g.proposalIds.push(p.id);
  }
  return { by, total: pending.length, groups: [...groups.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)) };
}

export interface RoutineFilter { scope: string | null; agent: string | null }

export function parseRoutineFilter(body: Record<string, unknown>): RoutineFilter {
  const scope = body.scope === undefined || body.scope === null || body.scope === '' ? null : body.scope;
  if (scope !== null && (typeof scope !== 'string' || !/^(company|department:[A-Za-z0-9][A-Za-z0-9_-]{0,63}|owner|experience|(project|task|people):[A-Za-z0-9][A-Za-z0-9_.@-]{0,127})$/.test(scope))) {
    throw new ScopeInputError('scope must be a drawer id, company or department:<id>');
  }
  const agent = body.agent === undefined || body.agent === null || body.agent === '' ? null : body.agent;
  if (agent !== null && (typeof agent !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(agent))) throw new ScopeInputError('agent is invalid');
  return { scope: scope as string | null, agent: agent as string | null };
}

export interface RoutinePreview { filter: RoutineFilter; count: number; items: Array<{ id: string; drawerId: string; reviewHash: string }>; previewHash: string }

async function routineItems(ownerId: string, filter: RoutineFilter): Promise<RoutinePreview> {
  const pending = await listPendingProposals(ownerId);
  const { deptOf } = await departments(ownerId);
  const items = pending.filter(isRoutineProposal).filter((p) => {
    if (filter.agent && proposalMaker(p) !== `agent:${filter.agent}`) return false;
    if (!filter.scope) return true;
    if (filter.scope === 'company') return p.drawer.kind !== 'project';
    if (filter.scope.startsWith('department:')) return departmentOf(p, deptOf) === filter.scope.slice('department:'.length);
    return p.drawerId === filter.scope;
  }).slice(0, MAX_ACCEPT).map((p) => ({ id: p.id, drawerId: p.drawerId, reviewHash: p.reviewHash }));
  const previewHash = createHash('sha256').update(JSON.stringify(['accept-routine/v1', ownerId, filter, items])).digest('hex');
  return { filter, count: items.length, items, previewHash };
}

/** What "accept all routine" would approve (changes nothing). */
export function previewAcceptRoutine(ownerId: string, body: Record<string, unknown>): Promise<RoutinePreview> {
  return routineItems(ownerId, parseRoutineFilter(body));
}

/** Approve every routine proposal of the preview (same list, else 409). */
export async function acceptRoutine(ownerId: string, body: Record<string, unknown>, decidedBy: string): Promise<{ approved: string[]; skipped: Array<{ id: string; code: string }> }> {
  const filter = parseRoutineFilter(body);
  if (typeof body.expectedPreviewHash !== 'string' || !body.expectedPreviewHash) throw new ScopeInputError('expectedPreviewHash is required (preview first)', 400, 'preview_hash_required');
  const now = await routineItems(ownerId, filter);
  if (now.previewHash !== body.expectedPreviewHash) throw new ScopeInputError('The waiting reviews changed since the preview. Preview again.', 409, 'preview_changed');
  const approved: string[] = [];
  const skipped: Array<{ id: string; code: string }> = [];
  for (const item of now.items) {
    try {
      await approveProposal(ownerId, item.id, decidedBy, item.reviewHash);
      approved.push(item.id);
    } catch (err) {
      if (!(err instanceof MemoryFileError)) throw err;
      skipped.push({ id: item.id, code: err.code ?? 'error' });
    }
  }
  return { approved, skipped };
}

/** The departments an agent reviews, with their waiting reviews (ids and counts only). */
export async function assignedReviews(ownerId: string, agentId: string): Promise<ReviewGroup[]> {
  const { groups } = await reviewGroups(ownerId, 'department');
  return groups.filter((g) => g.reviewerAgentId === agentId);
}
