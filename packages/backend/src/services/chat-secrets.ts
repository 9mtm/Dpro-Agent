/**
 * Secrets typed in the chat go to the key store (CHAT-SECRETS-01).
 *
 * When a user message is saved, every secret the memory-import redaction
 * finds (API keys, tokens, passwords, credentials in URLs …) is stored
 * encrypted in the credential store (AES-256-GCM, credentials/encryption.ts),
 * owned by that user, and the message keeps only a reference:
 *
 *     [SECRET:<type>:<id>]        e.g. [SECRET:github_token:k3j9x0a1bq]
 *
 * So the raw value never reaches chat_messages, the conversation title, run
 * events, search, export, memory or the model's history (cloud models too).
 *
 * Use by the agent: the model sees and passes the reference. The tools
 * registry resolves references in a tool call's input at call time
 * (resolveSecretRefs), only for the user who owns them and never in a
 * channel turn; such a call always waits for a one-time owner approval, and
 * the raw value is replaced by the reference again in the tool's result
 * (scrubSecretValues) before the model, the events or the stored turn see it.
 *
 * Credential rows: name `chat:<type>:<id>`, skill_id `chat`, description
 * `chat:<conversationId>`, user_id = the owner.
 *
 * If the store cannot save a value (e.g. encryption fails), the value is
 * dropped as `[REDACTED:<type>]`; it is never kept in plain text.
 *
 * Secrets the agent meets (CHAT-SECRETS-02): a secret in a tool's result
 * (e.g. the agent reads a .env file) or in the agent's own reply is moved to
 * the key store the same way, owned by the conversation's user, one reference
 * per value per conversation (a value already saved for that conversation
 * gets its existing reference). Decision: vault, not only redact, so the agent
 * can still use the value through the reference (owner approval, as above).
 *  - Tool results: the tools registry vaults them (vaultToolResult) before the
 *    model, the run events, the approval record or the stored turn see them.
 *    Outside the owner's own chat conversation (channel turns, tasks, no
 *    conversation) there is no chat to link to: the value is redacted.
 *  - The reply: when a run ends, before the turn is stored, the answer, the
 *    stored work and the private event buffer are vaulted (vaultRunSecrets).
 *    ChatRun publishes only after this check, so live and replay readers
 *    receive checked content, including keys split across provider chunks.
 */

import { randomBytes } from 'node:crypto';
import { getCredentialManager } from '../credentials/manager.js';
import { getCredentialStorage } from '../credentials/storage.js';
import { CredentialType } from '../credentials/types.js';
import { redactImportText, SECRET_REF_RE, type RedactionType } from '../memory/import/redact.js';
import { q } from '../repositories/sql-steps.js';
import { dbDriver } from '../db/pg/config.js';
import { getDatabase } from '../db/index.js';

export const CHAT_SECRET_SKILL = 'chat';
const NAME_RE = /^chat:([a-z_]+):([a-z0-9]{6,32})$/;
const REF_ID = /^[a-z0-9]{6,32}$/;

export interface SavedSecret { id: string; type: RedactionType; ref: string }
export interface ChatSecret { id: string; type: string; ref: string; conversationId: string | null; createdAt: string; lastUsed: string | null }

export class ChatSecretsError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export const secretRef = (type: string, id: string): string => `[SECRET:${type}:${id}]`;
const credentialName = (type: string, id: string): string => `chat:${type}:${id}`;
const newId = (): string => randomBytes(10).toString('hex');

function credentialTypeOf(type: RedactionType): CredentialType {
  if (type === 'password' || type === 'url_credentials' || type === 'basic_auth') return CredentialType.PASSWORD;
  if (type === 'private_key' || type === 'secret_assignment' || type === 'azure_connection_string') return CredentialType.SECRET;
  if (type === 'jwt' || type === 'bearer_token' || type === 'gcp_oauth_token') return CredentialType.OAUTH_TOKEN;
  return CredentialType.API_KEY;
}

let ready: Promise<void> | null = null;
function storeReady(): Promise<void> {
  ready ??= getCredentialStorage().initialize().catch((err) => { ready = null; throw err; });
  return ready;
}

/**
 * Move every secret in `text` into the key store of `userId` and return the
 * text with references. The same value twice in one text gets one reference.
 */
export async function vaultSecretsInText(userId: string, conversationId: string, text: string, known?: Map<string, SavedSecret>): Promise<{ text: string; saved: SavedSecret[] }> {
  const found = new Map<string, SavedSecret>(); // value -> reference (new in this text)
  const values = new Map<string, string>(); // id -> value
  const scanned = redactImportText(text, {
    onSecret: (type, value) => {
      const stored = known?.get(value);
      if (stored) return stored.ref;
      let s = found.get(value);
      if (!s) {
        const id = newId();
        s = { id, type, ref: secretRef(type, id) };
        found.set(value, s);
        values.set(id, value);
      }
      return s.ref;
    },
  });
  if (scanned.total === 0) return { text, saved: [] };
  let out = scanned.text;
  const saved: SavedSecret[] = [];
  for (const s of found.values()) {
    try {
      await storeReady();
      await getCredentialManager().create({
        name: credentialName(s.type, s.id), type: credentialTypeOf(s.type), value: values.get(s.id)!,
        description: `chat:${conversationId}`, skillId: CHAT_SECRET_SKILL, userId,
      });
      saved.push(s);
      known?.set(values.get(s.id)!, s);
    } catch {
      // Never keep the value in plain text: drop it instead of referencing it.
      out = out.split(s.ref).join(`[REDACTED:${s.type}]`);
      console.warn('[ChatSecrets] A secret could not be stored; it was removed from the message', { type: s.type });
    }
  }
  values.clear();
  return { text: out, saved };
}

async function ownChatSecrets(userId: string) {
  await storeReady();
  return (await getCredentialManager().list(userId)).filter((c) => c.userId === userId && c.skillId === CHAT_SECRET_SKILL && NAME_RE.test(c.name));
}

/** The caller's secrets that came from the chat (never their values). */
export async function listChatSecrets(userId: string): Promise<ChatSecret[]> {
  return (await ownChatSecrets(userId)).map((c) => {
    const [, type, id] = NAME_RE.exec(c.name)!;
    const conv = /^chat:(.+)$/.exec(c.description ?? '');
    return {
      id, type, ref: secretRef(type, id), conversationId: conv ? conv[1] : null,
      createdAt: c.createdAt.toISOString(), lastUsed: c.lastUsed ? c.lastUsed.toISOString() : null,
    };
  });
}

/** Delete one of the caller's chat secrets; false when it is not theirs or unknown. */
export async function deleteChatSecret(userId: string, id: string): Promise<boolean> {
  if (!REF_ID.test(id)) return false;
  const c = (await ownChatSecrets(userId)).find((x) => NAME_RE.exec(x.name)?.[2] === id);
  if (!c) return false;
  await getCredentialManager().delete(c.id);
  return true;
}

/** True when any string inside `value` holds a key-store reference. */
export function hasSecretRef(value: unknown): boolean {
  let hit = false;
  walkStrings(value, (s) => { if (!hit && new RegExp(SECRET_REF_RE.source).test(s)) hit = true; return s; });
  return hit;
}

/**
 * Replace the references in a tool call's input with the stored values of
 * `userId` (owner only). Unknown or foreign references stay as they are.
 */
export async function resolveSecretRefs<T>(userId: string, value: T): Promise<{ value: T; used: Array<{ ref: string; secret: string }> }> {
  const refs = new Set<string>();
  walkStrings(value, (s) => { for (const m of s.match(SECRET_REF_RE) ?? []) refs.add(m); return s; });
  if (refs.size === 0) return { value, used: [] };
  const own = await ownChatSecrets(userId);
  const used: Array<{ ref: string; secret: string }> = [];
  for (const ref of refs) {
    const [, type, id] = /^\[SECRET:([a-z_]+):([a-z0-9]+)\]$/.exec(ref) ?? [];
    const c = own.find((x) => x.name === credentialName(type, id));
    if (!c) continue;
    used.push({ ref, secret: await getCredentialManager().getValue(c.id) });
  }
  const out = walkStrings(value, (s) => used.reduce((acc, u) => acc.split(u.ref).join(u.secret), s));
  return { value: out, used };
}

/** Put the references back where a tool's result repeats a resolved value. */
export function scrubSecretValues<T>(value: T, used: Array<{ ref: string; secret: string }>): T {
  if (used.length === 0) return value;
  return walkStrings(value, (s) => used.reduce((acc, u) => (u.secret ? acc.split(u.secret).join(u.ref) : acc), s));
}

// ---- secrets the agent meets: tool results and its own reply (CHAT-SECRETS-02) ----

const NOTE = '\n\n[Secrets in this result were moved to the encrypted key store. Use the [SECRET:…] reference itself in a tool input; the tool gets the value after the owner approves that call.]';
const hasSecret = (s: string): boolean => redactImportText(s).total > 0;

/** One vaulting at a time per conversation, so a value gets one reference even across parallel tool calls. */
const locks = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  const tail = next.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return next;
}

/** The values already saved for this conversation of `userId` → their reference. */
async function knownSecrets(userId: string, conversationId: string): Promise<Map<string, SavedSecret>> {
  const known = new Map<string, SavedSecret>();
  const storage = getCredentialStorage();
  for (const c of await ownChatSecrets(userId)) {
    if (c.description !== `chat:${conversationId}`) continue;
    const [, type, id] = NAME_RE.exec(c.name)!;
    try { known.set(await storage.decrypt(c), { id, type: type as RedactionType, ref: secretRef(type, id) }); } catch { /* unreadable (key changed): a new reference is made */ }
  }
  return known;
}

/** The conversation when it is `userId`'s own chat conversation. */
async function ownConversation(userId: string | undefined, conversationId: string | undefined): Promise<boolean> {
  if (!userId || !conversationId) return false;
  return !!(await q.one<{ id: string }>('SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?', conversationId, userId));
}

/**
 * Vault (owner chat) or redact (anywhere else) every secret in the strings of
 * `value`. Returns the same object when nothing was found.
 */
async function vaultStrings<T>(owner: { userId?: string; conversationId?: string; channel?: boolean }, value: T): Promise<{ value: T; changed: number; vaulted: boolean }> {
  const todo = new Set<string>();
  walkStrings(value, (s) => { if (hasSecret(s)) todo.add(s); return s; });
  if (todo.size === 0) return { value, changed: 0, vaulted: false };
  if (owner.channel || !(await ownConversation(owner.userId, owner.conversationId))) {
    const out = walkStrings(value, (s) => (todo.has(s) ? redactImportText(s).text : s));
    return { value: out, changed: todo.size, vaulted: false };
  }
  const userId = owner.userId!; const conversationId = owner.conversationId!;
  return serial(conversationId, async () => {
    const known = await knownSecrets(userId, conversationId);
    const done = new Map<string, string>();
    let vaulted = false;
    for (const s of todo) {
      const v = await vaultSecretsInText(userId, conversationId, s, known);
      if ((v.text.match(SECRET_REF_RE) ?? []).length > (s.match(SECRET_REF_RE) ?? []).length) vaulted = true;
      done.set(s, v.text);
    }
    known.clear();
    return { value: walkStrings(value, (s) => done.get(s) ?? s), changed: todo.size, vaulted };
  });
}

export interface ToolSecretContext { userId?: string; sessionId?: string; toolPolicy?: unknown }

/**
 * A tool's result before anyone reads it: secrets in its text, error and
 * structured fields go to the key store of the chat's owner (or are redacted
 * outside an owner chat). Image data is not scanned.
 */
export async function vaultToolResult<R extends { content?: Array<{ type: string; text?: string }>; error?: string; details?: unknown; data?: unknown }>(ctx: ToolSecretContext, result: R): Promise<R> {
  if (!result || typeof result !== 'object') return result;
  const texts = (result.content ?? []).map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : null));
  const scan = { texts, error: result.error, details: result.details, data: result.data };
  const out = await vaultStrings({ userId: ctx.userId, conversationId: ctx.sessionId, channel: !!ctx.toolPolicy }, scan)
    // The store or the database failed: never pass the value on, redact it.
    .catch(() => vaultStrings({ channel: true }, scan));
  if (out.changed === 0) return result;
  const v = out.value;
  let noted = !out.vaulted;
  const content = (result.content ?? []).map((b, i) => {
    if (v.texts[i] === null || v.texts[i] === undefined) return b;
    const text = noted ? v.texts[i]! : `${v.texts[i]}${NOTE}`;
    noted = true;
    return { ...b, text };
  });
  const next: R = { ...result, content };
  if (result.error !== undefined) next.error = v.error;
  if (result.details !== undefined) next.details = v.details;
  if (result.data !== undefined) next.data = v.data;
  return next;
}

/** Complete legacy SSE frames, checked before their first publication. */
export async function vaultChatFrames(userId: string, sessionId: string, frames: Array<Record<string, unknown>>, channel = false): Promise<Array<Record<string, unknown>>> {
  for (const kind of ['text', 'reasoning']) {
    const group = frames.filter(f => (f.type === 'reasoning' ? 'reasoning' : 'text') === kind && typeof f.content === 'string');
    const joined = group.map(f => String(f.content)).join('');
    if (hasSecret(joined) && group.length) {
      for (const f of group) f.content = '';
      group[group.length - 1].content = joined;
    }
  }
  try { return (await vaultStrings({ userId, conversationId: sessionId, channel }, frames)).value; }
  catch { return (await vaultStrings({ channel: true }, frames)).value; }
}

/** The parts of a run that vaultRunSecrets rewrites (a ChatRun). */
export interface RunSecretsTarget {
  userId: string;
  sessionId: string;
  answer: string;
  parts: unknown[];
  events: Array<{ seq: number; frame: Record<string, unknown> & { type: string } }>;
}

/**
 * When a run ends, before its turn is stored: secrets in the reply text, the
 * stored work (reasoning, tool inputs/outputs) and the run's event log are
 * replaced by references (the owner's chat) — the same reference per value.
 * Returns the number of rewritten strings (0 = nothing found).
 */
export async function vaultRunSecrets(run: RunSecretsTarget): Promise<number> {
  // A provider can split one value across text parts separated by tools.
  // Normalize only secret-bearing groups; ordinary chunk timing is preserved.
  for (const kind of ['text', 'reasoning']) {
    const parts = run.parts.filter((p: any) => p?.kind === kind) as Array<{ text: string }>;
    const joined = parts.map(p => p.text).join('');
    if (hasSecret(joined) && parts.length) {
      for (const p of parts) p.text = '';
      parts[parts.length - 1].text = joined;
    }
    const events = run.events.filter(e => e.frame.type === kind);
    const content = events.map(e => String(e.frame.content ?? '')).join('');
    if (hasSecret(content) && events.length) {
      for (const e of events) e.frame = { ...e.frame, content: '' };
      events[events.length - 1].frame = { ...events[events.length - 1].frame, content };
    }
  }
  const scan = { answer: run.answer, parts: run.parts };
  let known = new Map<string, SavedSecret>();
  let out: Awaited<ReturnType<typeof vaultStrings<typeof scan>>>;
  try {
    out = await vaultStrings({ userId: run.userId, conversationId: run.sessionId }, scan);
    if (out.changed > 0 && out.vaulted) known = await knownSecrets(run.userId, run.sessionId);
  } catch {
    // The store or the database failed: never keep the value, redact it.
    out = await vaultStrings({ channel: true }, scan);
  }
  if (out.changed === 0) return 0;
  run.answer = out.value.answer;
  run.parts.splice(0, run.parts.length, ...out.value.parts);
  // The event log: the same values → the same references. Text deltas may cut
  // a value in two, so each run of text (or reasoning) deltas is read as one.
  const clean = (s: string) => redactImportText(s, { onSecret: (type, value) => known.get(value)?.ref ?? `[REDACTED:${type}]` }).text;
  const events = run.events;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.frame.type !== 'text' && e.frame.type !== 'reasoning') {
      if (e.frame.type === 'tool_start' || e.frame.type === 'tool_result') e.frame = walkStrings(e.frame, clean);
      continue;
    }
    let j = i;
    let joined = '';
    while (j < events.length && events[j].frame.type === e.frame.type) { joined += String(events[j].frame.content ?? ''); j++; }
    const cleaned = clean(joined);
    if (cleaned !== joined) {
      e.frame = { ...e.frame, content: cleaned };
      events.splice(i + 1, j - i - 1);
    } else i = j - 1;
  }
  known.clear();
  return out.changed;
}

function walkStrings<T>(value: T, fn: (s: string) => string, depth = 0): T {
  if (typeof value === 'string') return fn(value) as unknown as T;
  if (depth > 20 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => walkStrings(v, fn, depth + 1)) as unknown as T;
  // Binary and opaque values (Buffer, typed arrays, Date, RegExp) are kept as they are; any other object is walked.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date || value instanceof RegExp) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walkStrings(v, fn, depth + 1);
  return out as T;
}

// ---- one-time cleanup of messages saved before CHAT-SECRETS-01 -------------

export interface CleanupReport { conversations: number; messages: number; secrets: number; applied: boolean }

/**
 * Owner-run, explicit: find secrets in the caller's saved chats (message text,
 * stored tool work, titles). `apply: false` only counts; `apply: true` moves
 * each value to the key store and rewrites the rows with references.
 */
export async function cleanupChatSecrets(userId: string, apply: boolean): Promise<CleanupReport> {
  const sessions = await q.all<{ id: string; title: string | null }>('SELECT id, title FROM chat_sessions WHERE user_id = ?', userId);
  const report: CleanupReport = { conversations: 0, messages: 0, secrets: 0, applied: apply };
  // SQLite: rewritten and freed space is zeroed, and the WAL is emptied afterwards,
  // so the old values do not stay readable in the database files.
  const sqlite = apply && dbDriver() === 'sqlite' ? getDatabase().getDb() : null;
  const secureBefore = sqlite ? sqlite.pragma('secure_delete', { simple: true }) : null;
  if (sqlite) sqlite.pragma('secure_delete = ON');
  try {
    for (const s of sessions) {
      let touched = false;
      const known = new Map<string, SavedSecret>(); // one reference per value in a conversation
      const rows = await q.all<{ id: string; content: string | null; parts: string | null }>('SELECT id, content, parts FROM chat_messages WHERE session_id = ?', s.id);
      for (const row of rows) {
        const content = row.content ?? '';
        let parts: unknown = null;
        try { parts = row.parts ? JSON.parse(row.parts) : null; } catch { parts = null; }
        let count = redactImportText(content).total;
        walkStrings(parts, (x) => { count += redactImportText(x).total; return x; });
        if (count === 0) continue;
        report.messages++; report.secrets += count; touched = true;
        if (!apply) continue;
        const nextContent = (await vaultSecretsInText(userId, s.id, content, known)).text;
        let nextParts = row.parts;
        if (parts !== null) {
          const strings = new Map<string, string>();
          const todo: string[] = [];
          walkStrings(parts, (x) => { if (redactImportText(x).total) todo.push(x); return x; });
          for (const x of todo) if (!strings.has(x)) strings.set(x, (await vaultSecretsInText(userId, s.id, x, known)).text);
          nextParts = JSON.stringify(walkStrings(parts, (x) => strings.get(x) ?? x));
        }
        await q.run('UPDATE chat_messages SET content = ?, parts = ? WHERE id = ?', nextContent, nextParts, row.id);
      }
      if (s.title && redactImportText(s.title).total) {
        touched = true; report.secrets += redactImportText(s.title).total;
        if (apply) await q.run('UPDATE chat_sessions SET title = ? WHERE id = ?', (await vaultSecretsInText(userId, s.id, s.title, known)).text, s.id);
      }
      if (touched) report.conversations++;
    }
  } finally {
    if (sqlite) {
      sqlite.pragma(`secure_delete = ${secureBefore ? 'ON' : 'OFF'}`);
      if (report.secrets > 0) sqlite.pragma('wal_checkpoint(TRUNCATE)');
    }
  }
  return report;
}
