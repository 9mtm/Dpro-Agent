/**
 * Pinned facts of a board task run (MEM-SCALE-01): the same "Pinned facts"
 * block a chat reply loads first, for the scope the task works in.
 *
 * The project of a run is its open project drawer, else the project of the
 * chat conversation the board card was made from. Same access checks as a
 * chat turn: company facts only when the owner drawer is open for the run
 * and the agent may read it, department and project facts only when the
 * agent may read project drawers in that project (inherited access,
 * CORE-PERMS-01 cap, every delegating agent). A contract that narrows the
 * run's drawers to no project drawer leaves the project facts out. An
 * archived project adds nothing (pinnedFactsForReply).
 */

import { one, sql } from '../../repositories/sql-steps.js';
import type { DrawerRef } from '../drawers.js';
import { loadRunPermissions } from '../../tools/agent-permissions.js';
import { pinnedFactsForReply } from './pinned.js';

/** Project slug of the board card's conversation for this task, or null. */
async function cardProject(ownerId: string, taskId: string): Promise<string | null> {
  const row = await sql().read(one<{ slug: string }>(`
    SELECT p.slug FROM board_cards c
      JOIN boards b ON b.id = c.board_id
      JOIN chat_sessions s ON s.id = c.conversation_id
      JOIN chat_projects p ON p.id = s.project_id AND p.user_id = s.user_id
     WHERE c.task_id = ? AND b.owner_id = ? AND s.user_id = ?
     ORDER BY c.created_at ASC, c.id ASC LIMIT 1`, taskId, ownerId, ownerId)).catch(() => undefined);
  return row?.slug ?? null;
}

export interface TaskFactsInput {
  ownerId: string | null | undefined;
  agentId: string;
  taskId: string;
  delegatedFrom?: readonly string[];
  /** The drawers open for the run (after any contract narrowing). */
  drawers: readonly DrawerRef[];
  /** The run's contract narrowed its drawers (then only an open project drawer counts). */
  drawersNarrowed?: boolean;
}

/** The prompt block for the run, or ''. Never throws (no facts on any error). */
export async function taskRunPinnedFacts(input: TaskFactsInput): Promise<string> {
  if (!input.ownerId) return '';
  try {
    const open = input.drawers.find((d) => d.kind === 'project')?.key ?? null;
    const project = open ?? (input.drawersNarrowed ? null : await cardProject(input.ownerId, input.taskId));
    const read = (await loadRunPermissions(input.agentId, input.delegatedFrom ?? [], { userId: input.ownerId, project })).memoryRead;
    const allow = { company: read.includes('owner') && input.drawers.some((d) => d.kind === 'owner'), project: read.includes('project') };
    if (!allow.company && !allow.project) return '';
    return (await pinnedFactsForReply(input.ownerId, project, allow)).text;
  } catch {
    return '';
  }
}
