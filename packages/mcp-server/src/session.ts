/**
 * Where the backend is and which token to send.
 *
 * The token is the one `agent-player login` saved (CLI-03): one JSON file
 * `auth.json` in the CLI config directory, mode 0600, with the CLI marker.
 * Same lookup rules as packages/cli/src/utils/auth-store.ts. The token is
 * never printed, logged or put into an error message.
 *
 * Only a backend on this machine is allowed (127.0.0.1, ::1, localhost):
 * the token never goes to another host. Before the token is sent, the
 * backend must prove it is this install's backend (MCP-01b): it answers a
 * random nonce with an HMAC keyed by the per-install secret it writes, at
 * startup, to `instance.json` next to the token file (0600). Another local
 * program that took the port first cannot answer, and gets no token.
 */

import fs from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:41522';
const TOKEN_FILE_NAME = 'auth.json';
const INSTANCE_FILE_NAME = 'instance.json';
const INSTANCE_MARKER = 'agent-player-backend';
const PROOF_CONTEXT = 'agent-player-instance-v1';
const MARKER = 'agent-player-cli';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export class SessionError extends Error {}

export const NOT_SIGNED_IN =
  'Agent Player is not signed in on this machine. Run "agent-player login" (as the owner) first.';

export function getConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_PLAYER_CONFIG_DIR) return env.AGENT_PLAYER_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'agent-player');
  if (process.platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'agent-player');
  return path.join(os.homedir(), '.config', 'agent-player');
}

export function getTokenFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getConfigDir(env), TOKEN_FILE_NAME);
}

interface StoredSession { createdBy: string; token: string; backendUrl?: string }

const MAX_SESSION_FILE_BYTES = 64 * 1024;

/** Validate and read one opened file, so a path swap cannot bypass permission checks. */
function readPrivateJson(file: string, permissionError: string): any | null {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0)); } catch { return null; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SESSION_FILE_BYTES) return null;
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new SessionError(permissionError);
    const buffer = Buffer.alloc(MAX_SESSION_FILE_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = fs.readSync(fd, buffer, used, buffer.length - used, null);
      if (count === 0) break;
      used += count;
    }
    if (used > MAX_SESSION_FILE_BYTES) return null;
    return JSON.parse(buffer.subarray(0, used).toString('utf8'));
  } catch (error) {
    if (error instanceof SessionError) throw error;
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function readSessionFile(env: NodeJS.ProcessEnv): StoredSession | null {
  const file = getTokenFilePath(env);
  const data = readPrivateJson(file, `The Agent Player token file is readable by other users; run "chmod 600 ${file}" or "agent-player login" again.`);
  if (data && data.createdBy === MARKER && typeof data.token === 'string' && data.token) return data as StoredSession;
  return null;
}

/** Normalised loopback URL, or throws SessionError. */
export function checkLoopbackUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SessionError('The Agent Player backend URL is not valid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SessionError('The Agent Player backend URL must use http or https.');
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new SessionError('The Agent Player MCP server only talks to a backend on this machine (127.0.0.1, ::1 or localhost).');
  }
  if (url.username || url.password) throw new SessionError('The Agent Player backend URL must not contain credentials.');
  return `${url.protocol}//${url.host}`;
}

export interface Session { backendUrl: string; token: string }

/**
 * Backend URL ($AGENT_PLAYER_URL / $BACKEND_URL, else the saved one, else the
 * default) and the saved token. Read on every call, so a new login is picked
 * up without restarting the MCP server.
 */
export function loadSession(env: NodeJS.ProcessEnv = process.env): Session {
  const saved = readSessionFile(env);
  const rawUrl = env.AGENT_PLAYER_URL || env.BACKEND_URL || saved?.backendUrl || DEFAULT_BACKEND_URL;
  const backendUrl = checkLoopbackUrl(rawUrl);
  if (!saved) throw new SessionError(NOT_SIGNED_IN);
  return { backendUrl, token: saved.token };
}

export const NO_INSTANCE =
  'The Agent Player backend identity file (instance.json next to the CLI token) is missing. Start the Agent Player backend once (it writes the file), then try again.';

export interface InstanceIdentity { id: string; secret: string }

/** The backend identity the backend wrote next to the token file (0600), or throws SessionError. */
export function loadInstance(env: NodeJS.ProcessEnv = process.env): InstanceIdentity {
  const file = path.join(getConfigDir(env), INSTANCE_FILE_NAME);
  const data = readPrivateJson(file, `The Agent Player instance file is readable by other users; run "chmod 600 ${file}" or restart the backend.`);
  if (data && data.createdBy === INSTANCE_MARKER && typeof data.id === 'string' && typeof data.secret === 'string' && /^[0-9a-f]{64}$/i.test(data.secret)) {
    return { id: data.id, secret: data.secret };
  }
  throw new SessionError(NO_INSTANCE);
}

/** HMAC the backend must return for this nonce. */
export function expectedProof(instance: InstanceIdentity, nonce: string): string {
  return createHmac('sha256', Buffer.from(instance.secret, 'hex')).update(`${PROOF_CONTEXT}:${instance.id}:${nonce}`).digest('hex');
}

/** Constant-time check of the backend's answer. */
export function proofMatches(instance: InstanceIdentity, nonce: string, answer: unknown): boolean {
  if (!answer || typeof answer !== 'object') return false;
  const { id, proof } = answer as { id?: unknown; proof?: unknown };
  if (id !== instance.id || typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false;
  return timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(expectedProof(instance, nonce), 'hex'));
}
