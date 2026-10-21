#!/usr/bin/env node
/**
 * Entry of the dpro-memory MCP server (MEM-BRIDGE-01), started by a CLI:
 *   node mcp-stdio.js --client claude-code|codex|gemini-cli|antigravity
 * Environment (set by Dpro's registration; paths only, never a secret):
 *   AGENT_PLAYER_CONFIG_DIR  folder of instance.json;  AGENT_PLAYER_URL  the local backend
 * stdout carries only MCP messages; diagnostics go to stderr and never hold the token.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { cliConfigDir } from '../../services/instance-identity.js';
import { createBridgeMcpServer, httpBackend } from './mcp-server.js';

const CLIENTS = new Set(['claude-code', 'codex', 'gemini-cli', 'antigravity']);

async function main(): Promise<void> {
  const i = process.argv.indexOf('--client');
  const client = i >= 0 ? process.argv[i + 1] : '';
  if (!CLIENTS.has(client)) throw new Error('--client must be claude-code, codex, gemini-cli or antigravity');
  const backend = httpBackend({
    client, cwd: process.cwd(), configDir: cliConfigDir(),
    backendUrl: process.env.AGENT_PLAYER_URL || 'http://127.0.0.1:41522',
  });
  await createBridgeMcpServer(backend).connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`dpro-memory: failed to start: ${err instanceof Error ? err.message : 'unknown error'}\n`);
  process.exit(1);
});
