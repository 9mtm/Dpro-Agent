/**
 * How the dpro-memory MCP server proves it may read the owner's memory
 * (MEM-BRIDGE-01).
 *
 *  - One random token per install and per CLI, kept ONLY in the encrypted
 *    credential store (AES-256-GCM, credentials/), named
 *    `dpro-memory-bridge:<client>`. It is never written to a CLI config,
 *    a project file or a log.
 *  - The MCP server (a child process of the CLI) asks for it at start: it
 *    first checks the backend's identity (MCP-01b, GET /api/instance), then
 *    answers a nonce with an HMAC keyed by the same per-install secret
 *    (the 0600 `instance.json` next to the CLI token). Only a process of
 *    this user on this machine can read that file. Each nonce works once.
 *  - The kill switch of a CLI deletes its token: a running server loses
 *    access at its next call and cannot get a new one until the owner turns
 *    the CLI on again.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getCredentialManager } from '../../credentials/manager.js';
import { CredentialType } from '../../credentials/types.js';
import { getInstanceIdentity, NONCE_PATTERN } from '../../services/instance-identity.js';
import type { BridgeClient } from './clients.js';
import { sessionProof } from './proof.js';

const NONCE_TTL_MS = 5 * 60_000;
const tokenName = (client: BridgeClient) => `dpro-memory-bridge:${client}`;
const usedNonces = new Map<string, number>();

const sameHex = (a: string, b: string) => a.length === b.length && /^[0-9a-f]+$/.test(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

/** True once per valid (nonce, proof) pair of this install. */
export function checkSessionProof(client: BridgeClient, nonce: unknown, proof: unknown, now = Date.now()): boolean {
  for (const [n, exp] of usedNonces) if (exp < now) usedNonces.delete(n);
  if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce) || typeof proof !== 'string' || usedNonces.has(nonce)) return false;
  const ident = getInstanceIdentity();
  if (!sameHex(proof, sessionProof(ident.secret, ident.id, client, nonce))) return false;
  usedNonces.set(nonce, now + NONCE_TTL_MS);
  return true;
}

/** The CLI's token, created on first use. */
export async function ensureToken(ownerId: string, client: BridgeClient): Promise<string> {
  const cm = getCredentialManager();
  if (await cm.getByName(tokenName(client), ownerId)) return cm.getValueByName(tokenName(client), ownerId);
  const value = randomBytes(32).toString('hex');
  await cm.create({ name: tokenName(client), type: CredentialType.API_KEY, value, userId: ownerId, description: `dpro-memory MCP access for ${client} (MEM-BRIDGE-01)` });
  return value;
}

/** Kill switch: the CLI's token is deleted. */
export async function revokeToken(ownerId: string, client: BridgeClient): Promise<void> {
  const cm = getCredentialManager();
  const c = await cm.getByName(tokenName(client), ownerId);
  if (c) await cm.delete(c.id);
}

export async function tokenMatches(ownerId: string, client: BridgeClient, token: unknown): Promise<boolean> {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return false;
  const cm = getCredentialManager();
  if (!(await cm.getByName(tokenName(client), ownerId))) return false;
  return sameHex(token, await cm.getValueByName(tokenName(client), ownerId));
}
