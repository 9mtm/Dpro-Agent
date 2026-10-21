/**
 * Minimal client for the owner-only APIs of the local backend: small-agent
 * runs (packages/backend/src/api/routes/small-agent.ts) and agent handoff
 * notes (agent-handoffs.ts). The bearer token comes
 * from the CLI token store on every call; it is never part of a message,
 * and redirects are refused so it cannot be carried to another host.
 * Before every request the backend must answer an identity challenge
 * (GET /api/instance, MCP-01b); without a valid answer no token is sent.
 */

import { randomBytes } from 'node:crypto';
import { loadInstance, loadSession, proofMatches, SessionError, NOT_SIGNED_IN } from './session.js';

export class BackendError extends Error {
  constructor(message: string, readonly status: number, readonly data?: any) {
    super(message);
  }
}

export interface BackendClient {
  request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<any>;
}

export function createBackendClient(env: NodeJS.ProcessEnv = process.env, timeoutMs = 30_000): BackendClient {
  return {
    async request(method, path, body) {
      let session;
      let instance;
      try {
        session = loadSession(env);
        instance = loadInstance(env);
      } catch (err) {
        if (err instanceof SessionError) throw new BackendError(err.message, 0);
        throw err;
      }
      // MCP-01b: verify the backend's identity first (no token on this call).
      const nonce = randomBytes(24).toString('hex');
      let verified = false;
      try {
        const res = await fetch(`${session.backendUrl}/api/instance?nonce=${nonce}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(Math.min(timeoutMs, 10_000)),
        });
        verified = res.ok && proofMatches(instance, nonce, await res.json().catch(() => null));
      } catch {
        throw new BackendError(`Cannot reach the Agent Player backend at ${session.backendUrl}. Is it running?`, 0);
      }
      if (!verified) {
        throw new BackendError(`The service at ${session.backendUrl} could not prove it is this machine's Agent Player backend, so the token was not sent. If the backend was reinstalled, restart it; otherwise check what is listening on that port.`, 0);
      }
      const headers: Record<string, string> = { Authorization: `Bearer ${session.token}`, Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let res: Response;
      try {
        res = await fetch(`${session.backendUrl}${path}`, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new BackendError(`Cannot reach the Agent Player backend at ${session.backendUrl}. Is it running?`, 0);
      }
      const text = await res.text();
      let data: any;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = undefined;
      }
      if (!res.ok) {
        if (res.status === 401) throw new BackendError(NOT_SIGNED_IN, 401);
        if (res.status === 403) throw new BackendError('The saved Agent Player session is not the owner account; these tools are owner-only.', 403);
        const detail = data && typeof data.error === 'string' ? data.error.slice(0, 300) : '';
        throw new BackendError(`Agent Player backend refused the request (${res.status})${detail ? `: ${detail}` : ''}`, res.status, data);
      }
      return data;
    },
  };
}
