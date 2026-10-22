/**
 * Memory recall, learning and layers (B1.6, part of the memory repository).
 * Scope rules (scope.ts, memory-actor.ts):
 *
 *   search / relevant / learn / change / stats / saveDerived
 *       a member account: its OWN memories (drawers as asked, none = all);
 *       an agent run: its run user's memories and only the drawers open for
 *       the run (asked drawers are intersected with them; an outsider turn
 *       has none unless OUTSIDER_AGENT_MEMORY=true); learned items from a
 *       turn that answers an outsider are never auto-saved (origin outsider).
 *   summary / consolidateDuplicates / extract / layerStats / promote /
 *   promotionCandidates / setImportanceScore
 *       member accounts only, on their own memory (routes).
 *   runConsolidation / consolidationLog
 *       the owner account (server-wide maintenance across every user).
 *
 * Guests and channel turns: refused. Out of scope -> 404 `Memory not found`;
 * a closed drawer for an agent run -> 403.
 *
 * One implementation for both drivers (SQL steps) over memory/storage.ts, retrieval.ts, learning.ts
 * and services/memory-tiers.ts / memory-consolidation.ts.
 */

import type { Actor } from './actor.js';
import { ScopeError, drawerOpen, drawerWritable, requireOwner } from './scope.js';
import { memberUser, memoryUser, versionActor } from './memory-actor.js';
import { all, one, sql } from './sql-steps.js';
import { getMemoryStorage } from '../memory/storage.js';
import { getMemoryRetrieval } from '../memory/retrieval.js';
import { withGraphRecall } from '../memory/graph/recall.js';
import { archivedProjects } from '../memory/scopes/store.js';
import { defaultDrawerForType, drawerSqlFilter, normalizeDrawer, sameDrawer, type DrawerRef } from '../memory/drawers.js';
import { agentChange, learn, type AgentChangeResult, type LearnOutcome, type LearningCandidate } from '../memory/learning.js';
import { MemoryTiersService } from '../services/memory-tiers.js';
import { getConsolidationService } from '../services/memory-consolidation.js';
import type { Memory, MemorySearchQuery, MemorySearchResult } from '../memory/types.js';

const NOT_FOUND = 'Memory not found';
/** Same wording the memory tools used before B1-core. */
const DRAWER_CLOSED = 'that memory drawer is not open for this conversation';

export interface MemoryStats {
  total: number;
  highImportance: number;
  byType: Array<{ type: string; n: number }>;
  topTags: Array<[string, number]>;
  oldest: string | null;
  newest: string | null;
}

export interface MemoryRecallRepository {
  /** Search own memory; `drawers` narrows it (agent runs: never wider than the open drawers). */
  search(actor: Actor | null | undefined, query: Omit<MemorySearchQuery, 'userId'>): Promise<MemorySearchResult[]>;
  relevant(actor: Actor | null | undefined, query: string, limit: number, drawers?: DrawerRef[]): Promise<Memory[]>;
  summary(actor: Actor | null | undefined): Promise<Awaited<ReturnType<ReturnType<typeof getMemoryRetrieval>['getSummary']>>>;
  consolidateDuplicates(actor: Actor | null | undefined): Promise<number>;
  /** Learn from conversation text (member accounts; actor `extraction`). */
  extract(actor: Actor | null | undefined, text: string): Promise<LearnOutcome>;
  /** Classify and store learned items for the actor's user (memory_save). */
  learn(actor: Actor | null | undefined, input: { candidates: Array<Omit<LearningCandidate, 'origin'>>; metadata?: Record<string, unknown>; review?: boolean }): Promise<LearnOutcome>;
  /** An agent edit/delete of an existing memory (memory_edit / memory_delete). */
  change(actor: Actor | null | undefined, input: { memoryId: string; op: 'update' | 'delete'; updates?: { content?: string; type?: string; importance?: number; topicKey?: string | null }; reason?: string | null }): Promise<AgentChangeResult>;
  /** Counts over the reachable memory; null when nothing is reachable (no drawers). */
  stats(actor: Actor | null | undefined): Promise<MemoryStats | null>;
  /** Readable memory in reach (agent runs: open drawers), importance first then newest. */
  reachable(actor: Actor | null | undefined): Promise<Memory[]>;
  /** A derived memory (memory_reflect), unversioned as before; the drawer must be open. */
  saveDerived(actor: Actor | null | undefined, memory: Omit<Memory, 'userId'>): Promise<Memory>;
  layerStats(actor: Actor | null | undefined): Promise<Awaited<ReturnType<typeof MemoryTiersService.getLayerStats>>>;
  promote(actor: Actor | null | undefined, memoryId: string, targetLayer: unknown): Promise<boolean>;
  promotionCandidates(actor: Actor | null | undefined): Promise<any[]>;
  setImportanceScore(actor: Actor | null | undefined, memoryId: string, score: number): Promise<boolean>;
  runConsolidation(actor: Actor | null | undefined): Promise<Awaited<ReturnType<ReturnType<typeof getConsolidationService>['runManual']>>>;
  consolidationLog(actor: Actor | null | undefined, limit: number): Promise<any[]>;
}

/** Drawers a read uses: agent runs never beyond their open drawers; accounts as asked. */
function readDrawers(a: Actor, asked: DrawerRef[] | undefined): DrawerRef[] | undefined {
  if (a.kind !== 'agent') return asked;
  const open = [...(a.drawers ?? [])];
  return asked ? asked.filter((d) => open.some((o) => sameDrawer(o, d))) : open;
}

export const memoryRecall: MemoryRecallRepository = {
  async search(actor, query) {
    const { a, userId } = memoryUser(actor);
    const drawers = readDrawers(a, query.drawers);
    const q = { ...query, userId, ...(drawers ? { drawers } : {}) };
    // CORE-MEM-GRAPH: entities named in the query pull their linked memories (same drawers).
    return withGraphRecall(q, await getMemoryStorage().search(q));
  },

  async relevant(actor, query, limit, drawers) {
    const { a, userId } = memoryUser(actor);
    const scoped = readDrawers(a, drawers);
    const q = { query, userId, limit, ...(scoped ? { drawers: scoped } : {}) };
    return (await withGraphRecall(q, await getMemoryStorage().search(q))).map((r) => r.memory);
  },

  async summary(actor) {
    return getMemoryRetrieval().getSummary(memberUser(actor).userId);
  },

  async consolidateDuplicates(actor) {
    return getMemoryRetrieval().consolidate(memberUser(actor).userId);
  },

  async extract(actor, text) {
    const { userId } = memberUser(actor);
    // CORE-05: extracted items are classified; routine ones are saved,
    // important ones become proposals for the owner (or are not saved).
    const candidates = await getMemoryRetrieval().extractCandidates(text, userId);
    return learn({ userId, candidates: candidates as LearningCandidate[], actor: 'extraction', metadata: { source: 'conversation' } });
  },

  async learn(actor, input) {
    const { a, userId } = memoryUser(actor);
    const agent = a.kind === 'agent';
    const origin: LearningCandidate['origin'] = agent ? (a.channel ? 'outsider' : 'agent') : 'owner';
    return learn({
      userId,
      candidates: input.candidates.map((c) => ({ ...c, origin })),
      actor: versionActor(a),
      agentId: agent ? a.agentId : undefined,
      openDrawers: agent ? [...(a.drawers ?? [])].filter((d) => drawerWritable(a, d)) : null,
      metadata: input.metadata,
      ...(input.review ? { review: true } : {}),
    });
  },

  async change(actor, input) {
    const { a, userId } = memoryUser(actor);
    const agent = a.kind === 'agent';
    return agentChange({
      userId, memoryId: input.memoryId, op: input.op, updates: input.updates,
      actor: versionActor(a), agentId: agent ? a.agentId : undefined,
      openDrawers: agent ? [...(a.drawers ?? [])].filter((d) => drawerWritable(a, d)) : null, outsider: agent && !!a.channel,
      reason: input.reason ?? null,
    });
  },

  async stats(actor) {
    const { a, userId } = memoryUser(actor);
    const drawers = readDrawers(a, undefined);
    if (drawers && drawers.length === 0) return null;
    const scope = drawers ? drawerSqlFilter(drawers) : { sql: '1 = 1', params: [] as string[] };
    const where = `user_id = ? AND ${scope.sql}`;
    const args = [userId, ...scope.params];
    const total = (await sql().read(one<{ n: number }>(`SELECT COUNT(*) as n FROM memories WHERE ${where}`, ...args)))?.n ?? 0;
    if (total === 0) return { total: 0, highImportance: 0, byType: [], topTags: [], oldest: null, newest: null };
    const byType = await sql().read(all<{ type: string; n: number }>(`SELECT type, COUNT(*) as n FROM memories WHERE ${where} GROUP BY type ORDER BY n DESC, type`, ...args));
    const highImportance = (await sql().read(one<{ n: number }>(`SELECT COUNT(*) as n FROM memories WHERE ${where} AND importance_score >= 0.7`, ...args)))?.n ?? 0;
    const dates = await sql().read(one<{ oldest: string | null; newest: string | null }>(`SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM memories WHERE ${where}`, ...args));
    const tagRows = await sql().read(all<{ tags: string }>(`SELECT tags FROM memories WHERE ${where} AND tags IS NOT NULL ORDER BY created_at, id`, ...args));
    const tagCounts: Record<string, number> = {};
    for (const row of tagRows) {
      try {
        for (const tag of JSON.parse(row.tags) as string[]) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      } catch { /* skip malformed */ }
    }
    const topTags = Object.entries(tagCounts).sort(([, x], [, y]) => y - x).slice(0, 10);
    return { total, highImportance, byType, topTags, oldest: dates?.oldest ?? null, newest: dates?.newest ?? null };
  },

  async reachable(actor) {
    const { a, userId } = memoryUser(actor);
    const drawers = readDrawers(a, undefined);
    const storage = getMemoryStorage();
    const found: Memory[] = drawers ? await storage.getByDrawers(userId, drawers) : await storage.getByUser(userId);
    // MEM-SCALE-01: an archived project is kept but never recalled.
    const archived = await archivedProjects(userId);
    const rows = archived.size ? found.filter((m) => m.drawer?.kind !== 'project' || !archived.has(m.drawer.key || '')) : found;
    return rows.sort((x, y) => (y.importanceScore ?? 0.5) - (x.importanceScore ?? 0.5) || y.createdAt.getTime() - x.createdAt.getTime());
  },

  async saveDerived(actor, memory) {
    const { a, userId } = memoryUser(actor);
    const drawer = memory.drawer ? normalizeDrawer(memory.drawer) : defaultDrawerForType(memory.type);
    // CORE-PERMS-01: open for the run and a kind the agent may write.
    if (!drawerWritable(a, drawer)) throw new ScopeError(403, DRAWER_CLOSED);
    const saved = { ...memory, drawer, userId } as Memory;
    await getMemoryStorage().save(saved);
    return saved;
  },

  async layerStats(actor) {
    return MemoryTiersService.getLayerStats(memberUser(actor).userId);
  },

  async promote(actor, memoryId, targetLayer) {
    const { userId } = memberUser(actor);
    if (targetLayer === 'experiential') return MemoryTiersService.promoteToExperiential(userId, memoryId);
    if (targetLayer === 'factual') return MemoryTiersService.promoteToFactual(userId, memoryId);
    return false;
  },

  async promotionCandidates(actor) {
    return MemoryTiersService.getPromotionCandidates(memberUser(actor).userId);
  },

  async setImportanceScore(actor, memoryId, score) {
    const { userId } = memberUser(actor);
    if (!(await getMemoryStorage().getOwned(userId, memoryId))) throw new ScopeError(404, NOT_FOUND);
    return MemoryTiersService.updateImportanceScore(memoryId, score);
  },

  async runConsolidation(actor) {
    requireOwner(actor);
    return getConsolidationService().runManual();
  },

  async consolidationLog(actor, limit) {
    requireOwner(actor);
    return MemoryTiersService.getConsolidationLog(limit);
  },
};

