/**
 * Project lifecycle (MEM-SCALE-01): pin, unpin, archive, unarchive, move to
 * another department, merge into another project, forget all; and deleting
 * a department. Every action is preview -> apply: the preview says what
 * would change and returns a previewHash over the counts and the state it
 * saw; the apply (owner-confirmed) recomputes it and refuses with 409
 * preview_changed when anything moved meanwhile.
 *
 *  archive    kept, never loaded into a reply or recall (store.ts NOT_ARCHIVED_SQL)
 *  merge      memories move to the target drawer with their history; a memory
 *             whose topic key the target already uses becomes a conflict
 *             review on the target memory (keep new / keep old / keep both)
 *             instead of being written over it; pending reviews, graph
 *             project entity, pinned facts, conversations and handoff notes
 *             move; the source is archived as merged.
 *  move       changes the department (and so the inherited access)
 *  forget     CORE-07 forget of every memory of the drawer (tombstones only),
 *             plus its pinned facts, access rules, pending reviews and handoff notes
 *
 * Export is read-only: the drawer file (same format as CORE-04 exports),
 * the pinned facts and the handoff notes as Markdown files.
 */

import { createHash } from 'node:crypto';
import { all, one, run, sql, type Step } from '../../repositories/sql-steps.js';
import { getMemoryStorage } from '../storage.js';
import { forgetAll } from '../forget.js';
import { createChangeProposalStep, drawerRevision, exportDrawerFileIfPresent, renderDrawerFile } from '../memory-files.js';
import { recordBaselineIfMissingStep, recordVersionStep, versionEntryOf } from '../versions.js';
import { normalizeName } from '../graph/types.js';
import type { DrawerRef } from '../drawers.js';
import type { Memory } from '../types.js';
import { bumpAccessVersionStep, invalidateAccess, previewSnapshotEditStep } from './access.js';
import { invalidateScopeTree } from './tree.js';
import {
  GENERAL_DEPARTMENT, ScopeInputError, assertProjectSlug, departmentStep, listProjectsStep, projectStep, upsertProjectRowStep, type ProjectScope,
} from './store.js';

export const PROJECT_ACTIONS = ['pin', 'unpin', 'archive', 'unarchive', 'move', 'merge', 'forget'] as const;
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

export interface ActionInput { action: ProjectAction; target: string | null; departmentId: string | null }

export function parseActionInput(body: Record<string, unknown>): ActionInput {
  if (!(PROJECT_ACTIONS as readonly unknown[]).includes(body.action)) throw new ScopeInputError(`action must be one of ${PROJECT_ACTIONS.join(', ')}`);
  const action = body.action as ProjectAction;
  let target: string | null = null;
  let departmentId: string | null = null;
  if (action === 'merge') { assertProjectSlug(body.target); target = body.target; }
  if (action === 'move') {
    if (typeof body.departmentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(body.departmentId)) throw new ScopeInputError('departmentId is required');
    departmentId = body.departmentId;
  }
  return { action, target, departmentId };
}

const projectDrawer = (slug: string): DrawerRef => ({ kind: 'project', key: slug });

interface DrawerState { memories: number; last: string | null; topicKeys: Map<string, string> }
function* drawerStateStep(ownerId: string, slug: string): Step<DrawerState> {
  const s = yield* one<{ n: number; last: string | null }>("SELECT COUNT(*) AS n, MAX(created_at) AS last FROM memories WHERE user_id = ? AND drawer_kind = 'project' AND drawer_key = ?", ownerId, slug);
  const keys = yield* all<{ id: string; topic_key: string }>("SELECT id, topic_key FROM memories WHERE user_id = ? AND drawer_kind = 'project' AND drawer_key = ? AND topic_key IS NOT NULL", ownerId, slug);
  return { memories: Number(s?.n ?? 0), last: s?.last ?? null, topicKeys: new Map(keys.map((k) => [k.topic_key, k.id])) };
}

const countOf = function* (q: string, ...p: string[]): Step<number> { return Number((yield* one<{ n: number }>(q, ...p))?.n ?? 0); };

export interface ActionPreview {
  action: ProjectAction;
  project: ProjectScope;
  target?: ProjectScope;
  department?: { id: string; name: string };
  effects: Record<string, unknown>;
  previewHash: string;
}

function* previewStep(ownerId: string, slug: string, input: ActionInput): Step<ActionPreview> {
  assertProjectSlug(slug);
  const project = yield* projectStep(ownerId, slug);
  if (!project) throw new ScopeInputError('Project not found', 404, 'not_found');
  const src = yield* drawerStateStep(ownerId, slug);
  const scopeRow = yield* one<{ updated_at: string }>('SELECT updated_at FROM memory_project_scopes WHERE owner_id = ? AND slug = ?', ownerId, slug);
  const pinnedFacts = yield* countOf("SELECT COUNT(*) AS n FROM memory_pinned_facts WHERE owner_id = ? AND scope_kind = 'project' AND scope_id = ?", ownerId, slug);
  const accessRules = yield* countOf("SELECT COUNT(*) AS n FROM memory_access_rules WHERE owner_id = ? AND scope_kind = 'project' AND scope_id = ?", ownerId, slug);
  const pendingReviews = yield* countOf("SELECT COUNT(*) AS n FROM memory_file_proposals WHERE user_id = ? AND status = 'pending' AND drawer_kind = 'project' AND drawer_key = ?", ownerId, slug);
  const conversations = project.chatProjectId ? yield* countOf('SELECT COUNT(*) AS n FROM chat_sessions WHERE user_id = ? AND project_id = ?', ownerId, project.chatProjectId) : 0;
  const handoffs = project.chatProjectId ? yield* countOf('SELECT COUNT(*) AS n FROM agent_handoffs WHERE owner_id = ? AND project_id = ?', ownerId, project.chatProjectId) : 0;
  const effects: Record<string, unknown> = {};
  const stamp: unknown[] = [src.memories, src.last, scopeRow?.updated_at ?? null, pinnedFacts, accessRules, pendingReviews, conversations, handoffs];
  let target: ProjectScope | undefined;
  let department: { id: string; name: string } | undefined;

  switch (input.action) {
    case 'pin': case 'unpin':
      if (project.pinned === (input.action === 'pin')) throw new ScopeInputError(`The project is already ${input.action === 'pin' ? 'pinned' : 'not pinned'}`, 409, 'no_change');
      effects.pinned = input.action === 'pin';
      break;
    case 'archive':
      if (project.archived) throw new ScopeInputError('The project is already archived', 409, 'no_change');
      Object.assign(effects, { memories: src.memories, pinnedFacts, conversations, keptButNotLoaded: true });
      break;
    case 'unarchive':
      if (!project.archived) throw new ScopeInputError('The project is not archived', 409, 'no_change');
      Object.assign(effects, { memories: src.memories, loadedAgain: true });
      break;
    case 'move': {
      const d = yield* departmentStep(ownerId, input.departmentId!);
      if (!d) throw new ScopeInputError('Department not found', 404, 'not_found');
      if (d.id === project.departmentId) throw new ScopeInputError('The project is already in that department', 409, 'no_change');
      department = { id: d.id, name: d.name };
      // Inherited access changes with the department: count who is affected.
      const access = yield* previewSnapshotEditStep(ownerId, (s) => {
        if (d.id === GENERAL_DEPARTMENT) s.projectDept.delete(slug); else s.projectDept.set(slug, d.id);
        return s;
      }, [slug]);
      Object.assign(effects, { from: project.departmentId, to: d.id, memories: src.memories, agentsAffected: access.agentsAffected, widened: access.widened, narrowed: access.narrowed, sample: access.sample });
      break;
    }
    case 'merge': {
      if (input.target === slug) throw new ScopeInputError('A project cannot be merged into itself');
      const t = yield* projectStep(ownerId, input.target!);
      if (!t) throw new ScopeInputError('Target project not found', 404, 'not_found');
      if (t.archived) throw new ScopeInputError('The target project is archived; unarchive it first', 409, 'target_archived');
      target = t;
      const dst = yield* drawerStateStep(ownerId, t.slug);
      let topicConflicts = 0;
      for (const key of src.topicKeys.keys()) if (dst.topicKeys.has(key)) topicConflicts++;
      const entity = yield* one("SELECT 1 AS x FROM memory_graph_entities WHERE user_id = ? AND kind = 'project' AND norm_name = ?", ownerId, normalizeName(slug));
      Object.assign(effects, {
        memories: src.memories, moved: src.memories - topicConflicts, topicConflicts, pendingReviews, pinnedFacts,
        accessRulesRemoved: accessRules, graphEntity: !!entity,
        conversations: t.chatProjectId ? conversations : 0, conversationsKept: t.chatProjectId ? 0 : conversations,
        handoffs: t.chatProjectId ? handoffs : 0,
      });
      stamp.push(t.slug, dst.memories, dst.last, [...dst.topicKeys.keys()].sort().join(','), t.chatProjectId);
      break;
    }
    case 'forget': {
      const history = yield* countOf(`SELECT COUNT(DISTINCT memory_id) AS n FROM memory_versions WHERE user_id = ? AND drawer_kind = 'project' AND drawer_key = ?
        AND memory_id NOT IN (SELECT memory_id FROM memory_versions WHERE user_id = ? AND change = 'forget')`, ownerId, slug, ownerId);
      Object.assign(effects, { memories: src.memories, memoriesWithHistory: history, pinnedFacts, accessRules, pendingReviews, handoffs, irreversible: true });
      break;
    }
  }
  const previewHash = createHash('sha256').update(JSON.stringify({ ownerId, slug, input, effects, stamp })).digest('hex');
  return { action: input.action, project, ...(target ? { target } : {}), ...(department ? { department } : {}), effects, previewHash };
}

export function previewProjectAction(ownerId: string, slug: string, input: ActionInput): Promise<ActionPreview> {
  return sql().read(previewStep(ownerId, slug, input));
}

function checkHash(p: ActionPreview, expected: unknown): void {
  if (typeof expected !== 'string' || !expected) throw new ScopeInputError('expectedPreviewHash is required (preview the action first)', 400, 'preview_hash_required');
  if (p.previewHash !== expected) throw new ScopeInputError('The project changed since the preview. Preview again.', 409, 'preview_changed');
}

/** Merge the project entity of the source into the target's (graph links and mentions follow). */
function* mergeGraphEntityStep(ownerId: string, from: string, to: string): Step<boolean> {
  const src = yield* one<{ id: string }>("SELECT id FROM memory_graph_entities WHERE user_id = ? AND kind = 'project' AND norm_name = ?", ownerId, normalizeName(from));
  if (!src) return false;
  const dst = yield* one<{ id: string; kind: string }>('SELECT id, kind FROM memory_graph_entities WHERE user_id = ? AND norm_name = ?', ownerId, normalizeName(to));
  if (!dst) {
    yield* run('UPDATE memory_graph_entities SET name = ?, norm_name = ?, updated_at = ? WHERE id = ?', to, normalizeName(to), new Date().toISOString(), src.id);
    return true;
  }
  const links = yield* all<{ id: string; src_id: string; type: string; dst_id: string }>('SELECT id, src_id, type, dst_id FROM memory_graph_links WHERE user_id = ? AND (src_id = ? OR dst_id = ?)', ownerId, src.id, src.id);
  for (const l of links) {
    const a = l.src_id === src.id ? dst.id : l.src_id;
    const b = l.dst_id === src.id ? dst.id : l.dst_id;
    if (a === b) { yield* run('DELETE FROM memory_graph_links WHERE id = ?', l.id); continue; }
    const same = yield* one<{ id: string }>('SELECT id FROM memory_graph_links WHERE user_id = ? AND src_id = ? AND type = ? AND dst_id = ?', ownerId, a, l.type, b);
    if (same) {
      yield* run('INSERT INTO memory_graph_link_sources (link_id, memory_id, user_id) SELECT ?, memory_id, user_id FROM memory_graph_link_sources WHERE link_id = ? ON CONFLICT DO NOTHING', same.id, l.id);
      yield* run('DELETE FROM memory_graph_links WHERE id = ?', l.id);
    } else {
      yield* run('UPDATE memory_graph_links SET src_id = ?, dst_id = ? WHERE id = ?', a, b, l.id);
    }
  }
  yield* run('INSERT INTO memory_graph_mentions (memory_id, entity_id, user_id) SELECT memory_id, ?, user_id FROM memory_graph_mentions WHERE entity_id = ? ON CONFLICT DO NOTHING', dst.id, src.id);
  yield* run('DELETE FROM memory_graph_entities WHERE id = ?', src.id);
  return true;
}

interface MemRow { id: string; type: string; content: string; importance_score: number | null; topic_key: string | null; created_at: string }
const asMemory = (ownerId: string, r: MemRow, drawer: DrawerRef) => ({
  id: r.id, userId: ownerId, type: r.type, content: r.content, importanceScore: r.importance_score ?? 0.5, drawer, createdAt: new Date(r.created_at),
} as unknown as Memory);

function* mergeStep(ownerId: string, from: string, to: ProjectScope, fromChat: string | null, by: string, agentId: string): Step<Record<string, unknown>> {
  const fromD = projectDrawer(from);
  const toD = projectDrawer(to.slug);
  const dst = yield* drawerStateStep(ownerId, to.slug);
  const rows = yield* all<MemRow>("SELECT id, type, content, importance_score, topic_key, created_at FROM memories WHERE user_id = ? AND drawer_kind = 'project' AND drawer_key = ? ORDER BY created_at, id", ownerId, from);
  const reason = `merged from project:${from}`;
  const conflicts: string[] = [];
  let moved = 0;
  for (const r of rows) {
    const m = asMemory(ownerId, r, fromD);
    yield* recordBaselineIfMissingStep(m, by, reason);
    const holder = r.topic_key ? dst.topicKeys.get(r.topic_key) : undefined;
    if (holder) {
      // The target already holds this topic: never write over it; the owner decides.
      const old = yield* one<MemRow>('SELECT id, type, content, importance_score, topic_key, created_at FROM memories WHERE id = ?', holder);
      const proposal = yield* createChangeProposalStep({
        userId: ownerId, agentId, drawer: toD,
        changes: [{ op: 'update', id: holder, before: versionEntryOf(asMemory(ownerId, old!, toD)), after: versionEntryOf(m) }],
        source: 'learning', reasons: ['conflict', `conflicts-with:${holder}`, 'merge'], note: `Merged from project ${from}`,
        createdBy: by, conflictWith: holder, skipPendingLimit: true,
      });
      conflicts.push(proposal.id);
      yield* recordVersionStep({ memoryId: r.id, userId: ownerId, drawer: fromD, change: 'delete', entry: versionEntryOf(m), actor: by, reason: `${reason}; conflict review ${proposal.id}` });
      yield* run('DELETE FROM memories WHERE id = ? AND user_id = ?', r.id, ownerId);
    } else {
      yield* run("UPDATE memories SET drawer_key = ? WHERE id = ? AND user_id = ? AND drawer_kind = 'project'", to.slug, r.id, ownerId);
      yield* recordVersionStep({ memoryId: r.id, userId: ownerId, drawer: toD, change: 'update', entry: versionEntryOf(m), actor: by, reason });
      moved++;
    }
  }
  const reviews = (yield* run("UPDATE memory_file_proposals SET drawer_key = ? WHERE user_id = ? AND status = 'pending' AND drawer_kind = 'project' AND drawer_key = ? AND id NOT IN (" +
    (conflicts.length ? conflicts.map(() => '?').join(', ') : "''") + ')', to.slug, ownerId, from, ...conflicts)).changes;
  const graph = yield* mergeGraphEntityStep(ownerId, from, to.slug);
  const facts = (yield* run("UPDATE memory_pinned_facts SET scope_id = ?, position = position + 1000 WHERE owner_id = ? AND scope_kind = 'project' AND scope_id = ?", to.slug, ownerId, from)).changes;
  const rules = (yield* run("DELETE FROM memory_access_rules WHERE owner_id = ? AND scope_kind = 'project' AND scope_id = ?", ownerId, from)).changes;
  if (rules) yield* bumpAccessVersionStep(ownerId);
  let conversations = 0, handoffs = 0;
  if (fromChat && to.chatProjectId) {
    conversations = (yield* run('UPDATE chat_sessions SET project_id = ? WHERE user_id = ? AND project_id = ?', to.chatProjectId, ownerId, fromChat)).changes;
    handoffs = (yield* run('UPDATE agent_handoffs SET project_id = ? WHERE owner_id = ? AND project_id = ?', to.chatProjectId, ownerId, fromChat)).changes;
  }
  yield* upsertProjectRowStep(ownerId, to.slug, {}, by);
  yield* upsertProjectRowStep(ownerId, from, { archived_at: new Date().toISOString(), merged_into: to.slug, pinned: 0 }, by);
  return { moved, conflictReviews: conflicts, reviewsMoved: reviews, graphEntityMerged: graph, pinnedFactsMoved: facts, accessRulesRemoved: rules, conversationsMoved: conversations, handoffsMoved: handoffs };
}

/**
 * Apply a previewed action. `by` is the audit label (owner id or agent
 * actor); `proposalAgent` is the agent folder conflict reviews belong to.
 */
export async function applyProjectAction(ownerId: string, slug: string, input: ActionInput, expectedPreviewHash: unknown, by: string, proposalAgent = '(none)'): Promise<{ preview: ActionPreview; result: Record<string, unknown> }> {
  if (input.action === 'forget') {
    // CORE-07: forgetAll runs its own transactions; the hash check comes first.
    const preview = await previewProjectAction(ownerId, slug, input);
    checkHash(preview, expectedPreviewHash);
    const project = preview.project;
    const { forgotten } = await forgetAll(ownerId, by, projectDrawer(slug));
    const extra = await sql().tx(function* () {
      const cancelled = (yield* run(`UPDATE memory_file_proposals SET status = 'cancelled', changes = '[]', decided_by = ?, decided_at = ?, note = 'cancelled: the project was forgotten'
        WHERE user_id = ? AND status = 'pending' AND drawer_kind = 'project' AND drawer_key = ?`, by, new Date().toISOString(), ownerId, slug)).changes;
      const facts = (yield* run("DELETE FROM memory_pinned_facts WHERE owner_id = ? AND scope_kind = 'project' AND scope_id = ?", ownerId, slug)).changes;
      const rules = (yield* run("DELETE FROM memory_access_rules WHERE owner_id = ? AND scope_kind = 'project' AND scope_id = ?", ownerId, slug)).changes;
      if (rules) yield* bumpAccessVersionStep(ownerId);
      const handoffs = project.chatProjectId ? (yield* run('DELETE FROM agent_handoffs WHERE owner_id = ? AND project_id = ?', ownerId, project.chatProjectId)).changes : 0;
      const dept = yield* one<{ department_id: string | null }>('SELECT department_id FROM memory_project_scopes WHERE owner_id = ? AND slug = ?', ownerId, slug);
      yield* run('DELETE FROM memory_project_scopes WHERE owner_id = ? AND slug = ?', ownerId, slug);
      if (dept?.department_id) yield* bumpAccessVersionStep(ownerId);
      return { reviewsCancelled: cancelled, pinnedFactsRemoved: facts, accessRulesRemoved: rules, handoffsRemoved: handoffs };
    }, { immediate: true });
    invalidateScopeTree(ownerId);
    invalidateAccess(ownerId);
    return { preview, result: { forgotten, ...extra } };
  }

  const out = await sql().tx(function* () {
    const preview = yield* previewStep(ownerId, slug, input);
    checkHash(preview, expectedPreviewHash);
    let result: Record<string, unknown> = {};
    switch (input.action) {
      case 'pin': case 'unpin':
        yield* upsertProjectRowStep(ownerId, slug, { pinned: input.action === 'pin' ? 1 : 0 }, by);
        result = { pinned: input.action === 'pin' };
        break;
      case 'archive':
        yield* upsertProjectRowStep(ownerId, slug, { archived_at: new Date().toISOString(), pinned: 0 }, by);
        result = { archived: true };
        break;
      case 'unarchive':
        yield* upsertProjectRowStep(ownerId, slug, { archived_at: null, merged_into: null }, by);
        result = { archived: false };
        break;
      case 'move':
        yield* upsertProjectRowStep(ownerId, slug, { department_id: input.departmentId === GENERAL_DEPARTMENT ? null : input.departmentId }, by);
        yield* bumpAccessVersionStep(ownerId);
        result = { departmentId: input.departmentId };
        break;
      case 'merge':
        result = yield* mergeStep(ownerId, slug, preview.target!, preview.project.chatProjectId, by, proposalAgent);
        break;
    }
    return { preview, result };
  }, { immediate: true });
  invalidateScopeTree(ownerId);
  invalidateAccess(ownerId);
  if (input.action === 'merge') {
    // Readable drawer exports (where they exist) follow the move; best effort after the commit.
    for (const s of [slug, input.target!]) await exportDrawerFileIfPresent(ownerId, projectDrawer(s)).catch(() => []);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Department deletion: its projects go to General
// ---------------------------------------------------------------------------

function* departmentPreviewStep(ownerId: string, id: string) {
  if (id === GENERAL_DEPARTMENT) throw new ScopeInputError('The General department cannot be deleted');
  const d = yield* departmentStep(ownerId, id);
  if (!d) throw new ScopeInputError('Department not found', 404, 'not_found');
  const projects = (yield* listProjectsStep(ownerId)).filter((p) => p.departmentId === id).map((p) => p.slug);
  const pinnedFacts = yield* countOf("SELECT COUNT(*) AS n FROM memory_pinned_facts WHERE owner_id = ? AND scope_kind = 'department' AND scope_id = ?", ownerId, id);
  const accessRules = yield* countOf("SELECT COUNT(*) AS n FROM memory_access_rules WHERE owner_id = ? AND scope_kind = 'department' AND scope_id = ?", ownerId, id);
  const access = yield* previewSnapshotEditStep(ownerId, (s) => {
    for (const p of projects) s.projectDept.delete(p);
    s.rules = s.rules.filter((r) => !(r.scope_kind === 'department' && r.scope_id === id));
    return s;
  });
  const effects = { projectsToGeneral: projects.length, pinnedFactsRemoved: pinnedFacts, accessRulesRemoved: accessRules, agentsAffected: access.agentsAffected, widened: access.widened, narrowed: access.narrowed };
  const previewHash = createHash('sha256').update(JSON.stringify({ ownerId, id, name: d.name, projects, effects })).digest('hex');
  return { department: d, effects, previewHash };
}

export function previewDeleteDepartment(ownerId: string, id: string) {
  return sql().read(departmentPreviewStep(ownerId, id));
}

export async function deleteDepartment(ownerId: string, id: string, expectedPreviewHash: unknown) {
  const out = await sql().tx(function* () {
    const preview = yield* departmentPreviewStep(ownerId, id);
    if (typeof expectedPreviewHash !== 'string' || !expectedPreviewHash) throw new ScopeInputError('expectedPreviewHash is required (preview the deletion first)', 400, 'preview_hash_required');
    if (preview.previewHash !== expectedPreviewHash) throw new ScopeInputError('The department changed since the preview. Preview again.', 409, 'preview_changed');
    yield* run('UPDATE memory_project_scopes SET department_id = NULL WHERE owner_id = ? AND department_id = ?', ownerId, id);
    yield* run("DELETE FROM memory_pinned_facts WHERE owner_id = ? AND scope_kind = 'department' AND scope_id = ?", ownerId, id);
    yield* run("DELETE FROM memory_access_rules WHERE owner_id = ? AND scope_kind = 'department' AND scope_id = ?", ownerId, id);
    yield* run('DELETE FROM memory_departments WHERE owner_id = ? AND id = ?', ownerId, id);
    yield* bumpAccessVersionStep(ownerId);
    return preview;
  }, { immediate: true });
  invalidateScopeTree(ownerId);
  invalidateAccess(ownerId);
  return out;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function exportProject(ownerId: string, slug: string): Promise<{ project: ProjectScope; files: Array<{ name: string; content: string }> }> {
  assertProjectSlug(slug);
  const project = await sql().read(projectStep(ownerId, slug));
  if (!project) throw new ScopeInputError('Project not found', 404, 'not_found');
  const drawer = projectDrawer(slug);
  const memories = await getMemoryStorage().getByDrawers(ownerId, [drawer]);
  const files = [{ name: `project-${slug}-memory.md`, content: renderDrawerFile(drawer, memories, await drawerRevision(ownerId, drawer)) }];
  const facts = await sql().read(all<{ text: string }>("SELECT text FROM memory_pinned_facts WHERE owner_id = ? AND scope_kind = 'project' AND scope_id = ? ORDER BY position, created_at, id", ownerId, slug));
  files.push({ name: `project-${slug}-pinned-facts.md`, content: [`# Pinned facts: ${project.name}`, '', ...(facts.length ? facts.map((f) => `- ${f.text}`) : ['(none)']), ''].join('\n') });
  if (project.chatProjectId) {
    const notes = await sql().read(all<{ agent_id: string; scope_kind: string; scope_id: string; version: number; done: string; remaining: string; next_steps: string; open_questions: string; created_at: string }>(
      `SELECT h.agent_id, h.scope_kind, h.scope_id, h.version, h.done, h.remaining, h.next_steps, h.open_questions, h.created_at FROM agent_handoffs h
        WHERE h.owner_id = ? AND h.project_id = ? AND h.version = (SELECT MAX(x.version) FROM agent_handoffs x WHERE x.owner_id = h.owner_id AND x.agent_id = h.agent_id AND x.scope_kind = h.scope_kind AND x.scope_id = h.scope_id)
        ORDER BY h.created_at DESC`, ownerId, project.chatProjectId));
    const list = (title: string, json: string) => { let v: unknown; try { v = JSON.parse(json); } catch { v = []; } const a = Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; return a.length ? [`${title}:`, ...a.map((x) => `- ${x}`)] : []; };
    files.push({
      name: `project-${slug}-handoffs.md`,
      content: [`# Handoff notes: ${project.name}`, '', ...(notes.length ? notes.flatMap((n) => [`## ${n.agent_id} (${n.scope_kind} ${n.scope_id}, v${n.version}, ${n.created_at})`,
        ...list('Done', n.done), ...list('Left', n.remaining), ...list('Next', n.next_steps), ...list('Open questions', n.open_questions), '']) : ['(none)', ''])].join('\n'),
    });
  }
  return { project, files };
}
