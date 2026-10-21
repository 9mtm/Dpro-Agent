/**
 * Review tools: the owner's review inbox from a chat with an agent.
 *
 * memory_review          read only: pending conflict proposals (CORE-MEM-CONFLICT)
 *                        in the drawers open for the run, with the old and the new
 *                        text and the reviewHash the decision must carry
 * memory_review_decide   keep_new / keep_old / keep_both on one conflict proposal.
 *                        Every call needs one-time owner approval (approvals.ts);
 *                        the approval is the explicit confirm, and the reviewHash
 *                        makes it apply only to what was shown (409 otherwise).
 * memory_review ops (MEM-GAPS-02): groups (waiting reviews by scope /
 *                        department / agent, counts only), assigned (the
 *                        departments this agent reviews), preview_routine
 *                        (what "accept all routine" would approve: ids only).
 * memory_review_routine  accept every routine review of a preview (scope /
 *                        agent filter + previewHash). Every call needs one-time
 *                        owner approval.
 * memory_graph_review    approve / reject one pending knowledge-graph link
 *                        (CORE-MEM-GRAPH; list them with memory_graph op "pending").
 *                        Every call needs one-time owner approval.
 *
 * Same gates as the owner-only review API: the run user is the owner
 * account, never a turn that answers an outsider, only proposals and links
 * of drawers open for the run (and a decision that changes a memory only in
 * drawers the agent may write, CORE-PERMS-01).
 */

import type { Tool, ToolResult, ToolExecutionContext } from '../types.js';
import { toolMemoryDrawers, toolMemoryUser, toolMemoryWriteKinds } from './scope.js';
import { one, sql } from '../../repositories/sql-steps.js';
import { repositories } from '../../repositories/index.js';
import { toolActor } from '../../repositories/actor.js';
import { drawerId } from '../../memory/drawers.js';
import { CONFLICT_DECISIONS, MemoryFileError, decideConflict, listProposals, type MemoryProposal } from '../../memory/memory-files.js';
import { decideLink, listLinks } from '../../memory/graph/index.js';
import { ScopeInputError, acceptRoutine, assignedReviews, previewAcceptRoutine, reviewGroups } from '../../memory/scopes/index.js';

const fail = (tool: string, msg: string): ToolResult => ({ content: [{ type: 'text', text: `${tool} refused: ${msg}` }], error: msg });
const ok = (text: string, data: Record<string, unknown>): ToolResult => ({ content: [{ type: 'text', text }], data: { success: true, ...data } } as ToolResult);
/** The run's review view: open drawers, and the drawer kinds it may write (MEM-GAPS-02). */
const runLimit = (context?: ToolExecutionContext) => {
  const write = toolMemoryWriteKinds(context);
  return { drawers: toolMemoryDrawers(context).map(drawerId), ...(write ? { writeKinds: write } : {}) };
};
const oneLine = (s: string, n = 300) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The owner's id when this is the owner's own turn, else a refusal text. */
export async function reviewOwner(context?: ToolExecutionContext): Promise<string | { refused: string }> {
  const userId = toolMemoryUser(context);
  if (!userId) return { refused: 'no user for this memory' };
  if (context?.toolPolicy) return { refused: 'not available when answering someone else' };
  const row = await sql().read(one<{ role: string }>('SELECT role FROM users WHERE id = ?', userId));
  if (row?.role !== 'owner') return { refused: 'only for the owner' };
  return userId;
}

function audit(context: ToolExecutionContext | undefined, action: string, resourceType: string, resourceId: string, metadata: Record<string, unknown>) {
  void repositories.audit.record(toolActor(context), {
    event_type: 'data.update', event_category: 'data_modification', severity: 'info',
    resource_type: resourceType, resource_id: resourceId, action, success: true, metadata: { ...metadata, via: 'agent_tool' },
  });
}

interface ConflictView { id: string; drawer: string; memoryId: string; oldText: string; newText: string; reviewHash: string; createdAt: string }

function conflictView(p: MemoryProposal): ConflictView | null {
  const c = p.changes[0];
  if (!p.conflictWith || !c || c.op !== 'update') return null;
  return { id: p.id, drawer: p.drawerId, memoryId: p.conflictWith, oldText: oneLine(c.before.content), newText: oneLine(c.after.content), reviewHash: p.reviewHash, createdAt: p.createdAt };
}

/** Pending conflicts in the run's open drawers. */
async function openConflicts(userId: string, context?: ToolExecutionContext): Promise<ConflictView[]> {
  const open = new Set(toolMemoryDrawers(context).map(drawerId));
  return (await listProposals(userId, 'pending'))
    .filter((p) => p.conflictWith && open.has(p.drawerId))
    .map(conflictView)
    .filter((v): v is ConflictView => v !== null);
}

export const memoryReviewTool: Tool = {
  name: 'memory_review',
  description: `List memory conflicts waiting for the owner (read only): a newly learned fact that contradicts a saved one.
Each item shows the saved text, the new text, the proposal id and its reviewHash.
To decide one, call memory_review_decide (keep_new, keep_old or keep_both) with that id and reviewHash; the owner approves the call.
Only the memory drawers open for this conversation are read.`,
  input_schema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['conflicts', 'groups', 'assigned', 'preview_routine'], description: 'conflicts (default); groups: waiting reviews by scope / department / agent (counts; drawers open here only); assigned: departments you review; preview_routine: what "accept all routine" would approve' },
      by: { type: 'string', enum: ['scope', 'department', 'agent'], description: 'groups: how to group' },
      scope: { type: 'string', description: 'preview_routine: a drawer id, company or department:<id>' },
      agent: { type: 'string', description: 'preview_routine: only reviews this agent made' },
      limit: { type: 'number', minimum: 1, maximum: 50, description: 'Maximum items (default 20)' },
    },
  },
  async execute(params: { op?: unknown; by?: unknown; scope?: unknown; agent?: unknown; limit?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    const owner = await reviewOwner(context);
    if (typeof owner !== 'string') return fail('memory_review', owner.refused);
    try {
      if (params?.op === 'groups') {
        const g = await reviewGroups(owner, params.by ?? 'scope', runLimit(context));
        const text = g.groups.length
          ? g.groups.map((x) => `- ${x.key}: ${x.count} waiting (${x.conflicts} conflicts, ${x.routine} routine)${x.reviewerAgentId ? `, reviewer ${x.reviewerAgentId}` : ''}`).join('\n')
          : 'Nothing waiting for review.';
        return ok(text, g as unknown as Record<string, unknown>);
      }
      if (params?.op === 'assigned') {
        const groups = context?.agentId ? await assignedReviews(owner, context.agentId, runLimit(context)) : [];
        const text = groups.length ? groups.map((x) => `- ${x.key}: ${x.count} waiting (${x.conflicts} conflicts, ${x.routine} routine)`).join('\n') : 'You review no department, or nothing waits there.';
        return ok(text, { groups });
      }
      if (params?.op === 'preview_routine') {
        const p = await previewAcceptRoutine(owner, { scope: params.scope, agent: params.agent }, runLimit(context));
        return ok(`${p.count} routine review(s) would be accepted. To accept them, call memory_review_routine with the same scope/agent and previewHash ${p.previewHash} (the owner approves the call).`, p as unknown as Record<string, unknown>);
      }
    } catch (err) {
      if (err instanceof ScopeInputError) return fail('memory_review', err.message);
      throw err;
    }
    const limit = typeof params?.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(params.limit))) : 20;
    const items = (await openConflicts(owner, context)).slice(0, limit);
    const text = items.length
      ? items.map((c, i) => `${i + 1}. [${c.drawer}] saved: "${c.oldText}" — new: "${c.newText}" (proposal ${c.id}, reviewHash ${c.reviewHash})`).join('\n')
      : 'No memory conflicts waiting in the open drawers.';
    return ok(text, { conflicts: items });
  },
};

export const memoryReviewDecideTool: Tool = {
  name: 'memory_review_decide',
  description: `Decide one memory conflict after the owner approves this call.
decision: keep_new (the saved memory gets the new text as a new version), keep_old (nothing changes),
keep_both (the new text is saved as its own memory). Give the proposal id and the reviewHash from memory_review;
if the proposal changed since, nothing happens.`,
  input_schema: {
    type: 'object',
    properties: {
      proposal_id: { type: 'string', description: 'Proposal id from memory_review' },
      decision: { type: 'string', enum: [...CONFLICT_DECISIONS] },
      review_hash: { type: 'string', description: 'reviewHash from memory_review' },
      note: { type: 'string', description: 'Optional note kept with the decision' },
    },
    required: ['proposal_id', 'decision', 'review_hash'],
  },
  async execute(params: { proposal_id?: unknown; decision?: unknown; review_hash?: unknown; note?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    const owner = await reviewOwner(context);
    if (typeof owner !== 'string') return fail('memory_review_decide', owner.refused);
    if (typeof params.proposal_id !== 'string' || !params.proposal_id) return fail('memory_review_decide', 'proposal_id is required');
    const c = (await openConflicts(owner, context)).find((x) => x.id === params.proposal_id);
    if (!c) return fail('memory_review_decide', 'no pending conflict with that id in the open drawers');
    const write = toolMemoryWriteKinds(context);
    const kind = c.drawer.split(':')[0];
    if (params.decision !== 'keep_old' && write && !write.includes(kind as never)) return fail('memory_review_decide', `this agent may not write the ${kind} drawer`);
    try {
      // The owner's approval of this call is the explicit confirm; the review hash binds it to what was shown.
      const r = await decideConflict(owner, c.id, params.decision, `agent:${context?.agentId ?? 'unknown'}`, params.review_hash, params.note);
      audit(context, 'memory_proposal.decide', 'memory_proposal', c.id, { decision: r.decision });
      const what = r.decision === 'keep_new' ? 'The saved memory now has the new text (the old one is kept in its history).'
        : r.decision === 'keep_both' ? 'The new text was saved as its own memory; the old one stays.' : 'Nothing changed; the new text was dropped.';
      return ok(`Conflict decided: ${r.decision}. ${what}`, { proposalId: c.id, decision: r.decision, status: r.proposal.status });
    } catch (err) {
      if (err instanceof MemoryFileError) return fail('memory_review_decide', err.message);
      throw err;
    }
  },
};

export const memoryReviewRoutineTool: Tool = {
  name: 'memory_review_routine',
  description: `Accept every routine review waiting for the owner (facts that only wait because the owner reviews chat memories,
or because a scope's rules ask for routine facts too), after the owner approves this call. Give the same scope / agent and
the previewHash from memory_review op "preview_routine"; if the waiting reviews changed since, nothing happens. Conflicts,
important facts, imports and file edits are never accepted this way.`,
  input_schema: {
    type: 'object',
    properties: {
      scope: { type: 'string', description: 'A drawer id, company or department:<id> (optional)' },
      agent: { type: 'string', description: 'Only reviews this agent made (optional)' },
      preview_hash: { type: 'string', description: 'previewHash from memory_review op "preview_routine"' },
    },
    required: ['preview_hash'],
  },
  async execute(params: { scope?: unknown; agent?: unknown; preview_hash?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    const owner = await reviewOwner(context);
    if (typeof owner !== 'string') return fail('memory_review_routine', owner.refused);
    try {
      // The owner's approval of this call is the explicit confirm; the previewHash binds it to the list shown.
      const out = await acceptRoutine(owner, { scope: params.scope, agent: params.agent, expectedPreviewHash: params.preview_hash }, `agent:${context?.agentId ?? 'unknown'}`, runLimit(context));
      audit(context, 'memory_proposal.accept_routine', 'memory_proposal', owner, { approved: out.approved.length, skipped: out.skipped.length });
      return ok(`Accepted ${out.approved.length} routine review(s)${out.skipped.length ? `; ${out.skipped.length} changed meanwhile and were left` : ''}.`, out as unknown as Record<string, unknown>);
    } catch (err) {
      if (err instanceof ScopeInputError) return fail('memory_review_routine', err.message);
      throw err;
    }
  },
};

export const memoryGraphReviewTool: Tool = {
  name: 'memory_graph_review',
  description: `Approve or reject one knowledge-graph link that waits for the owner (list them with memory_graph op "pending"),
after the owner approves this call. approve: recall may use the link; reject: it is never used and never suggested again.`,
  input_schema: {
    type: 'object',
    properties: {
      link_id: { type: 'string', description: 'Link id from memory_graph op "pending"' },
      decision: { type: 'string', enum: ['approve', 'reject'] },
    },
    required: ['link_id', 'decision'],
  },
  async execute(params: { link_id?: unknown; decision?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    const owner = await reviewOwner(context);
    if (typeof owner !== 'string') return fail('memory_graph_review', owner.refused);
    if (params.decision !== 'approve' && params.decision !== 'reject') return fail('memory_graph_review', 'decision must be approve or reject');
    if (typeof params.link_id !== 'string' || !params.link_id) return fail('memory_graph_review', 'link_id is required');
    // Only a pending link that comes from a memory of the open drawers.
    const pending = await listLinks({ userId: owner, drawers: toolMemoryDrawers(context) }, { status: 'pending', limit: 1000 });
    const link = pending.find((l) => l.id === params.link_id);
    if (!link) return fail('memory_graph_review', 'no pending link with that id in the open drawers');
    const res = await decideLink(owner, link.id, params.decision, `agent:${context?.agentId ?? 'unknown'}`);
    if (!res) return fail('memory_graph_review', 'the link is no longer pending');
    audit(context, `memory_graph.link_${params.decision}`, 'memory_graph_link', link.id, {});
    return ok(`Link "${link.from.name} ${link.type} ${link.to.name}" ${res.status === 'active' ? 'approved' : 'rejected'}.`, { link: res });
  },
};
