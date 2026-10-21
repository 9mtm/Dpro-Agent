/**
 * memory_bridge / memory_bridge_apply tools (MEM-BRIDGE-01): the same
 * operations as the owner API, with the same gates.
 *
 * memory_bridge        read only: status, dry-run previews of a project's managed
 *                      files and of a CLI's MCP registration
 * memory_bridge_apply  every call needs one-time owner approval (approvals.ts,
 *                      'settings'); the approval is the explicit confirm. Writing
 *                      files / registering carries the previewHash of the preview
 *                      the owner saw (a changed file -> refused). Also: undo a
 *                      registration, kill switch per CLI, back-flow now.
 *
 * Owner's own turns only: never when answering an outside sender, never for
 * an account other than the owner.
 */
import type { Tool, ToolResult, ToolExecutionContext } from '../types.js';
import { toolActor } from '../../repositories/actor.js';
import {
  backflowNow, BridgeError, bridgeStatus, filesApply, filesPreview, registrationApply, registrationPreview, registrationUndo, setClient, setFolder,
} from '../../memory/bridge/service.js';
import { BRIDGE_CLIENTS } from '../../memory/bridge/clients.js';

const fail = (msg: string): ToolResult => ({ content: [{ type: 'text', text: `Memory bridge refused: ${msg}` }], error: msg });
const ok = (text: string, data: unknown): ToolResult => ({ content: [{ type: 'text', text }], data: { success: true, ...(data as object) } } as ToolResult);

/** The owner id when this is the owner's own turn, else a refusal text. */
function ownerOf(context?: ToolExecutionContext): string | { refused: string } {
  if (context?.toolPolicy) return { refused: 'not available when answering someone else' };
  let a;
  try { a = toolActor(context); } catch { return { refused: 'no user for this run' }; }
  if (a.channel) return { refused: 'not available in a channel turn' };
  if (a.role !== 'owner' || !a.userId) return { refused: 'only for the owner' };
  return a.userId;
}

async function guarded(context: ToolExecutionContext | undefined, fn: (owner: string, actor: string) => Promise<ToolResult>): Promise<ToolResult> {
  const owner = ownerOf(context);
  if (typeof owner !== 'string') return fail(owner.refused);
  try { return await fn(owner, `agent:${context?.agentId ?? 'unknown'}`); } catch (err) {
    if (err instanceof BridgeError) return fail(err.message);
    throw err;
  }
}

export const memoryBridgeTool: Tool = {
  name: 'memory_bridge',
  description: `Dpro's memory bridge to Claude Code, Codex, Gemini CLI and Antigravity (read only).
action "status": which CLIs are on, registered, and which project folders have managed files.
action "preview_files" (project_id): the AGENTS.md / CLAUDE.md / GEMINI.md change for a project folder, as a diff, with a previewHash.
action "preview_registration" (client): the dpro-memory entry for that CLI's config file, with a previewHash.
To apply a preview, call memory_bridge_apply with its previewHash (the owner approves the call).`,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'preview_files', 'preview_registration'] },
      project_id: { type: 'string' },
      client: { type: 'string', enum: [...BRIDGE_CLIENTS] },
    },
    required: ['action'],
  },
  async execute(params: { action?: unknown; project_id?: unknown; client?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    return guarded(context, async (owner) => {
      if (params.action === 'status') {
        const s = await bridgeStatus(owner);
        return ok(`CLIs: ${s.clients.map((c) => `${c.name} ${c.enabled ? 'on' : 'off'}${c.registrationId ? ' (registered)' : ''}`).join(', ')}. Project folders: ${s.projects.length}.`, s);
      }
      if (params.action === 'preview_files') {
        const p = await filesPreview(owner, params.project_id);
        return ok(`${p.changes} file change(s), ${p.conflicts} conflict(s) in ${p.folder}. previewHash ${p.previewHash}\n${p.files.map((f) => `${f.relative}: ${f.action}${f.reason ? ` (${f.reason})` : ''}`).join('\n')}`, p);
      }
      if (params.action === 'preview_registration') {
        const p = await registrationPreview(owner, params.client);
        return ok(`${p.name}: ${p.action}${p.reason ? ` (${p.reason})` : ''} in ${p.configPath}. previewHash ${p.previewHash}`, p);
      }
      return fail('unknown action');
    });
  },
};

export const memoryBridgeApplyTool: Tool = {
  name: 'memory_bridge_apply',
  description: `Change Dpro's memory bridge after the owner approves this call.
action "apply_files" (project_id, preview_hash): write the previewed managed section into the project's AGENTS.md / CLAUDE.md / GEMINI.md (only between Dpro's markers) and keep it in sync.
action "stop_files" (project_id): stop updating that folder's files (they stay as they are).
action "register" (client, preview_hash): add the dpro-memory server to that CLI's config (the original is backed up first).
action "undo_registration" (registration_id): restore the CLI config.
action "set_client" (client, enabled): kill switch for one CLI.
action "set_backflow" (project_id, enabled): import that folder's CLI memory files as review proposals from now on.
action "backflow_now" (project_id): do that import once now.`,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['apply_files', 'stop_files', 'register', 'undo_registration', 'set_client', 'set_backflow', 'backflow_now'] },
      project_id: { type: 'string' },
      client: { type: 'string', enum: [...BRIDGE_CLIENTS] },
      preview_hash: { type: 'string' },
      registration_id: { type: 'string' },
      enabled: { type: 'boolean' },
    },
    required: ['action'],
  },
  async execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    // The owner's approval of this call is the explicit confirm.
    return guarded(context, async (owner, actor) => {
      switch (params.action) {
        case 'apply_files': { const r = await filesApply(owner, params.project_id, { previewHash: params.preview_hash, confirm: true }, actor); return ok(`${r.changes} file(s) written in ${r.folder}.`, r); }
        case 'stop_files': { const r = await setFolder(owner, params.project_id, { filesEnabled: false }, actor); return ok('Managed files are no longer updated for this folder.', r); }
        case 'register': { const r = await registrationApply(owner, params.client, { previewHash: params.preview_hash, confirm: true }, actor); return ok(`dpro-memory ${r.registration ? 'registered' : 'already registered'} in ${r.preview.configPath}.`, r); }
        case 'undo_registration': { const r = await registrationUndo(owner, params.registration_id, actor); return ok(`Registration undone (${r.mode}).`, r); }
        case 'set_client': { const r = await setClient(owner, params.client, params.enabled, actor); return ok(`${r.client} is ${r.enabled ? 'on' : 'off'}.`, r); }
        case 'set_backflow': { const r = await setFolder(owner, params.project_id, { backflowEnabled: params.enabled }, actor); return ok(`Back-flow ${r.backflowEnabled ? 'on' : 'off'}.`, r); }
        case 'backflow_now': { const r = await backflowNow(owner, params.project_id, actor); return ok(`${r.proposed} proposal(s) from ${r.files} file(s); the owner reviews them in Memory.`, r); }
        default: return fail('unknown action');
      }
    });
  },
};
