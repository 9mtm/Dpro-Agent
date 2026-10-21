/**
 * A project's design and databases for agents (DESIGN-FIND-01, PROJECT-TECH-01):
 * the same data and owner choices as /api/memory/projects/:slug/design and
 * …/databases.
 *
 * project_design           read: colours (main marked), fonts, logos, rules,
 *                          open questions. Any run of the owner whose project
 *                          drawer is open, or the owner's own turn.
 * project_design_apply     main logo, not a logo, main colour, DESIGN.md switch,
 *                          undo ('settings' approval; owner's own turn).
 * project_databases        read: the project's databases as THIS agent's level
 *                          allows (exists: engine and name; tables: + table
 *                          names; data: + rows only by asking the owner each
 *                          time). Same gate as project_design.
 * project_databases_apply  set an agent's level ('settings' approval; owner's own turn).
 *
 * Never in a turn that answers an outsider. Never a row, never a password.
 */

import type { Tool, ToolResult, ToolExecutionContext } from '../types.js';
import { one, sql } from '../../repositories/sql-steps.js';
import { toolMemoryDrawers, toolMemoryUser, toolOwnerTurn } from './scope.js';
import { auditTool, ownerGate } from './scopes.js';
import { ScopeInputError } from '../../memory/scopes/store.js';
import { designBlock, getDesign, patchDesign, undoDesign } from '../../memory/project-design.js';
import { databasesForAgent, setDatabaseAccess } from '../../memory/project-databases.js';

const fail = (tool: string, msg: string): ToolResult => ({ content: [{ type: 'text', text: `${tool} refused: ${msg}` }], error: msg });
const ok = (text: string, data: Record<string, unknown>): ToolResult => ({ content: [{ type: 'text', text }], data: { success: true, ...data } } as ToolResult);

/** The owner and the project for a read: the project drawer is open for the run, or it is the owner's own turn. */
async function readGate(params: { project?: unknown }, context?: ToolExecutionContext): Promise<{ ownerId: string; slug: string } | { refused: string }> {
  const userId = toolMemoryUser(context);
  if (!userId) return { refused: 'no user for this memory' };
  if (context?.toolPolicy) return { refused: 'not available when answering someone else' };
  const row = await sql().read(one<{ role: string }>('SELECT role FROM users WHERE id = ?', userId));
  if (row?.role !== 'owner') return { refused: 'only for the owner\'s projects' };
  const open = toolMemoryDrawers(context).filter((d) => d.kind === 'project' && d.key).map((d) => d.key!);
  const slug = typeof params.project === 'string' && params.project ? params.project : open[0];
  if (!slug) return { refused: 'give project (no project is open in this conversation)' };
  if (!open.includes(slug) && !toolOwnerTurn(context)) return { refused: 'that project is not open for this run' };
  return { ownerId: userId, slug };
}

async function run(tool: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try { return await fn(); } catch (err) {
    if (err instanceof ScopeInputError) return fail(tool, err.message);
    throw err;
  }
}

export const projectDesignTool: Tool = {
  name: 'project_design',
  description: `The design Dpro found for a project (colours with the main one marked, fonts, logos, the owner's design rules,
open questions). Read it before you change any screen of the project; DESIGN.md in the project folder holds the same section.
project: the project slug (default: the project open in this conversation).`,
  input_schema: { type: 'object', properties: { project: { type: 'string' } } },
  async execute(params: { project?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    const gate = await readGate(params, context);
    if ('refused' in gate) return fail('project_design', gate.refused);
    return run('project_design', async () => {
      const v = await getDesign(gate.ownerId, gate.slug);
      const empty = !v.colours.length && !v.fonts.length && !v.logos.length && !v.rules.length;
      return ok(empty ? `No design found for ${gate.slug} yet.` : designBlock(v), { design: v });
    });
  },
};

export const projectDesignApplyTool: Tool = {
  name: 'project_design_apply',
  description: `Change a project's design choices, after the owner approves this call. project (slug) and any of:
main_logo (logo id from project_design, or "none"), not_logo (logo id: not a logo, leaves the list),
main_colour (a colour value from project_design: answers "which colour is the main one?"),
write_file (true/false: keep DESIGN.md in the project folder), undo (true: the last automatic change goes back).`,
  input_schema: {
    type: 'object',
    properties: { project: { type: 'string' }, main_logo: { type: 'string', description: 'logo id, or "none" to let Dpro pick' }, not_logo: { type: 'string' }, main_colour: { type: 'string', description: 'colour value, or "none"' }, write_file: { type: 'boolean' }, undo: { type: 'boolean' } },
    required: ['project'],
  },
  async execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    const gate = await ownerGate(context);
    if ('refused' in gate) return fail('project_design_apply', gate.refused);
    const slug = String(params.project ?? '');
    return run('project_design_apply', async () => {
      if (params.undo === true) {
        const v = await undoDesign(gate.ownerId, slug);
        auditTool(context, 'memory_project.design_undo', 'memory_project', slug, {});
        return ok(`Design of ${slug}: the last automatic change went back.`, { design: v });
      }
      const patch: Record<string, unknown> = {};
      if (params.main_logo !== undefined) patch.mainLogo = params.main_logo === 'none' ? null : params.main_logo;
      if (params.not_logo !== undefined) patch.notLogo = params.not_logo;
      if (params.main_colour !== undefined) patch.mainColour = params.main_colour === 'none' ? null : params.main_colour;
      if (params.write_file !== undefined) patch.writeFile = params.write_file;
      const v = await patchDesign(gate.ownerId, slug, patch);
      auditTool(context, 'memory_project.design', 'memory_project', slug, { fields: Object.keys(patch) });
      return ok(`Design of ${slug} updated.${v.file.problem ? ` DESIGN.md: ${v.file.problem}` : ''}`, { design: v });
    });
  },
};

export const projectDatabasesTool: Tool = {
  name: 'project_databases',
  description: `The local databases Dpro found for a project, as much as the owner lets this agent see:
"exists" (engine, name, place), "tables" (+ table names) or "data" (+ rows only by asking the owner each time).
Never a row and never a password here. project: the slug (default: the project open in this conversation).`,
  input_schema: { type: 'object', properties: { project: { type: 'string' } } },
  async execute(params: { project?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    const gate = await readGate(params, context);
    if ('refused' in gate) return fail('project_databases', gate.refused);
    return run('project_databases', async () => {
      const r = await databasesForAgent(gate.ownerId, gate.slug, context?.agentId ?? null);
      const lines = r.databases.map((d) => `- ${d.engine} · ${d.name} (${d.path})${d.tables ? `: ${d.tables.join(', ')}` : d.tableCount ? `: ${d.tableCount} tables` : ''}`);
      return ok(`${r.databases.length} databases in ${gate.slug}; your level: ${r.level}${r.level === 'data' ? ' (rows: ask the owner each time)' : ''}.\n${lines.join('\n')}`, r);
    });
  },
};

export const projectDatabasesApplyTool: Tool = {
  name: 'project_databases_apply',
  description: `Set how much one agent may see of a project's databases, after the owner approves this call:
project (slug), agent_id, level "exists" | "tables" | "data" (data: rows only by asking the owner each time) or "default" (back to exists).`,
  input_schema: {
    type: 'object',
    properties: { project: { type: 'string' }, agent_id: { type: 'string' }, level: { type: 'string', enum: ['exists', 'tables', 'data', 'default'] } },
    required: ['project', 'agent_id', 'level'],
  },
  async execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    const gate = await ownerGate(context);
    if ('refused' in gate) return fail('project_databases_apply', gate.refused);
    return run('project_databases_apply', async () => {
      const out = await setDatabaseAccess(gate.ownerId, String(params.project ?? ''), { agentId: params.agent_id, level: params.level === 'default' ? null : params.level }, `agent:${context?.agentId ?? ''}`);
      auditTool(context, 'memory_project.database_access', 'memory_project', out.project, { agentId: out.agentId, level: out.level });
      return ok(`${out.agentId} now sees "${out.level}" for the databases of ${out.project}.`, out);
    });
  },
};
