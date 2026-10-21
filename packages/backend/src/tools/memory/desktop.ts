/**
 * Memory desktop tools (MEM-UX-02): the same actions as the owner-only
 * /api/memory/trash*, /api/memory/groups* API, with the same gates.
 *
 * memory_trash           read only: what is in the Trash (memories, projects,
 *                        keep-days, the day each will be forgotten)
 * memory_restore         bring a memory (id) or a project (project) back from
 *                        the Trash; restoring is the undo of a delete
 * memory_trash_empty     forget memories / projects in the Trash, or all of
 *                        it; cannot be undone ('delete' approval)
 * memory_project_trash   move a whole project to the Trash ('delete' approval)
 * memory_groups          read only: groups of projects and share-within
 * memory_group_apply     create / update / delete a group, set its projects
 *                        ('settings' approval: share-within changes who reads what)
 *
 * Gates (all): the run's user must be the owner account, in the owner's own
 * turn, never a turn that answers an outsider (scopes.ts ownerGate).
 */

import type { Tool, ToolResult, ToolExecutionContext } from '../types.js';
import { actorLabel, toolActor } from '../../repositories/actor.js';
import { ScopeInputError } from '../../memory/scopes/store.js';
import { createGroup, deleteGroup, listGroups, setGroupProjects, updateGroup } from '../../memory/scopes/groups.js';
import { emptyTrash, listTrash, restoreMemory, restoreProject, trashProject } from '../../memory/trash.js';
import { auditTool, ownerGate } from './scopes.js';

const fail = (tool: string, msg: string): ToolResult => ({ content: [{ type: 'text', text: `${tool} refused: ${msg}` }], error: msg });
const ok = (text: string, data: Record<string, unknown>): ToolResult => ({ content: [{ type: 'text', text }], data: { success: true, ...data } } as ToolResult);

/** Run a gated action; input errors come back as a refusal. */
async function gated(tool: string, context: ToolExecutionContext | undefined, fn: (ownerId: string, by: string) => Promise<ToolResult>): Promise<ToolResult> {
  const gate = await ownerGate(context);
  if ('refused' in gate) return fail(tool, gate.refused);
  try {
    return await fn(gate.ownerId, actorLabel(toolActor(context)));
  } catch (err) {
    if (err instanceof ScopeInputError) return fail(tool, err.message);
    throw err;
  }
}

export const memoryTrashTool: Tool = {
  name: 'memory_trash',
  description: `List what is in the memory Trash (owner only): deleted memories (id, text, drawer, when deleted,
when they will be forgotten) and projects moved to the Trash. Deleted memories are never recalled.
Use memory_restore to bring one back.`,
  input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'At most this many memories (default 50)' } } },
  async execute(params: { limit?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    return gated('memory_trash', context, async (ownerId) => {
      const t = await listTrash(ownerId);
      const limit = Number.isInteger(params.limit) && (params.limit as number) > 0 ? Math.min(500, params.limit as number) : 50;
      const lines = t.items.slice(0, limit).map((i) => `- ${i.id} [${i.drawer}] deleted ${i.deletedAt}${i.forgetAt ? `, forgotten ${i.forgetAt}` : ''}: ${i.text.slice(0, 160)}`);
      const projects = t.projects.map((p) => `- project ${p.slug} (${p.name}), ${p.memories} memories, in the Trash since ${p.trashedAt}`);
      const text = [`Trash: ${t.items.length} memories, ${t.projects.length} projects; kept ${t.trashDays ? `${t.trashDays} days` : 'until emptied'}.`, ...projects, ...lines].join('\n');
      return ok(text, { trashDays: t.trashDays, items: t.items.slice(0, limit), projects: t.projects, total: t.items.length });
    });
  },
};

export const memoryRestoreTool: Tool = {
  name: 'memory_restore',
  description: `Bring a memory back from the Trash (give id, from memory_trash), or a whole project with the
memories that went with it (give project). The memory comes back as it was, in the same drawer.`,
  input_schema: { type: 'object', properties: { id: { type: 'string' }, project: { type: 'string' } } },
  async execute(params: { id?: unknown; project?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    return gated('memory_restore', context, async (ownerId, by) => {
      if (typeof params.project === 'string' && params.project) {
        const out = await restoreProject(ownerId, params.project, by);
        auditTool(context, 'memory_scope.project_restore', 'memory_project', out.project, { restored: out.restored });
        return ok(`Project ${out.project} is back with ${out.restored} memories.`, out);
      }
      if (typeof params.id !== 'string' || !params.id) return fail('memory_restore', 'give id or project');
      const restored = await restoreMemory(ownerId, params.id, by);
      auditTool(context, 'memory.restore', 'memory', restored.id, { drawer: restored.drawer, topicKeyDropped: restored.topicKeyDropped });
      return ok(`Memory ${restored.id} is back in ${restored.drawer}.`, { restored });
    });
  },
};

export const memoryTrashEmptyTool: Tool = {
  name: 'memory_trash_empty',
  description: `Forget for good what is in the memory Trash, after the owner approves this call. Give ids
(memories) and/or projects (slugs); give neither to empty the whole Trash. Cannot be undone.`,
  input_schema: {
    type: 'object',
    properties: { ids: { type: 'array', items: { type: 'string' } }, projects: { type: 'array', items: { type: 'string' } } },
  },
  async execute(params: { ids?: unknown; projects?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    return gated('memory_trash_empty', context, async (ownerId, by) => {
      const out = await emptyTrash(ownerId, { ids: params.ids, projects: params.projects }, by);
      auditTool(context, 'memory.trash_empty', 'memory_trash', ownerId, { forgotten: out.forgotten.length, projects: out.projects, skipped: out.skipped.length });
      return ok(`Forgotten: ${out.forgotten.length} memories, ${out.projects.length} projects${out.skipped.length ? `; ${out.skipped.length} not in the Trash` : ''}.`, out);
    });
  },
};

export const memoryProjectTrashTool: Tool = {
  name: 'memory_project_trash',
  description: `Move a whole project to the memory Trash, after the owner approves this call: every memory of the
project is deleted (restorable with memory_restore project) and the project is archived until restored.`,
  input_schema: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
  async execute(params: { project?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    return gated('memory_project_trash', context, async (ownerId, by) => {
      const out = await trashProject(ownerId, String(params.project ?? ''), by);
      auditTool(context, 'memory_scope.project_trash', 'memory_project', out.project, { memories: out.memories });
      return ok(`Project ${out.project} moved to the Trash (${out.memories} memories).`, out);
    });
  },
};

export const memoryGroupsTool: Tool = {
  name: 'memory_groups',
  description: `List the owner's groups of projects (a client or a team): name, label, whether the projects share
memory within the group (an agent on one project then reads the others), and their projects.`,
  input_schema: { type: 'object', properties: {} },
  async execute(_params: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
    return gated('memory_groups', context, async (ownerId) => {
      const groups = await listGroups(ownerId);
      const text = groups.length
        ? groups.map((g) => `- ${g.id} ${g.name}${g.label ? ` (${g.label})` : ''}${g.shareWithin ? ' · shares within' : ''}: ${g.projects.join(', ') || 'no projects'}`).join('\n')
        : 'No groups of projects.';
      return ok(text, { groups });
    });
  },
};

const GROUP_OPS = ['create', 'update', 'delete', 'set_projects'] as const;

export const memoryGroupApplyTool: Tool = {
  name: 'memory_group_apply',
  description: `Change groups of projects, after the owner approves this call. op:
- "create": name, label?, shareWithin?, projects?
- "update": id, name?, label?, shareWithin?
- "delete": id (the projects stay)
- "set_projects": id, projects (a project is in one group at most; it leaves its old group)
shareWithin = true lets an agent working on one project of the group read the others.`,
  input_schema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: [...GROUP_OPS] }, id: { type: 'string' }, name: { type: 'string' }, label: { type: 'string' },
      shareWithin: { type: 'boolean' }, projects: { type: 'array', items: { type: 'string' } },
    },
    required: ['op'],
  },
  async execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    return gated('memory_group_apply', context, async (ownerId, by) => {
      const id = String(params.id ?? '');
      const pick = (keys: string[]) => Object.fromEntries(keys.filter((k) => params[k] !== undefined).map((k) => [k, params[k]]));
      switch (params.op) {
        case 'create': {
          const group = await createGroup(ownerId, pick(['name', 'label', 'shareWithin', 'projects']), by);
          auditTool(context, 'memory_group.create', 'memory_group', group.id, { name: group.name, shareWithin: group.shareWithin, projects: group.projects });
          return ok(`Group ${group.name} created (${group.id}).`, { group });
        }
        case 'update': {
          const group = await updateGroup(ownerId, id, pick(['name', 'label', 'shareWithin']));
          auditTool(context, 'memory_group.update', 'memory_group', group.id, { shareWithin: group.shareWithin });
          return ok(`Group ${group.name} updated.`, { group });
        }
        case 'delete': {
          const out = await deleteGroup(ownerId, id);
          auditTool(context, 'memory_group.delete', 'memory_group', out.id, { projects: out.projects });
          return ok(`Group ${out.id} deleted; its projects stay.`, out);
        }
        case 'set_projects': {
          const group = await setGroupProjects(ownerId, id, params.projects);
          auditTool(context, 'memory_group.projects', 'memory_group', group.id, { projects: group.projects });
          return ok(`Group ${group.name} now holds ${group.projects.length} projects.`, { group });
        }
        default:
          return fail('memory_group_apply', `op must be one of ${GROUP_OPS.join(', ')}`);
      }
    });
  },
};
