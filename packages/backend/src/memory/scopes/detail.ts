/**
 * One memory as the explorer's side panel shows it (MEM-GAPS-02): its row,
 * in how many replies it was used (reply trace), the graph entities and
 * links it holds, and how many agents may read it (inherited access of its
 * drawer kind in its project, or company-wide for the other drawers).
 *
 * Owner only (callers check). An agent run reads it only for a drawer open
 * in the run (tools/memory/scopes.ts).
 */

import { one, sql } from '../../repositories/sql-steps.js';
import { drawerId, isValidDrawerKey, type DrawerKind } from '../drawers.js';
import { memoryEntities, type MemoryEntities } from '../graph/read.js';
import { memoryUsage, type MemoryUsage } from '../context/trace.js';
import { agentsWithAccess } from './access.js';
import { ScopeInputError, projectStep } from './store.js';

export interface MemoryDetail {
  id: string;
  type: string;
  content: string;
  drawerId: string;
  topicKey: string | null;
  importance: number;
  layer: string;
  createdAt: string;
  sourceAgentId: string | null;
  source: string | null;
  usage: MemoryUsage;
  graph: Pick<MemoryEntities, 'entities' | 'links'>;
  /** Agents that may read it now: count of all agents (`all` when every agent may). */
  readers: { scope: string; count: number; total: number; all: boolean; archived: boolean };
}

interface Row {
  id: string; type: string; content: string; drawer_kind: string | null; drawer_key: string | null; topic_key: string | null;
  importance_score: number | null; memory_layer: string | null; created_at: string; source_agent_id: string | null; metadata: string | null;
}

const MEMORY_ID = /^[A-Za-z0-9_.:@-]{1,128}$/;

export async function memoryDetail(ownerId: string, memoryId: string): Promise<MemoryDetail> {
  if (!MEMORY_ID.test(memoryId)) throw new ScopeInputError('Memory not found', 404, 'not_found');
  const r = await sql().read(one<Row>(`
    SELECT id, type, content, drawer_kind, drawer_key, topic_key, importance_score, memory_layer, created_at, source_agent_id, metadata
      FROM memories WHERE id = ? AND user_id = ?`, memoryId, ownerId));
  if (!r) throw new ScopeInputError('Memory not found', 404, 'not_found');
  const kind = (r.drawer_kind || 'owner') as DrawerKind;
  const key = r.drawer_key || '';
  const drawer = key && isValidDrawerKey(kind, key) ? drawerId({ kind, key }) : kind;
  let source: string | null = null;
  try { const m = JSON.parse(r.metadata || '{}') as { source?: unknown }; source = typeof m.source === 'string' ? m.source.slice(0, 32) : null; } catch { /* none */ }

  // Readers: a project memory by the project's chain; anything else company-wide. Archived = nobody.
  const project = kind === 'project' && key ? await sql().read(projectStep(ownerId, key)) : null;
  const scope = project ? `project:${project.slug}` : 'company';
  let readers: MemoryDetail['readers'];
  if (project?.archived) {
    readers = { scope, count: 0, total: 0, all: false, archived: true };
  } else {
    const who = await agentsWithAccess(ownerId, { scope, column: kind, mode: 'read', limit: 1 });
    readers = { scope, count: who.count, total: who.total, all: who.total > 0 && who.count === who.total, archived: false };
  }
  const graph = await memoryEntities({ userId: ownerId }, memoryId);
  return {
    id: r.id, type: r.type, content: r.content, drawerId: drawer, topicKey: r.topic_key,
    importance: Math.round((r.importance_score ?? 0.5) * 10), layer: r.memory_layer ?? 'factual', createdAt: r.created_at,
    sourceAgentId: r.source_agent_id ?? null, source,
    usage: await memoryUsage(ownerId, memoryId),
    graph: graph ? { entities: graph.entities, links: graph.links } : { entities: [], links: [] },
    readers,
  };
}
