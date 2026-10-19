/**
 * Memory repository (B1-core): memories, drawers, versions, forget and the
 * owner's edit proposals / readable drawer files. Scope rules (scope.ts):
 *
 *   memories, drawers, versions, forget, tombstones
 *       a member account: its OWN memories only (S0-Q.11, there is no
 *       owner-wide memory view; another user's memory -> 404);
 *       an agent run: its run user's memories, and only in the drawers open
 *       for the run (CORE-03); forget is refused in a turn that answers an
 *       outsider; guests and channel turns: refused.
 *   proposals, drawer files (CORE-04)
 *       the owner account only, on the owner's own memory.
 *
 * Errors: out of scope -> ScopeError 404 (`Memory not found` /
 * `Proposal not found`); a closed drawer for an agent run -> ScopeError 403.
 *
 * One implementation for both drivers (B2.2b-4: the memory modules run their
 * SQL as SQL steps on the process driver) over memory/storage.ts,
 * learning.ts, versions.ts, forget.ts and memory-files.ts. Recall, learning and layers (search,
 * relevant, extract, save/edit/delete/reflect/stats tools) are in
 * memory-recall.ts; the owner's weekly summary, retention, embeddings,
 * forget-all and import pipeline in memory-owner.ts (B1.6); quality, sharing
 * and deduplication in memory-shared.ts (B1.7).
 */

import type { Actor } from './actor.js';
import { ScopeError, drawerOpen, drawerWritable, requireActor, requireMember } from './scope.js';
import { memoryOwner, memoryUser, memberUser, versionActor } from './memory-actor.js';
import { memoryDisplayPage } from '../memory/display-page.js';
import { memoryRecall, type MemoryRecallRepository } from './memory-recall.js';
import { memoryOwnerRepository, type MemoryOwnerRepository } from './memory-owner.js';
import { memoryShared, type MemorySharedRepository } from './memory-shared.js';
import { one, sql } from './sql-steps.js';
import { getMemoryStorage } from '../memory/storage.js';
import { defaultDrawerForType, normalizeDrawer, sameDrawer, type DrawerRef } from '../memory/drawers.js';
import { deleteVersioned, saveVersioned, updateVersioned } from '../memory/learning.js';
import { memoryVersions } from '../memory/versions.js';
import { forgetMemory, forgettableDrawer, listTombstones, type ForgetResult } from '../memory/forget.js';
import {
  approveProposal,
  createProposal,
  drawerVersions,
  exportDrawerFile,
  getProposal,
  listProposals,
  readDrawerFile,
  rejectProposal,
  viewDrawerFile,
  type ApplyResult,
  type DrawerFileView,
  type MemoryProposal,
} from '../memory/memory-files.js';
import type { Memory } from '../memory/types.js';

const NOT_FOUND = 'Memory not found';
const PROPOSAL_NOT_FOUND = 'Proposal not found';
/** Same wording the memory tools used before B1-core. */
export const DRAWER_CLOSED = 'that memory drawer is not open for this conversation';
export const OUTSIDER_REFUSED = 'not available when answering someone else';

export interface MemoryRepository extends MemoryRecallRepository, MemoryOwnerRepository, MemorySharedRepository {
  displayPage(actor: Actor | null | undefined, cursor?: string): ReturnType<typeof memoryDisplayPage>;
  list(actor: Actor | null | undefined): Promise<Memory[]>;
  drawers(actor: Actor | null | undefined): Promise<Array<DrawerRef & { count: number }>>;
  get(actor: Actor | null | undefined, id: string): Promise<Memory>;
  /** Throws like get() when the memory is out of scope; no access-count side effect. */
  assertAccess(actor: Actor | null | undefined, id: string): Promise<void>;
  create(actor: Actor | null | undefined, memory: Omit<Memory, 'userId'>, reason: string): Promise<Memory>;
  update(actor: Actor | null | undefined, id: string, updates: Partial<Memory>, reason: string): Promise<Memory>;
  delete(actor: Actor | null | undefined, id: string, reason: string): Promise<void>;
  versions(actor: Actor | null | undefined, id: string): Promise<any[]>;
  /** null when the memory does not exist (or is not the actor's). */
  forget(actor: Actor | null | undefined, id: string): Promise<ForgetResult | null>;
  tombstones(actor: Actor | null | undefined): Promise<Awaited<ReturnType<typeof listTombstones>>>;

  // Owner only (CORE-04)
  drawerFile(actor: Actor | null | undefined, agentId: string, drawer: DrawerRef): Promise<DrawerFileView>;
  drawerHistory(actor: Actor | null | undefined, drawer: DrawerRef): Promise<any[]>;
  exportDrawer(actor: Actor | null | undefined, agentId: string, drawer: DrawerRef): Promise<DrawerFileView>;
  readExportedDrawer(actor: Actor | null | undefined, agentId: string, drawer: DrawerRef): Promise<string>;
  createProposal(actor: Actor | null | undefined, input: { agentId: string; drawer: DrawerRef; text: string; source: 'upload' | 'file'; note: string | null }): Promise<MemoryProposal>;
  proposals(actor: Actor | null | undefined, status?: string): Promise<MemoryProposal[]>;
  proposal(actor: Actor | null | undefined, id: string): Promise<MemoryProposal>;
  /** `expectedReviewHash` = the reviewHash the caller reviewed (UI-IP-04). */
  approveProposal(actor: Actor | null | undefined, id: string, expectedReviewHash: unknown): Promise<ApplyResult>;
  rejectProposal(actor: Actor | null | undefined, id: string, expectedReviewHash: unknown, note?: unknown): Promise<MemoryProposal>;
}

async function memoryRowOwner(id: string): Promise<string | null> {
  if (typeof id !== 'string' || !id) return null;
  const row = await sql().read(one<{ user_id: string }>('SELECT user_id FROM memories WHERE id = ?', id));
  return row?.user_id ?? null;
}

/** The own memory row (no access-count side effect), drawer-checked for agent runs (writable when `write`). */
async function ownMemory(a: Actor, userId: string, id: string, write = false): Promise<Memory> {
  const m = await getMemoryStorage().getOwned(userId, id);
  if (!m) throw new ScopeError(404, NOT_FOUND);
  const drawer = m.drawer ?? defaultDrawerForType(m.type);
  if (!drawerOpen(a, drawer)) throw new ScopeError(403, DRAWER_CLOSED);
  // CORE-PERMS-01: a drawer the agent may read but not write is read-only for it.
  if (write && !drawerWritable(a, drawer)) throw new ScopeError(403, DRAWER_CLOSED);
  return m;
}

const owner = memoryOwner;

export const memoryRepository: MemoryRepository = {
  ...memoryRecall,
  ...memoryOwnerRepository,
  ...memoryShared,

  displayPage(actor, cursor) {
    return memoryDisplayPage(memberUser(actor).userId, cursor);
  },

  async list(actor) {
    const { a, userId } = memoryUser(actor);
    if (a.kind === 'agent') return getMemoryStorage().getByDrawers(userId, [...(a.drawers ?? [])]);
    return getMemoryStorage().getByUser(userId);
  },

  async drawers(actor) {
    const { a, userId } = memoryUser(actor);
    const all = await getMemoryStorage().listDrawers(userId);
    return a.kind === 'agent' ? all.filter((d) => drawerOpen(a, d)) : all;
  },

  async get(actor, id) {
    const { a, userId } = memoryUser(actor);
    await ownMemory(a, userId, id);
    const m = await getMemoryStorage().get(id);
    if (!m) throw new ScopeError(404, NOT_FOUND);
    return m;
  },

  async assertAccess(actor, id) {
    const { a, userId } = memoryUser(actor);
    await ownMemory(a, userId, id);
  },

  async create(actor, memory, reason) {
    const { a, userId } = memoryUser(actor);
    const drawer = memory.drawer ? normalizeDrawer(memory.drawer) : defaultDrawerForType(memory.type);
    if (!drawerWritable(a, drawer)) throw new ScopeError(403, DRAWER_CLOSED);
    return saveVersioned({ ...memory, userId } as Memory, versionActor(a), reason);
  },

  async update(actor, id, updates, reason) {
    const { a, userId } = memoryUser(actor);
    await ownMemory(a, userId, id, true);
    if (a.kind === 'agent' && updates.drawer && !drawerWritable(a, normalizeDrawer(updates.drawer))) throw new ScopeError(403, DRAWER_CLOSED);
    const updated = await updateVersioned(userId, id, updates, versionActor(a), reason);
    if (!updated) throw new ScopeError(404, NOT_FOUND);
    return updated;
  },

  async delete(actor, id, reason) {
    const { a, userId } = memoryUser(actor);
    await ownMemory(a, userId, id, true);
    await deleteVersioned(userId, id, versionActor(a), reason);
  },

  async versions(actor, id) {
    const { a, userId } = memoryUser(actor);
    const versions = await memoryVersions(userId, id);
    if (versions.length === 0 && (await memoryRowOwner(id)) !== userId) throw new ScopeError(404, NOT_FOUND);
    if (a.kind === 'agent') {
      const drawer = await forgettableDrawer(userId, id);
      if (!drawer || !drawerOpen(a, drawer)) throw new ScopeError(403, DRAWER_CLOSED);
    }
    return versions;
  },

  async forget(actor, id) {
    const a0 = requireActor(actor);
    if (a0.kind === 'agent' && a0.channel) throw new ScopeError(403, OUTSIDER_REFUSED);
    const { a, userId } = memoryUser(a0);
    if (a.kind === 'agent') {
      // Only memories in drawers open for this run; for an already deleted
      // memory, its last drawer (CORE-07).
      const drawer = await forgettableDrawer(userId, id);
      if (!drawer) return null;
      if (!(a.drawers ?? []).some((d) => sameDrawer(d, drawer))) throw new ScopeError(403, DRAWER_CLOSED);
      if (!drawerWritable(a, drawer)) throw new ScopeError(403, DRAWER_CLOSED);
    }
    return forgetMemory(userId, id, versionActor(a));
  },

  async tombstones(actor) {
    const { userId } = memoryUser(requireMember(actor));
    return listTombstones(userId);
  },

  async drawerFile(actor, agentId, drawer) {
    return viewDrawerFile(owner(actor), agentId, drawer);
  },

  async drawerHistory(actor, drawer) {
    return drawerVersions(owner(actor), drawer);
  },

  async exportDrawer(actor, agentId, drawer) {
    return exportDrawerFile(owner(actor), agentId, drawer);
  },

  async readExportedDrawer(actor, agentId, drawer) {
    return readDrawerFile(owner(actor), agentId, drawer);
  },

  async createProposal(actor, input) {
    const userId = owner(actor);
    return createProposal({ userId, ...input });
  },

  async proposals(actor, status) {
    return listProposals(owner(actor), status);
  },

  async proposal(actor, id) {
    const p = await getProposal(owner(actor), id);
    if (!p) throw new ScopeError(404, PROPOSAL_NOT_FOUND);
    return p;
  },

  async approveProposal(actor, id, expectedReviewHash) {
    const userId = owner(actor);
    return approveProposal(userId, id, userId, expectedReviewHash);
  },

  async rejectProposal(actor, id, expectedReviewHash, note) {
    const userId = owner(actor);
    return rejectProposal(userId, id, userId, expectedReviewHash, note);
  },
};

