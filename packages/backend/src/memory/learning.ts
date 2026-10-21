/**
 * Learning approval, mixed mode (CORE-05; MEMORY_VISION "Learning approval = mixed").
 *
 * Every learned item (chat extraction, agent `memory_save`, agent edit or
 * delete) is classified by the pure `classifyLearning`:
 *
 *   routine    saved automatically into its drawer (versioned)
 *   important  becomes a pending memory proposal (CORE-04 pipeline); nothing
 *              is written until the owner approves it (applied as a new version)
 *   duplicate  already known in that drawer: nothing is saved
 *
 * Important = any of
 *   owner-identity  name, birthday, address, phone, family ... in the owner drawer
 *   owner-preference  any preference
 *   people          a people drawer or a relationship
 *   money / credentials / health / legal / permissions   sensitive topics (EN/AR/DE words)
 *   decision        a standing decision ("from now on", "قررت", "ab jetzt")
 *   conflict        close to an existing memory of the drawer, but drops some of its
 *                   words (possible contradiction; adding detail is not one), or the
 *                   same subject negated / with an opposite word (contradiction.ts).
 *                   CORE-MEM-CONFLICT: the proposal then updates that existing memory
 *                   (conflict_with); the owner keeps new, keeps old or keeps both
 *   overwrite       an edit or delete of an existing memory that is itself important,
 *                   or an explicit replacement
 *   low-confidence  extraction confidence below 0.6
 *   outsider        learned in a turn that answers an outsider (channel / public room);
 *                   never auto-saved into the owner's drawers
 *   chat            proposed by an agent in a saved chat conversation (CHAT-PRO-02 E):
 *                   the owner accepts or rejects it in the chat, never saved by itself
 *
 * Proposals are reviewed by the owner account only (owner-only API). For a
 * non-owner account an important item is not saved (reported as skipped).
 *
 * Topic keys (CORE-MEM-TOPIC): a candidate with a topic key that already
 * names a memory of its drawer updates that memory (new version, same
 * classification rules as an agent edit) instead of adding another one;
 * a negation or opposite of it is a conflict proposal instead.
 */

import { v4 as uuidv4 } from 'uuid';
import { one, sql } from '../repositories/sql-steps.js';
import { getMemoryStorage } from './storage.js';
import { defaultDrawerForType, drawerId, normalizeDrawer, sameDrawer, type DrawerRef } from './drawers.js';
import {
  createChangeProposal,
  decideConflict,
  exportDrawerFileIfPresent,
  MemoryFileError,
  resolveFileAgent,
  type MemoryChange,
  type MemoryProposal,
} from './memory-files.js';
import { recordBaselineIfMissing, recordBaselineIfMissingStep, recordVersion, recordVersionStep, trashSnapshot, versionEntryOf, type VersionEntry } from './versions.js';
import type { ImportanceLevel, Memory, MemoryType, MultiTierLayer } from './types.js';
import { textSimilarity } from './embedding.js';
import { detectContradiction, detectReplacement } from './contradiction.js';
import { TopicKeyError, normalizeTopicKey } from './topic-key.js';
import { TopicKeyTakenError } from './storage.js';
import { ALWAYS_ASK, rulesForDrawer, type EffectiveRules } from './scopes/rules.js';

export const MAX_LEARNED_CONTENT = 50_000;
/** Confidence below this needs review. */
export const LOW_CONFIDENCE = 0.6;
/** Similarity at or above this, with different text, is a possible contradiction. */
export const CONFLICT_SIMILARITY = 0.8;
/** Types the memory tools may store besides MEMORY_TYPES. */
const TYPE = /^[a-z][a-z_-]{0,31}$/;

export type LearningOrigin = 'owner' | 'agent' | 'extraction' | 'outsider';

export type LearningReason =
  | 'owner-identity' | 'owner-preference' | 'people'
  | 'money' | 'credentials' | 'health' | 'legal' | 'permissions' | 'decision'
  | 'conflict' | 'overwrite' | 'low-confidence' | 'outsider' | 'chat'
  /** MEM-GAPS-02: the scope's review rules ask for routine facts too. */
  | 'scope-rule';

export interface LearningCandidate {
  content: string;
  type?: string;
  /** 1-10 */
  importance?: number;
  /** 0-1; absent = not stated */
  confidence?: number;
  drawer?: DrawerRef;
  origin: LearningOrigin;
  /** The candidate replaces or deletes this existing memory (agent edit/delete). */
  replaces?: { id: string; content: string; type: string; important?: boolean } | null;
  /** A safe reference to a secret saved in the credential store. */
  credentialRef?: boolean;
  /** Stable topic key (CORE-MEM-TOPIC); normalized by learn(). */
  topicKey?: string | null;
}

export interface LearningContext {
  /** Memories of the same drawer that resemble the candidate (search results). */
  similar?: ReadonlyArray<{ id: string; content: string; similarity: number }>;
}

export interface LearningClassification {
  kind: 'routine' | 'important' | 'duplicate';
  drawer: DrawerRef;
  reasons: LearningReason[];
  /** Existing memories the candidate may contradict. */
  conflictsWith: string[];
}

// Word lists (lower-case; Arabic and German included). Kept short and explicit.
const TOPICS: Array<[LearningReason, RegExp]> = [
  ['credentials', /\b(passwords?|passwd|pass ?phrase|api[ _-]?keys?|tokens?|secrets?|pin|otp|2fa|private key|ssh key)\b|كلمة (السر|المرور)|الباسورد|رمز (الدخول|التحقق)|توكن|مفتاح|\b(passwort|kennwort|zugangsdaten|schlüssel)\b/i],
  ['money', /[$€£]|\b(money|salary|wage|payment|pay|paid|price|cost|invoice|bank|iban|swift|credit card|loan|debt|budget|tax|usd|eur|dollars?|euros?|bitcoin|crypto)\b|فلوس|مال|راتب|معاش|دفع|سعر|فاتورة|بنك|حساب بنكي|قرض|دين|ضريبة|دولار|دينار|يورو|\b(geld|gehalt|zahlung|preis|rechnung|konto|kredit|schulden|steuer)\b/i],
  ['health', /\b(health|doctor|medic\w*|diagnos\w*|disease|illness|sick|hospital|surgery|pregnan\w*|allerg\w*|therapy|therapist|medication|pills?|blood)\b|صحة|طبيب|دكتور|مرض|مريض|مستشفى|دواء|علاج|عملية جراحية|حامل|حساسية|\b(gesundheit|arzt|ärztin|krankheit|krank|krankenhaus|medikament|therapie|schwanger|allergie)\b/i],
  ['legal', /\b(legal|lawyer|attorney|court|lawsuit|sue|contract|visa|passport|residence permit|police|criminal|licen[cs]e)\b|محامي|محكمة|قضية|دعوى|عقد|قانون|جواز|فيزا|إقامة|اقامة|شرطة|\b(anwalt|gericht|klage|vertrag|visum|reisepass|aufenthalt|polizei)\b/i],
  ['permissions', /\b(permissions?|access rights?|grant(ed)? access|admin rights?|root access|sudo)\b|صلاحي(ة|ات)|\b(berechtigung\w*|zugriffsrecht\w*)\b/i],
  ['decision', /\b(decided|decision|from now on|always do|never do|we will always|policy is)\b|قرار|قررت|قررنا|من الآن|من هسه|من اليوم|\b(entschieden|entscheidung|ab jetzt|ab sofort)\b/i],
];
const IDENTITY = /\b(my name|name is|born|birthday|years old|address|lives in|live in|phone|mobile|e-?mail|wife|husband|son|daughter|married|nationality|religion)\b|اسمي|اسمه|اسمها|عمري|عمره|مواليد|تاريخ الميلاد|عنوان|ساكن|يسكن|رقم (الهاتف|الموبايل|التلفون)|زوجت|زوجي|ابني|بنتي|جنسية|\b(heiße|name ist|geboren|geburtstag|wohnt|adresse|telefon|handy|ehefrau|ehemann|verheiratet)\b/i;

function normText(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
}

function candidateDrawer(c: LearningCandidate): DrawerRef {
  return c.drawer ? normalizeDrawer(c.drawer) : defaultDrawerForType(c.type || 'fact');
}

/** Classify one learned item (pure: no I/O). */
export function classifyLearning(c: LearningCandidate, ctx: LearningContext = {}): LearningClassification {
  const drawer = candidateDrawer(c);
  const text = typeof c.content === 'string' ? c.content : '';
  const reasons = new Set<LearningReason>();
  const conflictsWith: string[] = [];
  const norm = normText(text);

  // Already known, word for word: nothing to save.
  if (!c.replaces && (ctx.similar || []).some((s) => normText(s.content) === norm)) {
    return { kind: 'duplicate', drawer, reasons: [], conflictsWith: [] };
  }

  if (c.origin === 'outsider') reasons.add('outsider');
  if (c.type === 'preference') reasons.add('owner-preference');
  if (drawer.kind === 'owner' && IDENTITY.test(text)) reasons.add('owner-identity');
  if (drawer.kind === 'people' || c.type === 'relationship') reasons.add('people');
  if (c.credentialRef || c.type === 'credential') reasons.add('credentials');
  for (const [reason, re] of TOPICS) if (re.test(text)) reasons.add(reason);
  if (typeof c.confidence === 'number' && Number.isFinite(c.confidence) && c.confidence < LOW_CONFIDENCE) reasons.add('low-confidence');

  if (c.replaces) {
    // Editing or deleting a memory that is itself important needs review too.
    const old = classifyLearning({ content: c.replaces.content, type: c.replaces.type, drawer, origin: 'owner' });
    if (c.replaces.important || old.kind === 'important') reasons.add('overwrite');
  } else {
    // A close memory whose words are not all kept is a possible contradiction
    // ("likes tea" -> "likes coffee"); adding detail to it is not.
    const words = new Set(norm.split(' '));
    for (const s of ctx.similar || []) {
      const old = normText(s.content);
      if (old === norm) continue;
      // CORE-MEM-CONFLICT: the same subject negated or with an opposite word.
      // ... or the new text says the value changed ("is now green tea", "صار شاي").
      if (detectContradiction(s.content, text) || detectReplacement(s.content, text)) { conflictsWith.push(s.id); continue; }
      if (s.similarity < CONFLICT_SIMILARITY) continue;
      if (old.split(' ').some((w) => !words.has(w))) conflictsWith.push(s.id);
    }
    if (conflictsWith.length) reasons.add('conflict');
  }

  return { kind: reasons.size ? 'important' : 'routine', drawer, reasons: [...reasons], conflictsWith };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function layerFor(importance: number): { memoryLayer: MultiTierLayer; expiryTimestamp: number | null } {
  if (importance >= 8) return { memoryLayer: 'factual', expiryTimestamp: null };
  if (importance >= 6) return { memoryLayer: 'experiential', expiryTimestamp: Date.now() + 90 * 24 * 60 * 60 * 1000 };
  return { memoryLayer: 'working', expiryTimestamp: Date.now() + 24 * 60 * 60 * 1000 };
}

function clampImportance(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 5;
  return Math.max(1, Math.min(10, n));
}

export async function userRole(userId: string): Promise<string | null> {
  const row = await sql().read(one<{ role: string }>('SELECT role FROM users WHERE id = ?', userId));
  return row?.role ?? null;
}

async function proposalAgent(agentId?: string | null): Promise<string> {
  try { return await resolveFileAgent(agentId || undefined); } catch { /* no agent folder */ }
  try { return await resolveFileAgent(); } catch { return '(none)'; }
}

/** Build a new memory row (not yet saved). */
export function newMemory(userId: string, drawer: DrawerRef, entry: VersionEntry, metadata: Record<string, unknown>, topicKey: string | null = null): Memory {
  const now = Date.now();
  return {
    id: uuidv4(), userId, drawer, type: entry.type as MemoryType, content: entry.content,
    importance: entry.importance as ImportanceLevel, importanceScore: entry.importance / 10,
    ...layerFor(entry.importance), consolidationStatus: 'pending', status: 'active',
    metadata, createdAt: new Date(now), lastAccessedAt: now, accessCount: 0, topicKey,
  };
}

/**
 * Save a memory and record its `create` version (CORE-05). Exported drawer
 * files are not rewritten here (the owner may be editing one; its base hash
 * now differs, so a proposal from it asks to export again). Forget (CORE-07)
 * does re-export.
 */
export async function saveVersioned(memory: Memory, actor: string, reason: string): Promise<Memory> {
  const storage = getMemoryStorage();
  // The row and its `create` version in one transaction; the readable copy after.
  await storage.ensureEmbedding(memory);
  await sql().tx(function* () {
    yield* storage.writeRowStep(memory);
    yield* recordVersionStep({ memoryId: memory.id, userId: memory.userId, drawer: memory.drawer!, change: 'create', entry: versionEntryOf(memory), actor, reason });
  });
  await storage.writeMarkdownCopy(memory);
  return memory;
}

/** Update a memory (allowlisted fields) with baseline + `update` version. */
export async function updateVersioned(userId: string, id: string, updates: Partial<Memory>, actor: string, reason: string): Promise<Memory | null> {
  const storage = getMemoryStorage();
  const old = await storage.getOwned(userId, id);
  if (!old) return null;
  await recordBaselineIfMissing(old, actor);
  await storage.update(id, updates);
  const updated = (await storage.getOwned(userId, id))!;
  await recordVersion({ memoryId: id, userId, drawer: updated.drawer!, change: 'update', entry: versionEntryOf(updated), actor, reason });
  return updated;
}

/**
 * The owner corrects a memory from a reply's trace (MEM-CACHE-01 "Correct"):
 * the new text becomes a pending review proposal (source 'file': an owner
 * edit), applied only when the owner approves it with its review hash.
 * Null when the memory is not the user's; MemoryFileError when nothing
 * changes or too many proposals wait.
 */
export async function ownerCorrection(input: { userId: string; memoryId: string; content: string; agentId?: string | null; reasons: string[]; note?: string | null }): Promise<MemoryProposal | null> {
  const old = await getMemoryStorage().getOwned(input.userId, input.memoryId);
  if (!old) return null;
  const before = versionEntryOf(old);
  const after = { ...before, content: input.content };
  if (after.content.trim() === before.content.trim()) throw new MemoryFileError('Nothing to change');
  return createChangeProposal({
    userId: input.userId, agentId: await proposalAgent(input.agentId), drawer: old.drawer ?? defaultDrawerForType(old.type),
    changes: [{ op: 'update', id: old.id, before, after }], source: 'file', reasons: input.reasons,
    note: input.note ?? null, createdBy: input.userId,
  });
}

/** A move that cannot be made (same drawer). */
export class MoveError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}

/**
 * Move a memory to another drawer of its user, versioned (baseline + an
 * `update` version in the new drawer whose reason names both drawers). The
 * topic key stays and must be free in the new drawer (TopicKeyTakenError).
 * Exported copies of both drawers are written again where they exist.
 * Callers decide who may move (owner only; agents with both drawers open).
 */
export async function moveVersioned(userId: string, id: string, to: DrawerRef, actor: string, reason?: string | null): Promise<{ memory: Memory; from: DrawerRef } | null> {
  const storage = getMemoryStorage();
  const old = await storage.getOwned(userId, id);
  if (!old) return null;
  const target = normalizeDrawer(to);
  const from = old.drawer ?? defaultDrawerForType(old.type);
  if (sameDrawer(from, target)) throw new MoveError('The memory is already in that drawer', 'same_drawer');
  await recordBaselineIfMissing(old, actor);
  await storage.update(id, { drawer: target });
  const moved = (await storage.getOwned(userId, id))!;
  const note = typeof reason === 'string' && reason.trim() ? `: ${reason.trim().slice(0, 120)}` : '';
  await recordVersion({ memoryId: id, userId, drawer: target, change: 'update', entry: versionEntryOf(moved), actor, reason: `move:${drawerId(from)}->${drawerId(target)}${note}` });
  for (const d of [from, target]) await exportDrawerFileIfPresent(userId, d).catch(() => []);
  return { memory: moved, from };
}

/**
 * Delete a memory, keeping its history (baseline + `delete` version) so the
 * deletion can be traced and undone by hand. "Forget" (CORE-07) is the
 * complete removal.
 */
export async function deleteVersioned(userId: string, id: string, actor: string, reason: string): Promise<boolean> {
  const storage = getMemoryStorage();
  const old = await storage.getOwned(userId, id);
  if (!old) return false;
  await recordBaselineIfMissing(old, actor);
  await storage.delete(id);
  await recordVersion({ memoryId: id, userId, drawer: old.drawer!, change: 'delete', entry: null, actor, reason, snapshot: trashSnapshot(old) });
  return true;
}

export interface LearnInput {
  userId: string;
  candidates: LearningCandidate[];
  /** `owner:<id>` / `agent:<id>` / `extraction`. */
  actor: string;
  agentId?: string | null;
  /** When given, a candidate's drawer must be one of these (tool runs). */
  openDrawers?: readonly DrawerRef[] | null;
  /** Extra metadata stored with routine memories. */
  metadata?: Record<string, unknown>;
  /** CHAT-PRO-02 E: every new item goes to the owner as a proposal (routine ones too). */
  review?: boolean;
}

export interface LearnOutcome {
  saved: Memory[];
  proposed: MemoryProposal[];
  skipped: Array<{ content: string; reason: string }>;
  classified: Array<{ kind: LearningClassification['kind']; reasons: LearningReason[]; memoryId?: string; proposalId?: string }>;
  /** CORE-MEM-TOPIC: memories updated as a new version because their topic key was saved again. */
  updated: Memory[];
}

function preview(s: string): string {
  return s.length > 80 ? `${s.slice(0, 80)}...` : s;
}

/**
 * Classify and store learned items: routine -> saved (versioned), important
 * -> pending proposal (owner account only), duplicate -> nothing.
 */
export async function learn(input: LearnInput): Promise<LearnOutcome> {
  const out: LearnOutcome = { saved: [], proposed: [], skipped: [], classified: [], updated: [] };
  const storage = getMemoryStorage();
  const ownerReview = (await userRole(input.userId)) === 'owner';
  for (const c of input.candidates) {
    const content = typeof c?.content === 'string' ? c.content.trim() : '';
    if (!content || content.length > MAX_LEARNED_CONTENT) { out.skipped.push({ content: preview(content), reason: 'invalid content' }); continue; }
    const type = typeof c.type === 'string' && TYPE.test(c.type) ? c.type : 'fact';
    let drawer: DrawerRef;
    try { drawer = candidateDrawer({ ...c, type }); } catch { out.skipped.push({ content: preview(content), reason: 'invalid drawer' }); continue; }
    if (input.openDrawers && !input.openDrawers.some((d) => sameDrawer(d, drawer))) {
      out.skipped.push({ content: preview(content), reason: 'drawer not open' });
      continue;
    }
    let topicKey: string | null;
    try { topicKey = normalizeTopicKey(c.topicKey); } catch (err) {
      if (!(err instanceof TopicKeyError)) throw err;
      out.skipped.push({ content: preview(content), reason: 'invalid topic key' });
      continue;
    }
    const entry: VersionEntry = { type, importance: clampImportance(c.importance), content };
    if (topicKey) {
      // CORE-MEM-TOPIC: the topic is known in this drawer -> a new version of it.
      const existing = await storage.getByTopicKey(input.userId, drawer, topicKey);
      if (existing) {
        await learnTopicUpdate(input, out, existing, entry, c, ownerReview);
        continue;
      }
    }
    const similar = (await storage.search({ userId: input.userId, query: content, drawers: [drawer], limit: 5 }))
      // CORE-06: the contradiction check uses a model-independent word
      // similarity (search scores depend on the active embedding model).
      .map((r) => ({ id: r.memory.id, content: r.memory.content, similarity: textSimilarity(content, r.memory.content) }));
    const cls = classifyLearning({ ...c, content, type, drawer }, { similar });
    if (input.review && cls.kind === 'routine') { cls.kind = 'important'; cls.reasons.push('chat'); }
    // MEM-GAPS-02: the scope's review rules (owner accounts; a chat the owner reviews always asks).
    const rules = ownerReview && !input.review ? await rulesForDrawer(input.userId, drawer) : null;
    if (rules && cls.kind === 'routine' && rules.routine === 'ask') { cls.kind = 'important'; cls.reasons.push('scope-rule'); }
    else if (rules && cls.kind === 'important' && !cls.conflictsWith.length && rules.important === 'save' && cls.reasons.every((r) => !ALWAYS_ASK.has(r))) cls.kind = 'routine';

    if (cls.kind === 'duplicate') {
      out.skipped.push({ content: preview(content), reason: 'already known' });
      out.classified.push({ kind: cls.kind, reasons: [] });
      continue;
    }
    if (cls.kind === 'routine') {
      const mem = newMemory(input.userId, drawer, entry, { ...(input.metadata || {}), source: c.origin, learned: 'routine' }, topicKey);
      // MEM-GAPS-02: who saved it (an agent run; never an outsider-facing turn's claim).
      if (c.origin === 'agent' && input.agentId) mem.sourceAgentId = input.agentId;
      try {
        await saveVersioned(mem, input.actor, 'learning:routine');
      } catch (err) {
        // A concurrent save took the topic key first: this one becomes a new version of it.
        if (!(err instanceof TopicKeyTakenError)) throw err;
        const holder = await storage.getOwned(input.userId, err.holderId);
        if (!holder) throw err;
        await learnTopicUpdate(input, out, holder, entry, c, ownerReview);
        continue;
      }
      out.saved.push(mem);
      out.classified.push({ kind: cls.kind, reasons: [], memoryId: mem.id });
      continue;
    }
    if (!ownerReview) {
      out.skipped.push({ content: preview(content), reason: 'needs owner approval' });
      out.classified.push({ kind: cls.kind, reasons: cls.reasons });
      continue;
    }
    try {
      const reasons = cls.conflictsWith.length ? [...cls.reasons, ...cls.conflictsWith.slice(0, 5).map((id) => `conflicts-with:${id}`)] : cls.reasons;
      // CORE-MEM-CONFLICT: never written over the existing memory; the proposal
      // updates the first contradicted one only if the owner keeps the new text.
      const old = cls.conflictsWith.length ? await storage.getOwned(input.userId, cls.conflictsWith[0]) : null;
      const change: MemoryChange = old
        ? { op: 'update', id: old.id, before: versionEntryOf(old), after: entry }
        : { op: 'add', after: entry, ...(topicKey ? { topicKey } : {}) };
      const proposal = await createChangeProposal({
        userId: input.userId, agentId: await proposalAgent(input.agentId), drawer, changes: [change],
        source: c.origin === 'agent' ? 'agent' : 'learning', reasons, createdBy: input.actor, conflictWith: old?.id ?? null,
      });
      if (rules && await ruleDecides(input.userId, out, proposal, cls.reasons, rules)) continue;
      out.proposed.push(proposal);
      out.classified.push({ kind: cls.kind, reasons: cls.reasons, proposalId: proposal.id });
    } catch (err) {
      if (!(err instanceof MemoryFileError)) throw err;
      out.skipped.push({ content: preview(content), reason: err.message });
    }
  }
  return out;
}

/**
 * MEM-GAPS-02: a conflict proposal the scope's contradiction rule answers
 * (keep_new / keep_both) is decided at once, through the same decision path
 * as the owner's (versioned; the old text stays in history). Only when its
 * other reasons would not wait on their own. True when it was decided.
 */
async function ruleDecides(userId: string, out: LearnOutcome, proposal: MemoryProposal, reasons: readonly string[], rules: EffectiveRules): Promise<boolean> {
  if (!proposal.conflictWith || rules.contradiction === 'ask') return false;
  const others = reasons.filter((r) => r !== 'conflict');
  if (others.some((r) => ALWAYS_ASK.has(r)) || (others.length && rules.important !== 'save')) return false;
  try {
    const r = await decideConflict(userId, proposal.id, rules.contradiction, `rule:${rules.from.contradiction}`, proposal.reviewHash, 'decided by the scope rule');
    const storage = getMemoryStorage();
    if (r.decision === 'keep_new') {
      const m = await storage.getOwned(userId, proposal.conflictWith);
      if (m) out.updated.push(m);
      out.classified.push({ kind: 'important', reasons: [...reasons] as LearningReason[], memoryId: proposal.conflictWith });
    } else {
      const id = r.applied?.added[0];
      const m = id ? await storage.getOwned(userId, id) : null;
      if (m) out.saved.push(m);
      out.classified.push({ kind: 'important', reasons: [...reasons] as LearningReason[], ...(id ? { memoryId: id } : {}) });
    }
    return true;
  } catch (err) {
    if (err instanceof MemoryFileError) return false; // changed meanwhile: it waits for the owner
    throw err;
  }
}

/**
 * CORE-MEM-TOPIC: a candidate whose topic key already names `existing`.
 * Same text -> nothing; a negation/opposite of it -> conflict proposal (owner
 * account only); anything else -> an update of `existing`: routine ones are
 * applied as a new version, important ones (overwrite rules of agentChange)
 * become an update proposal.
 */
async function learnTopicUpdate(input: LearnInput, out: LearnOutcome, existing: Memory, entry: VersionEntry, c: LearningCandidate, ownerReview: boolean): Promise<void> {
  const before = versionEntryOf(existing);
  if (normText(before.content) === normText(entry.content) && before.type === entry.type) {
    out.skipped.push({ content: preview(entry.content), reason: 'already known' });
    out.classified.push({ kind: 'duplicate', reasons: [] });
    return;
  }
  const drawer = existing.drawer!;
  const contradiction = detectContradiction(before.content, entry.content);
  const cls = classifyLearning({
    content: entry.content, type: entry.type, drawer, origin: c.origin, confidence: c.confidence, credentialRef: c.credentialRef,
    replaces: { id: existing.id, content: before.content, type: before.type, important: before.importance >= 9 },
  });
  const reasons: LearningReason[] = contradiction ? [...new Set<LearningReason>(['conflict', ...cls.reasons])] : cls.reasons;
  if (input.review && !reasons.length) reasons.push('chat');
  if (!reasons.length) {
    const updated = await updateVersioned(input.userId, existing.id, {
      content: entry.content, type: entry.type as MemoryType,
      importance: entry.importance as ImportanceLevel, importanceScore: entry.importance / 10,
    }, input.actor, 'learning:topic');
    if (updated) out.updated.push(updated);
    out.classified.push({ kind: 'routine', reasons: [], memoryId: existing.id });
    return;
  }
  if (!ownerReview) {
    out.skipped.push({ content: preview(entry.content), reason: 'needs owner approval' });
    out.classified.push({ kind: 'important', reasons });
    return;
  }
  try {
    const proposal = await createChangeProposal({
      userId: input.userId, agentId: await proposalAgent(input.agentId), drawer,
      changes: [{ op: 'update', id: existing.id, before, after: entry }],
      source: c.origin === 'agent' ? 'agent' : 'learning',
      reasons: contradiction ? [...reasons, `conflicts-with:${existing.id}`] : reasons,
      createdBy: input.actor, conflictWith: contradiction ? existing.id : null,
    });
    const rules = contradiction && !input.review ? await rulesForDrawer(input.userId, drawer) : null;
    if (rules && await ruleDecides(input.userId, out, proposal, reasons, rules)) return;
    out.proposed.push(proposal);
    out.classified.push({ kind: 'important', reasons, proposalId: proposal.id });
  } catch (err) {
    if (!(err instanceof MemoryFileError)) throw err;
    out.skipped.push({ content: preview(entry.content), reason: err.message });
  }
}

/**
 * Set or clear a memory's topic key with a version row (reason
 * `topic-key:<key>`), in one transaction. Throws TopicKeyTakenError when
 * another memory of the drawer holds the key.
 */
export async function setTopicKeyVersioned(m: Memory, topicKey: string | null, actor: string): Promise<void> {
  const storage = getMemoryStorage();
  await sql().tx(function* () {
    yield* storage.setTopicKeyStep(m.userId, m.id, topicKey);
    yield* recordBaselineIfMissingStep(m, actor);
    yield* recordVersionStep({ memoryId: m.id, userId: m.userId, drawer: m.drawer!, change: 'update', entry: versionEntryOf(m), actor, reason: `topic-key:${topicKey ?? '(none)'}` });
  });
}

export type AgentChangeResult =
  | { status: 'applied'; memory: Memory | null }
  | { status: 'proposed'; proposal: MemoryProposal; reasons: LearningReason[] }
  | { status: 'refused'; reason: string };

/**
 * An agent edit or delete of an existing memory (memory_edit / memory_delete
 * tools). Important memories (or important new text) go through a proposal;
 * routine ones are applied directly and versioned.
 */
export async function agentChange(input: {
  userId: string; memoryId: string; op: 'update' | 'delete';
  /** `topicKey`: undefined = unchanged, null/'' = clear, else the new key (CORE-MEM-TOPIC). */
  updates?: { content?: string; type?: string; importance?: number; topicKey?: string | null };
  actor: string; agentId?: string | null; openDrawers?: readonly DrawerRef[] | null; outsider?: boolean; reason?: string | null;
}): Promise<AgentChangeResult> {
  const storage = getMemoryStorage();
  const old = await storage.getOwned(input.userId, input.memoryId);
  if (!old) return { status: 'refused', reason: 'Memory not found' };
  const drawer = old.drawer!;
  if (input.openDrawers && !input.openDrawers.some((d) => sameDrawer(d, drawer))) {
    return { status: 'refused', reason: 'That memory drawer is not open for this conversation' };
  }
  const before = versionEntryOf(old);
  const after: VersionEntry | null = input.op === 'delete' ? null : {
    type: typeof input.updates?.type === 'string' && TYPE.test(input.updates.type) ? input.updates.type : before.type,
    importance: input.updates?.importance !== undefined ? clampImportance(input.updates.importance) : before.importance,
    content: typeof input.updates?.content === 'string' && input.updates.content.trim() ? input.updates.content : before.content,
  };
  if (after && after.content.length > MAX_LEARNED_CONTENT) return { status: 'refused', reason: 'Content is too long' };
  let topicKey: string | null | undefined;
  if (input.op === 'update' && input.updates?.topicKey !== undefined) {
    try { topicKey = normalizeTopicKey(input.updates.topicKey); } catch (err) {
      if (err instanceof TopicKeyError) return { status: 'refused', reason: err.message };
      throw err;
    }
  }
  const topicChange = topicKey !== undefined && topicKey !== (old.topicKey ?? null);
  if (after && JSON.stringify(after) === JSON.stringify(before) && !topicChange) return { status: 'refused', reason: 'Nothing to change' };
  if (topicChange) {
    // CORE-MEM-TOPIC: naming the topic is bookkeeping, applied at once (versioned).
    try {
      await setTopicKeyVersioned(old, topicKey!, input.actor);
    } catch (err) {
      if (err instanceof TopicKeyTakenError) return { status: 'refused', reason: err.message };
      throw err;
    }
    old.topicKey = topicKey;
    if (JSON.stringify(after) === JSON.stringify(before)) return { status: 'applied', memory: await storage.getOwned(input.userId, old.id) };
  }

  const cls = classifyLearning({
    content: after ? after.content : before.content, type: after?.type ?? before.type, drawer,
    origin: input.outsider ? 'outsider' : 'agent',
    replaces: { id: old.id, content: before.content, type: before.type, important: before.importance >= 9 },
  });
  const reasonText = (input.reason || '').slice(0, 200) || null;
  if (cls.kind === 'routine') {
    const actorReason = `agent:${input.op}${reasonText ? `: ${reasonText}` : ''}`;
    if (input.op === 'delete') {
      await deleteVersioned(input.userId, old.id, input.actor, actorReason);
      return { status: 'applied', memory: null };
    }
    const updated = await updateVersioned(input.userId, old.id, {
      content: after!.content, type: after!.type as MemoryType,
      importance: after!.importance as ImportanceLevel, importanceScore: after!.importance / 10,
    }, input.actor, actorReason);
    return { status: 'applied', memory: updated };
  }
  if ((await userRole(input.userId)) !== 'owner') return { status: 'refused', reason: 'This change needs owner approval' };
  const change: MemoryChange = input.op === 'delete'
    ? { op: 'delete', id: old.id, before }
    : { op: 'update', id: old.id, before, after: after! };
  try {
    const proposal = await createChangeProposal({
      userId: input.userId, agentId: await proposalAgent(input.agentId), drawer, changes: [change],
      source: 'agent', reasons: cls.reasons, note: reasonText, createdBy: input.actor,
    });
    return { status: 'proposed', proposal, reasons: cls.reasons };
  } catch (err) {
    if (err instanceof MemoryFileError) return { status: 'refused', reason: err.message };
    throw err;
  }
}
