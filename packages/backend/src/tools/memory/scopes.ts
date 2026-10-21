/**
 * Memory at scale tools (MEM-SCALE-01): the same actions as the owner-only
 * /api/memory/scopes* and /api/memory/access* API, with the same gates.
 *
 * memory_scopes         read only: scope tree with counts and health, scope
 *                       search, agents, pinned facts, access overview,
 *                       effective access + why, memories of an OPEN drawer,
 *                       and the previews (project action, department delete,
 *                       access change) that return the previewHash an apply needs.
 * memory_scope_apply    project pin / unpin / archive / unarchive / move / merge /
 *                       export, departments, pinned facts. Every call waits for
 *                       one-time owner approval (approvals.ts, 'settings'); the
 *                       approval is the confirm, and the call carries the
 *                       previewHash of what the owner saw.
 * memory_access_apply   access rules, role templates, temporary exceptions
 *                       ('settings' approval + previewHash).
 * memory_scope_forget   forget all of a project (CORE-07, 'delete' approval + previewHash).
 *
 * MEM-GAPS-02 adds to memory_scopes: one memory (open drawer only: used in N
 * replies, linked entities, readers), who has access to a scope, access
 * counts per scope, one role template with its agents, review rules; and to
 * memory_scope_apply: review rules. Changing company / department pinned
 * facts also needs the run's write on that access column.
 *
 * Gates (all four): the run's user must be the owner account, never a turn
 * that answers an outsider. Memory text is shown only for drawers open for
 * the run; tree and search carry names and counts only.
 */

import type { Tool, ToolResult, ToolExecutionContext } from '../types.js';
import { toolMemoryDrawers, toolMemoryUser, toolOwnerTurn } from './scope.js';
import { one, sql } from '../../repositories/sql-steps.js';
import { repositories } from '../../repositories/index.js';
import { toolActor, actorLabel } from '../../repositories/actor.js';
import { drawerId } from '../../memory/drawers.js';
import { resolveFileAgent } from '../../memory/memory-files.js';
import {
  PROJECT_ACTIONS, ScopeInputError, accessOverview, addPinnedFact, applyAccessChanges, applyProjectAction, createDepartment, deleteDepartment,
  accessCounts, agentsWithAccess, memoryDetail, scopeRules, setScopeRules, templateDetail,
  effectiveAccess, exploreScope, exportProject, getProject, invalidateScopeTree, listAgentScopes, listPinnedFacts, parseActionInput, parsePinnedScope,
  previewAccessChanges, previewDeleteDepartment, previewProjectAction, removePinnedFact, renameDepartment, scopeTree, searchScopes, updatePinnedFact,
} from '../../memory/scopes/index.js';

const fail = (tool: string, msg: string): ToolResult => ({ content: [{ type: 'text', text: `${tool} refused: ${msg}` }], error: msg });
const ok = (text: string, data: Record<string, unknown>): ToolResult => ({ content: [{ type: 'text', text }], data: { success: true, ...data } } as ToolResult);

/** The owner's id when this run may use the scope tools, else a refusal text. */
export async function ownerGate(context?: ToolExecutionContext): Promise<{ ownerId: string } | { refused: string }> {
  const userId = toolMemoryUser(context);
  if (!userId) return { refused: 'no user for this memory' };
  if (!toolOwnerTurn(context)) return { refused: "only in the owner's own turn, not in a board task run" };
  if (context?.toolPolicy) return { refused: 'not available when answering someone else' };
  const row = await sql().read(one<{ role: string }>('SELECT role FROM users WHERE id = ?', userId));
  if (row?.role !== 'owner') return { refused: 'only for the owner' };
  return { ownerId: userId };
}

export function auditTool(context: ToolExecutionContext | undefined, action: string, resourceType: string, resourceId: string, metadata: Record<string, unknown>) {
  void repositories.audit.record(toolActor(context), {
    event_type: 'data.update', event_category: 'data_modification', severity: 'info',
    resource_type: resourceType, resource_id: resourceId, action, success: true, metadata: { ...metadata, via: 'agent_tool' },
  });
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const json = (v: unknown) => JSON.stringify(v);

const READ_ACTIONS = ['tree', 'search', 'agents', 'pinned', 'access', 'effective', 'memories', 'memory', 'who', 'access_counts', 'template', 'rules', 'preview_project', 'preview_department_delete', 'preview_access'] as const;

export const memoryScopesTool: Tool = {
  name: 'memory_scopes',
  description: `Read how the owner's memory is organised at scale (read only; owner's own conversations only).

Actions:
- tree: company -> departments -> projects, people and agents with memory counts and a health flag (ok / attention / problem)
- search: find departments, projects, people or agents by name (q)
- agents: agents as scopes, paged (q, cursor)
- pinned: pinned facts of a scope (scope = company | department:<id> | project:<slug>)
- access: inherited access rules and role templates
- effective: an agent's effective memory access and why (agent_id, optional project)
- memories: memories of one scope (scope = a drawer open in this conversation), newest first (q, type, source, agent_id, importance "n" or "a-b", from / to YYYY-MM-DD, cursor); each says in how many replies it was used
- memory: one memory of an open drawer (memory_id): text, used in N replies, the map entities it names, how many agents may read it
- who: agents that may read or write one column of a scope (scope, column = owner | project | experience | task | people | company | department, mode = read | write, q, cursor)
- access_counts: how many agents may read (or write) a column per company / department / project (column, mode)
- template: one role template with the agents that use it (template_id)
- rules: review rules of a scope and what is in effect there (scope)
- preview_project: what a project action would change (project, project_action = ${PROJECT_ACTIONS.join(' | ')}, target for merge, department_id for move) -> previewHash
- preview_department_delete: what deleting a department changes (department_id) -> previewHash
- preview_access: how many agents and projects an access change affects (changes) -> previewHash

To change anything, call memory_scope_apply / memory_access_apply / memory_scope_forget with the previewHash; the owner approves the call.`,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...READ_ACTIONS] },
      q: { type: 'string' },
      kinds: { type: 'string', description: 'search: comma list of department, project, people, agent' },
      cursor: { type: 'string' },
      scope: { type: 'string' },
      type: { type: 'string' },
      agent_id: { type: 'string' },
      project: { type: 'string', description: 'project slug' },
      project_action: { type: 'string', enum: [...PROJECT_ACTIONS] },
      target: { type: 'string', description: 'merge: target project slug' },
      department_id: { type: 'string' },
      changes: { type: 'array', items: { type: 'object' }, description: 'preview_access: set_rule | clear_rule | save_template | delete_template | assign_template changes' },
      source: { type: 'string', description: 'memories: who or what saved it (owner, agent, import, chat, ...)' },
      importance: { type: 'string', description: 'memories: "n" or "a-b" (1-10)' },
      from: { type: 'string', description: 'memories: from this date (YYYY-MM-DD)' },
      to: { type: 'string', description: 'memories: up to this date (YYYY-MM-DD)' },
      memory_id: { type: 'string' },
      column: { type: 'string', description: 'who / access_counts: a drawer kind, company or department' },
      mode: { type: 'string', enum: ['read', 'write'] },
      template_id: { type: 'string' },
    },
    required: ['action'],
  },
  async execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    const gate = await ownerGate(context);
    if ('refused' in gate) return fail('memory_scopes', gate.refused);
    const { ownerId } = gate;
    try {
      switch (params.action) {
        case 'tree': {
          const t = await scopeTree(ownerId);
          return ok(`Company: ${t.company.memories} memories (${t.company.health}), ${t.departments.length} departments, ${t.company.projects} projects (${t.company.archivedProjects} archived), ${t.agents.total} agents.`, { tree: t });
        }
        case 'search': {
          const hits = await searchScopes(ownerId, params.q, params.kinds);
          return ok(`${hits.length} scopes match.`, { hits });
        }
        case 'agents': {
          const page = await listAgentScopes(ownerId, { q: params.q, cursor: params.cursor });
          return ok(`${page.agents.length} agents${page.nextCursor ? ' (more: pass cursor)' : ''}.`, page);
        }
        case 'pinned': {
          const scope = parsePinnedScope(params.scope ?? 'company');
          // Only facts of drawers open (and readable) for this run: company -> owner, project -> its drawer,
          // department -> an open project drawer in that department. Archived projects are never open.
          const open = toolMemoryDrawers(context);
          const projects = await Promise.all(open.filter((d) => d.kind === 'project').map((d) => getProject(ownerId, d.key || '')));
          const live = projects.filter((p): p is NonNullable<typeof p> => !!p && !p.archived);
          const allowed = scope.kind === 'company' ? open.some((d) => d.kind === 'owner')
            : scope.kind === 'project' ? live.some((p) => p.slug === scope.id)
              : live.some((p) => p.departmentId === scope.id);
          if (!allowed) return fail('memory_scopes', 'that scope is not open in this conversation');
          const facts = await listPinnedFacts(ownerId, scope);
          return ok(`${facts.length} pinned facts.`, { facts });
        }
        case 'access': {
          const a = await accessOverview(ownerId);
          return ok(`Access version ${a.version}: ${a.rules.length} rules, ${a.templates.length} role templates.`, a);
        }
        case 'effective': {
          if (typeof params.agent_id !== 'string') return fail('memory_scopes', 'agent_id is required');
          const e = await effectiveAccess(ownerId, params.agent_id, str(params.project) || null);
          if (!e) return fail('memory_scopes', 'agent not found');
          return ok(`${e.agentName}: reads ${e.effective.memoryRead.join(', ') || 'nothing'}; writes ${e.effective.memoryWrite.join(', ') || 'nothing'}.`, e);
        }
        case 'memories': {
          const scope = str(params.scope);
          const open = toolMemoryDrawers(context).map(drawerId);
          if (!scope || !open.includes(scope)) return fail('memory_scopes', `scope must be a drawer open in this conversation (${open.join(', ') || 'none'})`);
          const page = await exploreScope(ownerId, {
            scope, q: params.q, type: params.type, cursor: params.cursor,
            source: params.source, agent: params.agent_id, importance: params.importance, from: params.from, to: params.to,
          });
          return ok(`${page.total} memories in ${scope}${page.nextCursor ? ' (more: pass cursor)' : ''}.`, page as unknown as Record<string, unknown>);
        }
        case 'memory': {
          const open = new Set(toolMemoryDrawers(context).map(drawerId));
          const id = str(params.memory_id) ?? '';
          // A memory of a drawer not open here reads exactly like a missing one.
          const m = await memoryDetail(ownerId, id).catch((err) => { if (err instanceof ScopeInputError) return null; throw err; });
          if (!m || !open.has(m.drawerId)) return fail('memory_scopes', 'no memory with that id in the drawers open in this conversation');
          return ok(`[${m.drawerId}] ${m.content}\nUsed in ${m.usage.usedIn} replies; names ${m.graph.entities.map((e) => e.name).join(', ') || 'nothing in the map'}; ${m.readers.all ? 'read by all agents' : `read by ${m.readers.count} of ${m.readers.total} agents`}.`, { memory: m });
        }
        case 'who': {
          const w = await agentsWithAccess(ownerId, { scope: params.scope ?? 'company', column: params.column, mode: params.mode, q: params.q, cursor: params.cursor });
          return ok(`${w.count} of ${w.total} agents may ${w.mode} ${w.column} in ${w.scope}${w.nextCursor ? ' (more: pass cursor)' : ''}: ${w.agents.map((a) => a.name).join(', ')}`, w as unknown as Record<string, unknown>);
        }
        case 'access_counts': {
          const c = await accessCounts(ownerId, { column: params.column, mode: params.mode });
          return ok(`${c.company} of ${c.total} agents may ${c.mode} ${c.column} company-wide; per department and project in data.`, c as unknown as Record<string, unknown>);
        }
        case 'template': {
          const t = await templateDetail(ownerId, String(params.template_id ?? ''), { cursor: params.cursor });
          return ok(`Role template ${t.template.name}: reads ${t.template.memoryRead.join(', ') || 'nothing'}, writes ${t.template.memoryWrite.join(', ') || 'nothing'}; used by ${t.template.agents} agents.`, t as unknown as Record<string, unknown>);
        }
        case 'rules': {
          const r = await scopeRules(ownerId, params.scope ?? 'company');
          const e = r.effective;
          return ok(`Rules in ${r.scope}: routine ${e.routine}, important ${e.important}, contradiction ${e.contradiction}${e.reviewerAgentId ? `, reviewer ${e.reviewerAgentId}` : ''}; weekly summary day ${e.weekly.day} at ${e.weekly.hour}:00.`, r as unknown as Record<string, unknown>);
        }
        case 'preview_project': {
          const p = await previewProjectAction(ownerId, String(params.project ?? ''), parseActionInput({ action: params.project_action, target: params.target, departmentId: params.department_id }));
          return ok(`${p.action} ${p.project.slug}: ${json(p.effects)}. previewHash ${p.previewHash}`, p as unknown as Record<string, unknown>);
        }
        case 'preview_department_delete': {
          const p = await previewDeleteDepartment(ownerId, String(params.department_id ?? ''));
          return ok(`Delete department ${p.department.name}: ${json(p.effects)}. previewHash ${p.previewHash}`, p as unknown as Record<string, unknown>);
        }
        case 'preview_access': {
          const p = await previewAccessChanges(ownerId, params.changes, actorLabel(toolActor(context)));
          return ok(`Affects ${p.agentsAffected} of ${p.agentsTotal} agents in ${p.projectsAffected} of ${p.projectsTotal} projects (${p.widened} widened, ${p.narrowed} narrowed). previewHash ${p.previewHash}`, p as unknown as Record<string, unknown>);
        }
        default:
          return fail('memory_scopes', `action must be one of ${READ_ACTIONS.join(', ')}`);
      }
    } catch (err) {
      if (err instanceof ScopeInputError) return fail('memory_scopes', err.message);
      throw err;
    }
  },
};

const APPLY_ACTIONS = ['project', 'export', 'department_create', 'department_rename', 'department_delete', 'pinned_add', 'pinned_update', 'pinned_remove', 'rules_set'] as const;

/** Company / department pinned facts need the run's write on that access column (MEM-GAPS-02); null = allowed. */
function pinnedWriteRefusal(context: ToolExecutionContext | undefined, scope: string): string | null {
  const write = context?.permissions?.scopeWrite;
  const column = scope === 'company' ? 'company' : scope.startsWith('department:') ? 'department' : null;
  if (!column || !write || write.includes(column)) return null;
  return `this agent may not change ${column} pinned facts`;
}

async function pinnedFactScope(ownerId: string, id: string): Promise<string | null> {
  const r = await sql().read(one<{ scope_kind: string; scope_id: string }>('SELECT scope_kind, scope_id FROM memory_pinned_facts WHERE owner_id = ? AND id = ?', ownerId, id));
  return r ? (r.scope_kind === 'company' ? 'company' : `${r.scope_kind}:${r.scope_id}`) : null;
}

export const memoryScopeApplyTool: Tool = {
  name: 'memory_scope_apply',
  description: `Change how the owner's memory is organised, after the owner approves this call.

Actions:
- project: pin / unpin / archive / unarchive / move / merge a project (project, project_action, target, department_id, preview_hash from memory_scopes preview_project). Archived = kept but never loaded into a reply. Forgetting a project is memory_scope_forget.
- export: the project's memory, pinned facts and handoff notes as Markdown files (project)
- department_create (name), department_rename (department_id, name), department_delete (department_id, preview_hash from preview_department_delete; its projects go to General)
- pinned_add (scope = company | department:<id> | project:<slug>, text), pinned_update (fact_id, text?, position?), pinned_remove (fact_id)
- rules_set: review rules of a scope (scope; routine = save | ask, important = ask | save, contradiction = ask | keep_new | keep_both,
  "inherit" = from the level above; reviewer_agent_id ("none" clears) for a department; weekly_day 0-6 + weekly_hour 0-23 for the company's weekly summary)`,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...APPLY_ACTIONS] },
      project: { type: 'string' },
      project_action: { type: 'string', enum: PROJECT_ACTIONS.filter((a) => a !== 'forget') },
      target: { type: 'string' },
      department_id: { type: 'string' },
      name: { type: 'string' },
      scope: { type: 'string' },
      text: { type: 'string' },
      fact_id: { type: 'string' },
      position: { type: 'number' },
      preview_hash: { type: 'string' },
      routine: { type: 'string', enum: ['save', 'ask', 'inherit'] },
      important: { type: 'string', enum: ['ask', 'save', 'inherit'] },
      contradiction: { type: 'string', enum: ['ask', 'keep_new', 'keep_both', 'inherit'] },
      reviewer_agent_id: { type: 'string', description: 'rules_set: the department reviewer agent ("none" clears it)' },
      weekly_day: { type: 'number', minimum: 0, maximum: 6 },
      weekly_hour: { type: 'number', minimum: 0, maximum: 23 },
    },
    required: ['action'],
  },
  async execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    const gate = await ownerGate(context);
    if ('refused' in gate) return fail('memory_scope_apply', gate.refused);
    const { ownerId } = gate;
    const by = actorLabel(toolActor(context));
    try {
      switch (params.action) {
        case 'project': {
          const input = parseActionInput({ action: params.project_action, target: params.target, departmentId: params.department_id });
          if (input.action === 'forget') return fail('memory_scope_apply', 'use memory_scope_forget to forget a project');
          const slug = String(params.project ?? '');
          // The owner's approval of this call is the explicit confirm.
          const { preview, result } = await applyProjectAction(ownerId, slug, input, params.preview_hash, by, await resolveFileAgent(context?.agentId).catch(() => '(none)'));
          auditTool(context, `memory_scope.project_${input.action}`, 'memory_project', slug, { effects: preview.effects });
          return ok(`Done: ${input.action} ${slug}. ${json(result)}`, { action: input.action, project: preview.project, result });
        }
        case 'export': {
          const out = await exportProject(ownerId, String(params.project ?? ''));
          auditTool(context, 'memory_scope.project_export', 'memory_project', out.project.slug, { files: out.files.map((f) => f.name) });
          return ok(`Exported ${out.files.length} files for ${out.project.slug}.`, out as unknown as Record<string, unknown>);
        }
        case 'department_create': {
          const d = await createDepartment(ownerId, params.name, by);
          invalidateScopeTree(ownerId);
          auditTool(context, 'memory_scope.department_create', 'memory_department', d.id, { name: d.name });
          return ok(`Department ${d.name} created (${d.id}).`, { department: d });
        }
        case 'department_rename': {
          const d = await renameDepartment(ownerId, String(params.department_id ?? ''), params.name);
          invalidateScopeTree(ownerId);
          auditTool(context, 'memory_scope.department_rename', 'memory_department', d.id, { name: d.name });
          return ok(`Department renamed to ${d.name}.`, { department: d });
        }
        case 'department_delete': {
          const out = await deleteDepartment(ownerId, String(params.department_id ?? ''), params.preview_hash);
          auditTool(context, 'memory_scope.department_delete', 'memory_department', out.department.id, { effects: out.effects });
          return ok(`Department ${out.department.name} deleted; its projects are in General.`, { department: out.department, effects: out.effects });
        }
        case 'pinned_add': {
          const refused = pinnedWriteRefusal(context, typeof params.scope === 'string' ? params.scope : '');
          if (refused) return fail('memory_scope_apply', refused);
          const fact = await addPinnedFact(ownerId, parsePinnedScope(params.scope), params.text, by);
          invalidateScopeTree(ownerId);
          auditTool(context, 'memory_scope.pinned_add', 'memory_pinned_fact', fact.id, { scope: fact.scope });
          return ok(`Pinned to ${fact.scope}.`, { fact });
        }
        case 'pinned_update': {
          const refused = pinnedWriteRefusal(context, (await pinnedFactScope(ownerId, String(params.fact_id ?? ''))) ?? '');
          if (refused) return fail('memory_scope_apply', refused);
          const fact = await updatePinnedFact(ownerId, String(params.fact_id ?? ''), { text: params.text, position: params.position });
          auditTool(context, 'memory_scope.pinned_update', 'memory_pinned_fact', fact.id, { scope: fact.scope });
          return ok('Pinned fact updated.', { fact });
        }
        case 'pinned_remove': {
          const refused = pinnedWriteRefusal(context, (await pinnedFactScope(ownerId, String(params.fact_id ?? ''))) ?? '');
          if (refused) return fail('memory_scope_apply', refused);
          const fact = await removePinnedFact(ownerId, String(params.fact_id ?? ''));
          if (!fact) return fail('memory_scope_apply', 'pinned fact not found');
          invalidateScopeTree(ownerId);
          auditTool(context, 'memory_scope.pinned_remove', 'memory_pinned_fact', fact.id, { scope: fact.scope });
          return ok('Pinned fact removed.', { fact });
        }
        case 'rules_set': {
          const changes: Record<string, unknown> = {};
          for (const [k, f] of [['routine', 'routine'], ['important', 'important'], ['contradiction', 'contradiction'], ['reviewer_agent_id', 'reviewerAgentId'], ['weekly_day', 'weeklyDay'], ['weekly_hour', 'weeklyHour']] as const) {
            if (params[k] !== undefined) changes[f] = params[k] === 'inherit' || params[k] === 'none' ? null : params[k];
          }
          const out = await setScopeRules(ownerId, params.scope ?? 'company', changes, by);
          auditTool(context, 'memory_scope.rules_set', 'memory_scope_rules', out.scope, { changes });
          return ok(`Rules of ${out.scope} saved: routine ${out.effective.routine}, important ${out.effective.important}, contradiction ${out.effective.contradiction}.`, out as unknown as Record<string, unknown>);
        }
        default:
          return fail('memory_scope_apply', `action must be one of ${APPLY_ACTIONS.join(', ')}`);
      }
    } catch (err) {
      if (err instanceof ScopeInputError) return fail('memory_scope_apply', err.message);
      throw err;
    }
  },
};

export const memoryAccessApplyTool: Tool = {
  name: 'memory_access_apply',
  description: `Change who may read and write which memory drawers, after the owner approves this call.
Give the same changes you previewed with memory_scopes preview_access and its previewHash. Changes:
- { op: "set_rule", scope: "company" | "department:<id>" | "project:<slug>", agentId?, drawerKind, read: allow|deny|inherit, write: allow|deny|inherit, endsAt? (agent exceptions only), reason? }
  drawerKind is a drawer kind (owner, project, experience, task, people) or a scope column: "company" (company pinned facts)
  or "department" (the project's department pinned facts)
- { op: "clear_rule", scope, agentId?, drawerKind }
- { op: "save_template", id?, name, memoryRead: [kinds], memoryWrite: [kinds], scopeRead?: ["company"|"department"] | null, scopeWrite?: [...] }, { op: "delete_template", id }
  (scopeRead left out = keep the template's scope columns; null = no limit on them)
- { op: "assign_template", template: id | name | null, agentIds: [...] }
Rules only narrow what an agent's own permissions allow.`,
  input_schema: {
    type: 'object',
    properties: { changes: { type: 'array', items: { type: 'object' } }, preview_hash: { type: 'string' } },
    required: ['changes', 'preview_hash'],
  },
  async execute(params: { changes?: unknown; preview_hash?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    const gate = await ownerGate(context);
    if ('refused' in gate) return fail('memory_access_apply', gate.refused);
    try {
      const out = await applyAccessChanges(gate.ownerId, params.changes, params.preview_hash, actorLabel(toolActor(context)));
      invalidateScopeTree(gate.ownerId);
      const { sample: _sample, ...counts } = out.preview;
      auditTool(context, 'memory_access.apply', 'memory_access', gate.ownerId, { changes: params.changes, counts, version: out.version });
      return ok(`Access updated (version ${out.version}): ${out.preview.agentsAffected} agents, ${out.preview.projectsAffected} projects affected.`, out as unknown as Record<string, unknown>);
    } catch (err) {
      if (err instanceof ScopeInputError) return fail('memory_access_apply', err.message);
      throw err;
    }
  },
};

export const memoryScopeForgetTool: Tool = {
  name: 'memory_scope_forget',
  description: `Forget ALL memory of one project, after the owner approves this call. Cannot be undone: every memory
of the project drawer and its history are erased (a tombstone stays), plus its pinned facts, access rules,
waiting reviews and handoff notes. Give the previewHash from memory_scopes preview_project with project_action "forget".`,
  input_schema: {
    type: 'object',
    properties: { project: { type: 'string' }, preview_hash: { type: 'string' } },
    required: ['project', 'preview_hash'],
  },
  async execute(params: { project?: unknown; preview_hash?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    const gate = await ownerGate(context);
    if ('refused' in gate) return fail('memory_scope_forget', gate.refused);
    const slug = String(params.project ?? '');
    try {
      const { preview, result } = await applyProjectAction(gate.ownerId, slug, { action: 'forget', target: null, departmentId: null }, params.preview_hash, actorLabel(toolActor(context)));
      auditTool(context, 'memory_scope.project_forget', 'memory_project', slug, { effects: preview.effects, result });
      return ok(`Project ${slug} forgotten: ${json(result)}`, { result });
    } catch (err) {
      if (err instanceof ScopeInputError) return fail('memory_scope_forget', err.message);
      throw err;
    }
  },
};
