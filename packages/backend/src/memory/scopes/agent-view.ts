/**
 * Agent-view knowledge map (MEM-GAPS-02): the part of the owner's graph one
 * agent's runs could read — the owner's map limited to the drawers that
 * agent may read (its own permissions, narrowed by the owner's inherited
 * access for the project; CORE-PERMS-01 / MEM-SCALE-01), the same way a run
 * is narrowed. Without a project: owner, experience, people and task
 * drawers only (a run outside a project opens no project drawer). An
 * archived project opens nothing of the project.
 *
 * Owner only (callers check). Names and counts of entities and links; no
 * memory text.
 */

import { all, one, sql } from '../../repositories/sql-steps.js';
import { isValidDrawerKey, drawerId, sameDrawer, type DrawerRef } from '../drawers.js';
import { loadRunPermissions } from '../../tools/agent-permissions.js';
import { listEntities, listLinks, type GraphEntity, type GraphLink } from '../graph/read.js';
import { ScopeInputError, projectStep } from './store.js';

export interface AgentViewMap {
  agentId: string;
  agentName: string;
  project: string | null;
  /** Drawer kinds the agent may read here. */
  readable: string[];
  /** Drawers the view covers (at most 200). */
  drawers: string[];
  entities: GraphEntity[];
  links: GraphLink[];
}

const AGENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** `within`: only these drawers too (an agent tool: never more than its own run may read). */
export async function agentViewMap(ownerId: string, agentId: string, input: { project?: unknown; q?: unknown; kind?: unknown; limit?: unknown } = {}, within?: readonly DrawerRef[]): Promise<AgentViewMap | null> {
  if (!AGENT_ID.test(agentId)) return null;
  const agent = await sql().read(one<{ id: string; name: string }>('SELECT id, name FROM agents_config WHERE id = ?', agentId));
  if (!agent) return null;
  const project = input.project === undefined || input.project === '' ? null : input.project;
  if (project !== null && !isValidDrawerKey('project', project)) throw new ScopeInputError('Invalid project');
  const p = project ? await sql().read(projectStep(ownerId, project as string)) : null;
  if (project && !p) throw new ScopeInputError('Project not found', 404, 'not_found');
  const read = (await loadRunPermissions(agentId, [], { userId: ownerId, project: p && !p.archived ? p.slug : null })).memoryRead;
  const drawers: DrawerRef[] = [];
  if (read.includes('owner')) drawers.push({ kind: 'owner' });
  if (read.includes('experience')) drawers.push({ kind: 'experience' });
  if (p && !p.archived && read.includes('project')) drawers.push({ kind: 'project', key: p.slug });
  for (const kind of ['people', 'task'] as const) {
    if (!read.includes(kind)) continue;
    const keys = await sql().read(all<{ key: string }>('SELECT DISTINCT drawer_key AS key FROM memories WHERE user_id = ? AND drawer_kind = ? ORDER BY drawer_key LIMIT 100', ownerId, kind));
    for (const k of keys) if (k.key && isValidDrawerKey(kind, k.key)) drawers.push({ kind, key: k.key });
  }
  const visible = within ? drawers.filter((d) => within.some((w) => sameDrawer(w, d))) : drawers;
  drawers.splice(0, drawers.length, ...visible);
  const scope = { userId: ownerId, drawers };
  const [entities, links] = drawers.length
    ? await Promise.all([listEntities(scope, { q: input.q, kind: input.kind, limit: input.limit }), listLinks(scope, { status: 'active', limit: input.limit })])
    : [[], []];
  return { agentId: agent.id, agentName: agent.name, project: p?.slug ?? null, readable: [...read], drawers: drawers.slice(0, 200).map(drawerId), entities, links };
}
