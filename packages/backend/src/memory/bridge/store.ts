/**
 * Memory bridge rows (MEM-BRIDGE-01, migration 115): kill switch per CLI,
 * per-folder file settings, back-flow marks, registrations, the handoff
 * notes outside CLIs write, and the audit trail. Everything is per owner.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { q } from '../../repositories/sql-steps.js';
import { listProjects, type Project } from '../../repositories/chat-conversations.js';
import type { HandoffBody } from '../handoff/store.js';
import { BRIDGE_CLIENTS, type BridgeClient } from './clients.js';

/** The active owner account (the bridge serves the owner only). */
export async function bridgeOwner(): Promise<string | null> {
  const r = await q.one<{ id: string }>("SELECT id FROM users WHERE role = 'owner' AND status = 'active' ORDER BY created_at, id LIMIT 1");
  return r?.id ?? null;
}

// --- kill switch per CLI ---------------------------------------------------

export async function clientEnabled(ownerId: string, client: BridgeClient): Promise<boolean> {
  const r = await q.one<{ enabled: number }>('SELECT enabled FROM memory_bridge_clients WHERE owner_id = ? AND client = ?', ownerId, client);
  return Number(r?.enabled ?? 0) === 1;
}

export async function setClientEnabled(ownerId: string, client: BridgeClient, enabled: boolean): Promise<void> {
  await q.run(`INSERT INTO memory_bridge_clients (owner_id, client, enabled, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (owner_id, client) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`, ownerId, client, enabled ? 1 : 0, now());
}

export async function clientStates(ownerId: string): Promise<Record<BridgeClient, boolean>> {
  const rows = await q.all<{ client: BridgeClient; enabled: number }>('SELECT client, enabled FROM memory_bridge_clients WHERE owner_id = ?', ownerId);
  const out = Object.fromEntries(BRIDGE_CLIENTS.map((c) => [c, false])) as Record<BridgeClient, boolean>;
  for (const r of rows) if (r.client in out) out[r.client] = Number(r.enabled) === 1;
  return out;
}

// --- known project folders -------------------------------------------------

const now = (): string => new Date().toISOString();
const real = (p: string): string | null => { try { return fs.realpathSync.native(p); } catch { return null; } };

/**
 * The owner's project whose folder is `cwd` or contains it (the deepest one).
 * A folder Dpro does not know gives null: the bridge serves nothing there.
 */
export async function projectForFolder(ownerId: string, cwd: string): Promise<Project | null> {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const here = real(cwd);
  if (!here) return null;
  let best: Project | null = null;
  let bestLen = -1;
  for (const p of await listProjects(ownerId)) {
    if (!p.folder) continue;
    const root = real(p.folder);
    if (!root || root === path.parse(root).root) continue;
    if ((here === root || here.startsWith(root + path.sep)) && root.length > bestLen) { best = p; bestLen = root.length; }
  }
  return best;
}

// --- per-folder settings ---------------------------------------------------

export interface FolderSettings { projectId: string; filesEnabled: boolean; backflowEnabled: boolean; gitExclude: boolean; briefHash: string | null; confirmedAt: string | null; writtenAt: string | null }
type FolderRow = { project_id: string; files_enabled: number; backflow_enabled: number; git_exclude: number; brief_hash: string | null; confirmed_at: string | null; written_at: string | null };
const toFolder = (r: FolderRow): FolderSettings => ({
  projectId: r.project_id, filesEnabled: Number(r.files_enabled) === 1, backflowEnabled: Number(r.backflow_enabled) === 1,
  gitExclude: Number(r.git_exclude) === 1, briefHash: r.brief_hash, confirmedAt: r.confirmed_at, writtenAt: r.written_at,
});

export async function folderSettings(ownerId: string, projectId: string): Promise<FolderSettings> {
  const r = await q.one<FolderRow>('SELECT * FROM memory_bridge_folders WHERE owner_id = ? AND project_id = ?', ownerId, projectId);
  return r ? toFolder(r) : { projectId, filesEnabled: false, backflowEnabled: false, gitExclude: true, briefHash: null, confirmedAt: null, writtenAt: null };
}

export async function allFolderSettings(ownerId: string): Promise<FolderSettings[]> {
  return (await q.all<FolderRow>('SELECT * FROM memory_bridge_folders WHERE owner_id = ?', ownerId)).map(toFolder);
}

export async function patchFolder(ownerId: string, projectId: string, patch: Partial<{ filesEnabled: boolean; backflowEnabled: boolean; gitExclude: boolean; briefHash: string | null; confirmed: boolean; written: boolean }>): Promise<FolderSettings> {
  const cur = await folderSettings(ownerId, projectId);
  const next = {
    files: patch.filesEnabled ?? cur.filesEnabled, back: patch.backflowEnabled ?? cur.backflowEnabled, git: patch.gitExclude ?? cur.gitExclude,
    hash: patch.briefHash !== undefined ? patch.briefHash : cur.briefHash,
  };
  await q.run(`INSERT INTO memory_bridge_folders (owner_id, project_id, files_enabled, backflow_enabled, git_exclude, brief_hash, confirmed_at, written_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (owner_id, project_id) DO UPDATE SET files_enabled = excluded.files_enabled, backflow_enabled = excluded.backflow_enabled,
      git_exclude = excluded.git_exclude, brief_hash = excluded.brief_hash, confirmed_at = excluded.confirmed_at, written_at = excluded.written_at, updated_at = excluded.updated_at`,
    ownerId, projectId, next.files ? 1 : 0, next.back ? 1 : 0, next.git ? 1 : 0, next.hash,
    patch.confirmed ? now() : cur.confirmedAt, patch.written ? now() : cur.writtenAt, now());
  return folderSettings(ownerId, projectId);
}

// --- back-flow marks -------------------------------------------------------

export async function seenChunks(ownerId: string, projectId: string, fileKey: string): Promise<Set<string>> {
  const rows = await q.all<{ chunk_hash: string }>('SELECT chunk_hash FROM memory_bridge_backflow WHERE owner_id = ? AND project_id = ? AND file_key = ?', ownerId, projectId, fileKey);
  return new Set(rows.map((r) => r.chunk_hash));
}

export async function markChunk(ownerId: string, projectId: string, fileKey: string, chunkHash: string, proposalId: string | null): Promise<void> {
  await q.run('INSERT INTO memory_bridge_backflow (owner_id, project_id, file_key, chunk_hash, proposal_id, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', ownerId, projectId, fileKey, chunkHash, proposalId, now());
}

// --- registrations ---------------------------------------------------------

export interface Registration { id: string; client: BridgeClient; configPath: string; backupPath: string | null; existed: boolean; beforeSha256: string | null; afterSha256: string; status: 'applied' | 'undone'; createdAt: string; undoneAt: string | null }
type RegRow = { id: string; client: BridgeClient; config_path: string; backup_path: string | null; existed: number; before_sha256: string | null; after_sha256: string; status: 'applied' | 'undone'; created_at: string; undone_at: string | null };
const toReg = (r: RegRow): Registration => ({
  id: r.id, client: r.client, configPath: r.config_path, backupPath: r.backup_path, existed: Number(r.existed) === 1,
  beforeSha256: r.before_sha256, afterSha256: r.after_sha256, status: r.status, createdAt: r.created_at, undoneAt: r.undone_at,
});

export async function addRegistration(ownerId: string, r: Omit<Registration, 'id' | 'status' | 'createdAt' | 'undoneAt'>): Promise<Registration> {
  const id = randomUUID();
  await q.run('INSERT INTO memory_bridge_registrations (id, owner_id, client, config_path, backup_path, existed, before_sha256, after_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, ownerId, r.client, r.configPath, r.backupPath, r.existed ? 1 : 0, r.beforeSha256, r.afterSha256, now());
  return (await getRegistration(ownerId, id))!;
}

export async function getRegistration(ownerId: string, id: string): Promise<Registration | undefined> {
  const r = await q.one<RegRow>('SELECT * FROM memory_bridge_registrations WHERE id = ? AND owner_id = ?', id, ownerId);
  return r ? toReg(r) : undefined;
}

export async function listRegistrations(ownerId: string): Promise<Registration[]> {
  return (await q.all<RegRow>('SELECT * FROM memory_bridge_registrations WHERE owner_id = ? ORDER BY created_at DESC, id DESC LIMIT 100', ownerId)).map(toReg);
}

export async function markUndone(ownerId: string, id: string): Promise<void> {
  await q.run("UPDATE memory_bridge_registrations SET status = 'undone', undone_at = ? WHERE id = ? AND owner_id = ?", now(), id, ownerId);
}

// --- handoffs written by outside CLIs ------------------------------------

export interface BridgeHandoff extends HandoffBody { id: string; projectId: string; client: BridgeClient; createdAt: string }
type HandoffRow = { id: string; project_id: string; client: BridgeClient; done: string; remaining: string; next_steps: string; open_questions: string; created_at: string };
const list = (s: string): string[] => { try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; } };
/** Notes kept per project (older ones are dropped). */
const MAX_BRIDGE_HANDOFFS = 20;

export async function saveBridgeHandoff(ownerId: string, projectId: string, client: BridgeClient, body: HandoffBody): Promise<BridgeHandoff> {
  const id = randomUUID();
  await q.run('INSERT INTO memory_bridge_handoffs (id, owner_id, project_id, client, done, remaining, next_steps, open_questions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, ownerId, projectId, client, JSON.stringify(body.done), JSON.stringify(body.left), JSON.stringify(body.next), JSON.stringify(body.questions), now());
  await q.run(`DELETE FROM memory_bridge_handoffs WHERE owner_id = ? AND project_id = ? AND id NOT IN
    (SELECT id FROM memory_bridge_handoffs WHERE owner_id = ? AND project_id = ? ORDER BY created_at DESC, id DESC LIMIT ${MAX_BRIDGE_HANDOFFS})`, ownerId, projectId, ownerId, projectId);
  return (await latestBridgeHandoff(ownerId, projectId))!;
}

const toBridgeHandoff = (r: HandoffRow): BridgeHandoff => ({
  id: r.id, projectId: r.project_id, client: r.client, done: list(r.done), left: list(r.remaining), next: list(r.next_steps), questions: list(r.open_questions), createdAt: r.created_at,
});

export async function latestBridgeHandoff(ownerId: string, projectId: string): Promise<BridgeHandoff | undefined> {
  const r = await q.one<HandoffRow>('SELECT * FROM memory_bridge_handoffs WHERE owner_id = ? AND project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', ownerId, projectId);
  return r ? toBridgeHandoff(r) : undefined;
}

/** Handoff notes coding apps wrote (read only in Dpro, MEM-GAPS-02 / board M12), newest first; optionally one project or one app. */
export async function listBridgeHandoffs(ownerId: string, filter: { projectId?: string; client?: BridgeClient; limit?: number } = {}): Promise<BridgeHandoff[]> {
  const where = ['owner_id = ?'];
  const params: string[] = [ownerId];
  if (filter.projectId) { where.push('project_id = ?'); params.push(filter.projectId); }
  if (filter.client) { where.push('client = ?'); params.push(filter.client); }
  const rows = await q.all<HandoffRow>(`SELECT * FROM memory_bridge_handoffs WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${Math.min(Math.max(1, filter.limit ?? 50), 200)}`, ...params);
  return rows.map(toBridgeHandoff);
}

// --- audit -----------------------------------------------------------------

export async function audit(ownerId: string, action: string, detail: { client?: BridgeClient | null; projectId?: string | null; note?: string } = {}): Promise<void> {
  await q.run('INSERT INTO memory_bridge_audit (id, owner_id, client, project_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    randomUUID(), ownerId, detail.client ?? null, detail.projectId ?? null, action.slice(0, 64), detail.note ? detail.note.slice(0, 300) : null, now());
}

/** Each coding app's newest call through dpro-memory (board M11 "Last call"): tool name and time, or absent. */
export async function lastCalls(ownerId: string): Promise<Map<string, { at: string; tool: string }>> {
  const rows = await q.all<{ client: string; action: string; detail: string | null; created_at: string }>(
    `SELECT a.client, a.action, a.detail, a.created_at FROM memory_bridge_audit a WHERE a.owner_id = ? AND a.client IS NOT NULL
       AND a.action IN ('mcp-read', 'mcp-propose', 'mcp-handoff')
       AND a.created_at = (SELECT MAX(b.created_at) FROM memory_bridge_audit b WHERE b.owner_id = a.owner_id AND b.client = a.client AND b.action IN ('mcp-read', 'mcp-propose', 'mcp-handoff'))`, ownerId);
  const out = new Map<string, { at: string; tool: string }>();
  const TOOL: Record<string, string> = { 'mcp-propose': 'memory_propose', 'mcp-handoff': 'handoff_write' };
  for (const r of rows) out.set(r.client, { at: r.created_at, tool: r.action === 'mcp-read' ? (r.detail ?? 'read') : TOOL[r.action] });
  return out;
}

/** What the bridge did, newest first; optionally only one CLI or one project. */
export async function auditLog(ownerId: string, limit = 100, filter: { client?: string; projectId?: string } = {}): Promise<Array<{ id: string; client: string | null; projectId: string | null; action: string; detail: string | null; createdAt: string }>> {
  const where = ['owner_id = ?'];
  const params: string[] = [ownerId];
  if (filter.client) { where.push('client = ?'); params.push(filter.client); }
  if (filter.projectId) { where.push('project_id = ?'); params.push(filter.projectId); }
  const rows = await q.all<{ id: string; client: string | null; project_id: string | null; action: string; detail: string | null; created_at: string }>(
    `SELECT * FROM memory_bridge_audit WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${Math.min(Math.max(1, limit), 500)}`, ...params);
  return rows.map((r) => ({ id: r.id, client: r.client, projectId: r.project_id, action: r.action, detail: r.detail, createdAt: r.created_at }));
}
