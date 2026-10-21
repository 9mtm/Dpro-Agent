/**
 * Memory bridge operations (MEM-BRIDGE-01), shared by the owner-only REST API,
 * the owner's agent tools and the dpro-memory MCP server:
 *
 *   owner        status, kill switch per CLI, managed files (preview -> confirm),
 *                registration (preview -> confirm -> undo), back-flow, sync
 *   MCP server   read tools (project_brief, pinned_facts, latest_handoff, memory_search, project_design)
 *                and write tools that only create review proposals (memory_propose)
 *                or handoff notes (handoff_write), for the project whose folder the
 *                CLI runs in; nothing for a folder Dpro does not know
 */
import { designBlock, getDesign } from '../project-design.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { q } from '../../repositories/sql-steps.js';
import type { Project } from '../../repositories/chat-conversations.js';
import { findProject, listProjects } from '../../repositories/chat-conversations.js';
import { getMemoryStorage } from '../storage.js';
import { learn } from '../learning.js';
import { cleanHandoff, HandoffInputError } from '../handoff/store.js';
import { BRIDGE_CLIENTS, CLIENT_NAMES, clientConfigFile, isBridgeClient, launchReady, serverLaunch, type BridgeClient, type BridgeEnv } from './clients.js';
import { briefHash, briefMarkdown, clean, handoffText, projectBrief, projectDrawer, projectHandoff, pinnedFacts } from './brief.js';
import { applyFiles, ManagedFileError, previewFiles, type FilesPreview } from './managed-files.js';
import { applyRegistration, previewRegistration, RegistrationError, undoRegistration } from './registration.js';
import { runBackflow, type BackflowResult } from './backflow.js';
import { ensureToken, revokeToken, tokenMatches, checkSessionProof } from './auth.js';
import {
  allFolderSettings, audit, auditLog, bridgeOwner, clientEnabled, clientStates, folderSettings, lastCalls, listRegistrations, patchFolder,
  projectForFolder, saveBridgeHandoff, setClientEnabled,
} from './store.js';

export class BridgeError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'invalid_request') { super(message); }
}

/** Where CLI configs live; tests point this at a temporary HOME. */
let bridgeEnv: BridgeEnv = {};
export function setBridgeEnv(where: BridgeEnv): void { bridgeEnv = where; }
const where = (): BridgeEnv => ({ home: bridgeEnv.home ?? os.homedir(), env: bridgeEnv.env ?? process.env });

async function ownProject(ownerId: string, projectId: unknown): Promise<Project> {
  if (typeof projectId !== 'string' || !projectId) throw new BridgeError('projectId is required');
  const p = await findProject(ownerId, projectId);
  if (!p) throw new BridgeError('Not found', 404, 'not_found');
  if (!p.folder) throw new BridgeError('This project has no folder on this computer', 400, 'no_folder');
  return p;
}

function client(value: unknown): BridgeClient {
  if (!isBridgeClient(value)) throw new BridgeError(`client must be one of ${BRIDGE_CLIENTS.join(', ')}`);
  return value;
}

/** Errors of the parts as BridgeError (one shape for the API and the tools). */
async function wrap<T>(fn: () => Promise<T> | T): Promise<T> {
  try { return await fn(); } catch (err) {
    if (err instanceof ManagedFileError || err instanceof RegistrationError) throw new BridgeError(err.message, err.status, err.code);
    throw err;
  }
}

// --- owner -----------------------------------------------------------------

export async function bridgeStatus(ownerId: string) {
  const states = await clientStates(ownerId);
  const regs = await listRegistrations(ownerId);
  const folders = new Map((await allFolderSettings(ownerId)).map((f) => [f.projectId, f]));
  const projects = (await listProjects(ownerId)).filter((p) => p.folder);
  const calls = await lastCalls(ownerId);
  return {
    clients: BRIDGE_CLIENTS.map((c) => {
      const active = regs.find((r) => r.client === c && r.status === 'applied');
      const last = calls.get(c);
      return { client: c, name: CLIENT_NAMES[c], enabled: states[c], configPath: clientConfigFile(c, where()), registrationId: active?.id ?? null, registeredAt: active?.createdAt ?? null,
        lastCallAt: last?.at ?? null, lastTool: last?.tool ?? null };
    }),
    projects: projects.map((p) => {
      const f = folders.get(p.id);
      return { projectId: p.id, name: p.name, folder: p.folder, filesEnabled: !!f?.filesEnabled, backflowEnabled: !!f?.backflowEnabled, gitExclude: f?.gitExclude ?? true, writtenAt: f?.writtenAt ?? null, confirmedAt: f?.confirmedAt ?? null };
    }),
    registrations: regs,
    serverReady: launchReady(serverLaunch('claude-code')),
  };
}

/** Kill switch per CLI. Off also deletes the CLI's token (a running server loses access at once). */
export async function setClient(ownerId: string, c: unknown, enabled: unknown, actor = 'owner') {
  const cl = client(c);
  if (typeof enabled !== 'boolean') throw new BridgeError('enabled must be true or false');
  await setClientEnabled(ownerId, cl, enabled);
  if (!enabled) await revokeToken(ownerId, cl);
  await audit(ownerId, enabled ? 'client-on' : 'client-off', { client: cl, note: actor });
  return { client: cl, enabled };
}

export async function filesPreview(ownerId: string, projectId: unknown): Promise<FilesPreview> {
  const p = await ownProject(ownerId, projectId);
  const f = await folderSettings(ownerId, p.id);
  return wrap(async () => previewFiles(p.id, await projectBrief(ownerId, p), p.folder, f.gitExclude));
}

/** Owner confirm per folder: writes the previewed files and keeps them in sync from now on. */
export async function filesApply(ownerId: string, projectId: unknown, input: { previewHash?: unknown; confirm?: unknown }, actor = 'owner'): Promise<FilesPreview> {
  if (input?.confirm !== true) throw new BridgeError('Send confirm: true after reviewing the preview', 400, 'confirm_required');
  if (typeof input.previewHash !== 'string') throw new BridgeError('previewHash is required');
  const p = await ownProject(ownerId, projectId);
  const f = await folderSettings(ownerId, p.id);
  const brief = await projectBrief(ownerId, p);
  const result = await wrap(() => applyFiles(p.id, brief, p.folder, f.gitExclude, input.previewHash as string));
  await patchFolder(ownerId, p.id, { filesEnabled: true, briefHash: briefHash(brief), confirmed: true, written: true });
  await audit(ownerId, 'files-written', { projectId: p.id, note: `${result.changes} file(s) by ${actor}` });
  return result;
}

export async function setFolder(ownerId: string, projectId: unknown, patch: { filesEnabled?: unknown; backflowEnabled?: unknown; gitExclude?: unknown }, actor = 'owner') {
  const p = await ownProject(ownerId, projectId);
  const next: { filesEnabled?: boolean; backflowEnabled?: boolean; gitExclude?: boolean } = {};
  for (const k of ['filesEnabled', 'backflowEnabled', 'gitExclude'] as const) {
    if (patch?.[k] === undefined) continue;
    if (typeof patch[k] !== 'boolean') throw new BridgeError(`${k} must be true or false`);
    next[k] = patch[k] as boolean;
  }
  // Turning files on happens only through preview + confirm (filesApply).
  if (next.filesEnabled === true) throw new BridgeError('Turn managed files on with the preview and confirm', 400, 'confirm_required');
  const f = await patchFolder(ownerId, p.id, next);
  await audit(ownerId, 'folder-settings', { projectId: p.id, note: `${JSON.stringify(next)} by ${actor}` });
  return f;
}

export async function backflowNow(ownerId: string, projectId: unknown, actor = 'owner'): Promise<BackflowResult> {
  const p = await ownProject(ownerId, projectId);
  const r = await runBackflow(ownerId, p, { home: where().home });
  await audit(ownerId, 'backflow-run', { projectId: p.id, note: `${r.proposed} proposal(s) by ${actor}` });
  return r;
}

export async function registrationPreview(_ownerId: string, c: unknown) {
  return wrap(() => previewRegistration(client(c), where()));
}

export async function registrationApply(ownerId: string, c: unknown, input: { previewHash?: unknown; confirm?: unknown }, actor = 'owner') {
  const cl = client(c);
  const r = await wrap(() => applyRegistration(ownerId, cl, input ?? {}, where()));
  await setClientEnabled(ownerId, cl, true);
  await audit(ownerId, 'registered', { client: cl, note: `${r.preview.action} by ${actor}` });
  return r;
}

export async function registrationUndo(ownerId: string, id: unknown, actor = 'owner') {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new BridgeError('Not found', 404, 'not_found');
  const r = await wrap(() => undoRegistration(ownerId, id));
  await setClientEnabled(ownerId, r.registration.client, false);
  await revokeToken(ownerId, r.registration.client);
  await audit(ownerId, 'unregistered', { client: r.registration.client, note: `${r.mode} by ${actor}` });
  return r;
}

/** The bridge's activity log for the owner (API and tool): newest first, optionally one CLI or one project. */
export async function activity(ownerId: string, input: { limit?: unknown; client?: unknown; projectId?: unknown } = {}) {
  const limit = input.limit === undefined ? 100 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new BridgeError('limit must be 1-500');
  const c = input.client === undefined ? undefined : client(input.client);
  let projectId: string | undefined;
  if (input.projectId !== undefined) {
    if (typeof input.projectId !== 'string' || !(await findProject(ownerId, input.projectId))) throw new BridgeError('Not found', 404, 'not_found');
    projectId = input.projectId;
  }
  return auditLog(ownerId, limit, { client: c, projectId });
}

export { auditLog };

/**
 * Keeps confirmed folders current: files are rewritten (inside the markers
 * only) when the brief changed; back-flow runs where the owner turned it on.
 */
export async function syncOwner(ownerId: string): Promise<{ written: number; proposed: number; conflicts: number }> {
  const out = { written: 0, proposed: 0, conflicts: 0 };
  for (const f of await allFolderSettings(ownerId)) {
    const p = await findProject(ownerId, f.projectId);
    if (!p?.folder) continue;
    if (f.filesEnabled) {
      const brief = await projectBrief(ownerId, p);
      const h = briefHash(brief);
      if (h !== f.briefHash) {
        try {
          const r = applyFiles(p.id, brief, p.folder, f.gitExclude, null);
          await patchFolder(ownerId, p.id, { briefHash: h, written: true });
          if (r.changes) { out.written += r.changes; await audit(ownerId, 'files-synced', { projectId: p.id, note: `${r.changes} file(s)` }); }
        } catch (err) {
          if (!(err instanceof ManagedFileError)) throw err;
          out.conflicts++;
          await audit(ownerId, 'files-conflict', { projectId: p.id, note: err.message });
        }
      }
    }
    if (f.backflowEnabled) out.proposed += (await runBackflow(ownerId, p, { home: where().home })).proposed;
  }
  return out;
}

// --- automatic connection (MEM-UX-02) ---------------------------------------

/**
 * Once the owner allowed reading this computer (at least one folder allowed in
 * Settings › Memory › Folders and drives, DISCOVER-02), coding apps connect on
 * their own:
 *   - each coding app whose config is on this computer gets the dpro-memory
 *     server registered (the same preview + apply: the original config is
 *     backed up first; Undo restores it). An app the owner switched off, or
 *     whose registration the owner undid, is never registered again by itself.
 *   - each project folder without folder settings gets its managed files
 *     (default on; written only between Dpro's markers). A folder the owner
 *     turned off stays off; a conflict is recorded once and left alone.
 * Every step is audited ('automatic'). Never throws.
 */
export async function autoConnect(ownerId: string, allowed: boolean): Promise<{ registered: BridgeClient[]; folders: string[]; conflicts: number }> {
  const out = { registered: [] as BridgeClient[], folders: [] as string[], conflicts: 0 };
  if (!allowed) return out;
  const w = where();
  const regs = await listRegistrations(ownerId);
  const decided = new Set((await q.all<{ client: string }>('SELECT client FROM memory_bridge_clients WHERE owner_id = ?', ownerId)).map((r) => r.client));
  for (const cl of BRIDGE_CLIENTS) {
    if (decided.has(cl) || regs.some((r) => r.client === cl)) continue;
    const file = clientConfigFile(cl, w);
    const dirOk = path.dirname(file) !== (w.home ?? os.homedir()) && fs.existsSync(path.dirname(file));
    if (!fs.existsSync(file) && !dirOk) continue; // the app is not on this computer
    try {
      const preview = previewRegistration(cl, w);
      if (preview.action === 'conflict' || !launchReady(serverLaunch(cl))) continue;
      await applyRegistration(ownerId, cl, { previewHash: preview.previewHash, confirm: true }, w);
      await setClientEnabled(ownerId, cl, true);
      await audit(ownerId, 'registered', { client: cl, note: `${preview.action} automatic` });
      out.registered.push(cl);
    } catch (err) {
      if (!(err instanceof RegistrationError)) console.warn('[Memory bridge] automatic registration failed:', (err as Error)?.message);
    }
  }
  const known = new Set((await allFolderSettings(ownerId)).map((f) => f.projectId));
  for (const p of (await listProjects(ownerId)).filter((x) => x.folder && !known.has(x.id))) {
    try {
      const brief = await projectBrief(ownerId, p);
      applyFiles(p.id, brief, p.folder, true, null);
      await patchFolder(ownerId, p.id, { filesEnabled: true, briefHash: briefHash(brief), confirmed: true, written: true });
      await audit(ownerId, 'files-written', { projectId: p.id, note: 'automatic' });
      out.folders.push(p.id);
    } catch (err) {
      if (!(err instanceof ManagedFileError)) { console.warn('[Memory bridge] automatic files failed:', (err as Error)?.message); continue; }
      out.conflicts++;
      await patchFolder(ownerId, p.id, { filesEnabled: false });
      await audit(ownerId, 'files-conflict', { projectId: p.id, note: `automatic: ${err.message}` });
    }
  }
  return out;
}

// --- MCP server ------------------------------------------------------------

export const MCP_TOOLS = ['project_brief', 'pinned_facts', 'latest_handoff', 'memory_search', 'project_design', 'memory_propose', 'handoff_write'] as const;
export type McpTool = (typeof MCP_TOOLS)[number];

/** Session start of the MCP server: install proof -> the CLI's token (only while the CLI is on). */
export async function openSession(c: unknown, nonce: unknown, proof: unknown): Promise<{ token: string }> {
  const cl = client(c);
  const ownerId = await bridgeOwner();
  if (!ownerId) throw new BridgeError('Dpro has no owner yet', 403, 'no_owner');
  if (!checkSessionProof(cl, nonce, proof)) throw new BridgeError('Not allowed', 401, 'unauthenticated');
  if (!(await clientEnabled(ownerId, cl))) throw new BridgeError(`${CLIENT_NAMES[cl]} is switched off in Dpro`, 403, 'client_off');
  await audit(ownerId, 'session', { client: cl });
  return { token: await ensureToken(ownerId, cl) };
}

export interface McpAnswer { text: string; data: Record<string, unknown> }

/** One MCP tool call from a CLI running in `cwd`. */
export async function mcpCall(c: unknown, token: unknown, cwd: unknown, tool: unknown, args: Record<string, unknown> = {}): Promise<McpAnswer> {
  const cl = client(c);
  const ownerId = await bridgeOwner();
  if (!ownerId || !(await tokenMatches(ownerId, cl, token))) throw new BridgeError('Not allowed', 401, 'unauthenticated');
  if (!(await clientEnabled(ownerId, cl))) throw new BridgeError(`${CLIENT_NAMES[cl]} is switched off in Dpro`, 403, 'client_off');
  if (typeof tool !== 'string' || !(MCP_TOOLS as readonly string[]).includes(tool)) throw new BridgeError('Unknown tool', 400, 'unknown_tool');
  const project = typeof cwd === 'string' ? await projectForFolder(ownerId, cwd) : null;
  if (!project) throw new BridgeError('Dpro does not know this folder. Add it as a project folder in Dpro first.', 404, 'unknown_folder');
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  // Reads are logged too (tool name only, never the query), so the owner sees which app used the memory and when.
  if (tool !== 'memory_propose' && tool !== 'handoff_write') await audit(ownerId, 'mcp-read', { client: cl, projectId: project.id, note: tool });

  switch (tool as McpTool) {
    case 'project_brief': {
      const b = await projectBrief(ownerId, project);
      return { text: briefMarkdown(b), data: { project: { id: project.id, name: b.name }, facts: b.facts.length, memories: b.memories.length, handoff: !!b.handoff } };
    }
    case 'pinned_facts': {
      const facts = await pinnedFacts(ownerId, project);
      return { text: facts.length ? facts.map((f) => `- ${f.content}`).join('\n') : 'The owner has not pinned facts for this project yet.', data: { facts } };
    }
    case 'latest_handoff': {
      const h = await projectHandoff(ownerId, project.id);
      return { text: h ? handoffText(h) : 'No handoff note in this project yet.', data: { handoff: h } };
    }
    case 'memory_search': {
      const query = typeof a.query === 'string' ? a.query.trim().slice(0, 500) : '';
      if (!query) throw new BridgeError('query is required');
      const limit = Math.min(Math.max(1, Number.isInteger(a.limit) ? (a.limit as number) : 8), 20);
      const hits = await getMemoryStorage().search({ userId: ownerId, query, drawers: [projectDrawer(project)], limit } as any);
      const results = hits.slice(0, limit).map((h) => ({ id: h.memory.id, content: clean(h.memory.content), score: Number(h.similarity.toFixed(3)) }));
      return { text: results.length ? results.map((r) => `- ${r.content}`).join('\n') : 'Nothing found in this project.', data: { results } };
    }
    case 'project_design': {
      // DESIGN-FIND-01: the design Dpro found for this project (the same text as DESIGN.md's Dpro section).
      const v = await getDesign(ownerId, projectDrawer(project).key!).catch(() => null);
      const has = !!v && (v.colours.length + v.fonts.length + v.logos.length + v.rules.length) > 0;
      return { text: has ? designBlock(v!) : 'Dpro has not found a design for this project yet.', data: { colours: v?.colours.length ?? 0, fonts: v?.fonts.length ?? 0, logos: v?.logos.length ?? 0, rules: v?.rules.length ?? 0, conflicts: v?.conflicts.length ?? 0 } };
    }
    case 'memory_propose': {
      const content = typeof a.content === 'string' ? a.content.trim() : '';
      if (!content || content.length > 4000) throw new BridgeError('content is required (at most 4000 characters)');
      const r = await learn({ userId: ownerId, actor: `bridge:${cl}`, review: true,
        candidates: [{ content, type: 'fact', importance: 5, drawer: projectDrawer(project), origin: 'agent' }] });
      const proposal = r.proposed[0];
      await audit(ownerId, 'mcp-propose', { client: cl, projectId: project.id, note: proposal ? `proposal ${proposal.id}` : (r.skipped[0]?.reason ?? 'nothing') });
      if (!proposal) return { text: `Not proposed: ${r.skipped[0]?.reason ?? 'nothing to add'}.`, data: { proposalId: null, reason: r.skipped[0]?.reason ?? null } };
      return { text: 'Proposed. The owner reviews it in Dpro; it becomes shared memory only after approval.', data: { proposalId: proposal.id } };
    }
    case 'handoff_write': {
      let body;
      try { body = cleanHandoff(a); } catch (err) {
        if (err instanceof HandoffInputError) throw new BridgeError(err.message);
        throw err;
      }
      const h = await saveBridgeHandoff(ownerId, project.id, cl, body);
      await audit(ownerId, 'mcp-handoff', { client: cl, projectId: project.id });
      return { text: 'Handoff saved. The next agent in this project, of any brand, starts from it.', data: { handoffId: h.id } };
    }
  }
}
