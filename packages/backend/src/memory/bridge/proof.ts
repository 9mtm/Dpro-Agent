/** The dpro-memory session proof (MEM-BRIDGE-01); no imports beyond node, so the MCP server stays light. */
import { createHmac } from 'node:crypto';

const PROOF_CONTEXT = 'dpro-memory-bridge-v1';

/** HMAC the MCP server sends for a nonce, keyed by the per-install secret of instance.json. */
export function sessionProof(secret: string, id: string, client: string, nonce: string): string {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(`${PROOF_CONTEXT}:${id}:${client}:${nonce}`).digest('hex');
}
