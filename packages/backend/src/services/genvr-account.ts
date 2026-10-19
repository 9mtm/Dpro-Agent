/**
 * Genvr account link for the owner (device consent, then a scoped bearer grant).
 *
 * The owner signs in and approves on the Genvr website; Dpro never sees the
 * Genvr password. The access token is kept only in the encrypted credential
 * store (never in a response, log, prompt or world file). The device code
 * stays in this process. Only the account's display name, scopes and expiry
 * are kept in plain form so Settings → Connections can show the state.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { q } from '../repositories/sql-steps.js';
import { getCredentialManager } from '../credentials/manager.js';
import { CredentialType } from '../credentials/types.js';
import { logAudit } from './audit-logger.js';

export const GENVR_API = 'https://api.genvr.net';
export const GENVR_WEB = 'https://genvr.net';
export const GENVR_SCOPES = ['worlds:read', 'worlds:write', 'worlds:publish', 'worlds:join'] as const;
const CLIENT_NAME = 'Dpro Agent';
const SECRET_NAME = 'genvr-account';
const SECRET_SKILL = 'genvr-account';

type Sdk = typeof import('../../../core-ui/vendor/genvr/package/dist/types/index.js');
let sdkLoad: Promise<Sdk> | undefined;
/** The pinned SDK copy prepared by core-ui/scripts/prepare-genvr.cjs. */
export function genvrSdk(): Promise<Sdk> {
  sdkLoad ??= import(pathToFileURL(fileURLToPath(new URL('../../../core-ui/vendor/genvr/package/dist/index.js', import.meta.url))).href) as Promise<Sdk>;
  return sdkLoad;
}

export type ConnectionStatus = 'not_connected' | 'connecting' | 'connected' | 'expired' | 'error';
export interface GenvrConnection {
  id: 'genvr'; name: 'Genvr'; status: ConnectionStatus;
  account: { name: string } | null; scopes: string[]; linkedAt: string | null; expiresAt: string | null;
  pending: { userCode: string; verificationUri: string; expiresAt: string } | null;
  error: string | null;
}

interface Pending {
  request: { deviceCode: string; userCode: string; verificationUri: string; expiresIn: number; interval: number };
  expiresAt: number; timer?: ReturnType<typeof setTimeout>; error?: string;
}
const pending = new Map<string, Pending>();
const failures = new Map<string, string>();

type FullClient = InstanceType<Sdk['GenvrClient']>;
/** The linked client calls used by Dpro (all network-facing, all server-authorized). */
export type LinkedClient = Pick<FullClient, 'linkedIdentity' | 'disconnect' | 'createDraft' | 'readWorld' | 'uploadWorld' | 'experience' | 'publishWorld'>;
/** A client for the stored grant of this user (null when not linked or expired). */
export async function linkedGenvrClient(userId: string): Promise<LinkedClient | null> {
  const token = await genvrToken(userId); return token ? deps.client(token) : null;
}

/** Test seam: replace the network-facing SDK pieces. */
export interface GenvrAccountDeps {
  link: () => Promise<{ start(name: string, scopes: string[]): Promise<Pending['request']>; poll(r: Pending['request']): Promise<{ status: 'pending' } | { status: 'linked'; account: { accessToken: string; expiresAt: string; scopes: string[]; grantId: string } }> }>;
  client: (token: string) => Promise<LinkedClient>;
  now: () => number;
}
const defaults: GenvrAccountDeps = {
  link: async () => { const sdk = await genvrSdk(); return new sdk.GenvrAccountLink(GENVR_API) as any; },
  client: async token => { const sdk = await genvrSdk(); return sdk.GenvrClient.linked(GENVR_API, token); },
  now: () => Date.now(),
};
let deps: GenvrAccountDeps = { ...defaults };
export function setGenvrAccountDeps(next: Partial<GenvrAccountDeps> | null): void {
  deps = next ? { ...deps, ...next } : { ...defaults };
  for (const p of pending.values()) if (p.timer) clearTimeout(p.timer);
  pending.clear(); failures.clear();
}

async function table(): Promise<void> {
  await q.run('CREATE TABLE IF NOT EXISTS genvr_account_links (user_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, account_name TEXT NOT NULL, scopes TEXT NOT NULL, grant_id TEXT NOT NULL, expires_at TEXT NOT NULL, linked_at TEXT NOT NULL)');
}
interface Row { account_id: string; account_name: string; scopes: string; grant_id: string; expires_at: string; linked_at: string }
async function row(userId: string): Promise<Row | undefined> { await table(); return q.one<Row>('SELECT account_id, account_name, scopes, grant_id, expires_at, linked_at FROM genvr_account_links WHERE user_id = ?', userId); }

/** The stored bearer token, or null when there is no usable link. Never leaves the backend. */
export async function genvrToken(userId: string): Promise<string | null> {
  const r = await row(userId); if (!r || Date.parse(r.expires_at) <= deps.now()) return null;
  const c = await getCredentialManager().getByName(SECRET_NAME, userId);
  return c ? getCredentialManager().getValue(c.id) : null;
}

export async function genvrConnection(userId: string): Promise<GenvrConnection> {
  const base: GenvrConnection = { id: 'genvr', name: 'Genvr', status: 'not_connected', account: null, scopes: [], linkedAt: null, expiresAt: null, pending: null, error: failures.get(userId) ?? null };
  const p = pending.get(userId);
  if (p && p.expiresAt <= deps.now()) { clearTimeout(p.timer); pending.delete(userId); failures.set(userId, 'link_expired'); base.error = 'link_expired'; }
  const r = await row(userId);
  if (r) {
    Object.assign(base, { account: { name: r.account_name }, scopes: JSON.parse(r.scopes), linkedAt: r.linked_at, expiresAt: r.expires_at });
    base.status = Date.parse(r.expires_at) <= deps.now() ? 'expired' : 'connected';
  }
  const live = pending.get(userId);
  if (live) { base.status = 'connecting'; base.pending = { userCode: live.request.userCode, verificationUri: live.request.verificationUri, expiresAt: new Date(live.expiresAt).toISOString() }; }
  else if (!r && base.error) base.status = 'error';
  return base;
}

async function finish(userId: string, account: { accessToken: string; expiresAt: string; scopes: string[]; grantId: string }): Promise<void> {
  const identity = await (await deps.client(account.accessToken)).linkedIdentity();
  const manager = getCredentialManager();
  const existing = await manager.getByName(SECRET_NAME, userId);
  if (existing) await manager.update(existing.id, { value: account.accessToken });
  else await manager.create({ name: SECRET_NAME, type: CredentialType.SECRET, value: account.accessToken, description: 'Genvr account link (worlds)', skillId: SECRET_SKILL, userId });
  await table();
  await q.run('INSERT INTO genvr_account_links (user_id, account_id, account_name, scopes, grant_id, expires_at, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET account_id = excluded.account_id, account_name = excluded.account_name, scopes = excluded.scopes, grant_id = excluded.grant_id, expires_at = excluded.expires_at, linked_at = excluded.linked_at',
    userId, String(identity.id).slice(0, 200), String(identity.name).slice(0, 200), JSON.stringify(account.scopes), account.grantId, account.expiresAt, new Date(deps.now()).toISOString());
  logAudit({ event_type: 'connection.change', event_category: 'security', severity: 'info', user_id: userId, resource_type: 'connection', resource_id: 'genvr', action: 'link', success: true, metadata: { scopes: account.scopes } });
}

function schedule(userId: string, p: Pending): void {
  // Never faster than the server's interval (currently 5 s).
  p.timer = setTimeout(async () => {
    if (pending.get(userId) !== p) return;
    if (p.expiresAt <= deps.now()) { pending.delete(userId); failures.set(userId, 'link_expired'); return; }
    try {
      const result = await (await deps.link()).poll(p.request);
      if (pending.get(userId) !== p) return;
      if (result.status === 'linked') { pending.delete(userId); await finish(userId, result.account); return; }
      schedule(userId, p);
    } catch (e) {
      if (pending.get(userId) !== p) return;
      pending.delete(userId); failures.set(userId, errorCode(e));
    }
  }, Math.max(5, p.request.interval) * 1000);
  p.timer.unref?.();
}

/** Start the browser consent; the backend polls by itself. Returns the code to show. */
export async function startGenvrLink(userId: string): Promise<GenvrConnection> {
  const old = pending.get(userId); if (old) { clearTimeout(old.timer); pending.delete(userId); }
  failures.delete(userId);
  const request = await (await deps.link()).start(CLIENT_NAME, [...GENVR_SCOPES]);
  const p: Pending = { request, expiresAt: deps.now() + Math.min(request.expiresIn, 900) * 1000 };
  pending.set(userId, p); schedule(userId, p);
  return genvrConnection(userId);
}

export async function cancelGenvrLink(userId: string): Promise<GenvrConnection> {
  const p = pending.get(userId); if (p) { clearTimeout(p.timer); pending.delete(userId); }
  failures.delete(userId);
  return genvrConnection(userId);
}

/** Revoke the grant on Genvr (best effort), then forget it here. */
export async function disconnectGenvr(userId: string): Promise<GenvrConnection> {
  await cancelGenvrLink(userId);
  const manager = getCredentialManager();
  const c = await manager.getByName(SECRET_NAME, userId);
  let revoked = false;
  if (c) {
    try { await (await deps.client(await manager.getValue(c.id))).disconnect(); revoked = true; } catch { /* expired or offline: the local copy is removed anyway */ }
    await manager.delete(c.id);
  }
  await table(); await q.run('DELETE FROM genvr_account_links WHERE user_id = ?', userId);
  logAudit({ event_type: 'connection.change', event_category: 'security', severity: 'info', user_id: userId, resource_type: 'connection', resource_id: 'genvr', action: 'disconnect', success: true, metadata: { revoked } });
  return genvrConnection(userId);
}

/** 401 relink, 403 missing scope, 404 not owned or not accessible, 409 reread (never overwrite). */
export function errorCode(e: unknown): string {
  const status = (e as { status?: unknown })?.status;
  if (status === 401) return 'relink_required';
  if (status === 403) return 'missing_scope';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (typeof status === 'number' && status >= 400 && status < 500) return 'rejected';
  return 'unavailable';
}
