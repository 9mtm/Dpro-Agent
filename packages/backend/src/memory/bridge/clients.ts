/**
 * The coding-agent CLIs the memory bridge serves (MEM-BRIDGE-01), and where
 * each one keeps its MCP server list and its memory/instruction files.
 * Verified against each tool's official docs on 2026-10-21:
 *
 *   claude-code  ~/.claude.json, top-level `mcpServers` (user scope; `.mcp.json` is the
 *                project scope); memory: CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md,
 *                .claude/rules/*.md, auto memory ~/.claude/projects/<project>/memory/*.md
 *   codex        $CODEX_HOME/config.toml (default ~/.codex), `[mcp_servers.<name>]`;
 *                memory: AGENTS.override.md / AGENTS.md from the git root down to the cwd
 *   gemini-cli   ~/.gemini/settings.json `mcpServers`; memory: GEMINI.md (imports with @file)
 *   antigravity  ~/.gemini/config/mcp_config.json `mcpServers`; rules: AGENTS.md / GEMINI.md,
 *                .agents/AGENTS.md, .agents/GEMINI.md, .agents/rules/*.md
 *
 * `home` / `env` are parameters so tests run on a temporary HOME only.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from '../../config/index.js';
import { cliConfigDir } from '../../services/instance-identity.js';

export const BRIDGE_CLIENTS = ['claude-code', 'codex', 'gemini-cli', 'antigravity'] as const;
export type BridgeClient = (typeof BRIDGE_CLIENTS)[number];
export const CLIENT_NAMES: Record<BridgeClient, string> = { 'claude-code': 'Claude Code', codex: 'Codex', 'gemini-cli': 'Gemini CLI', antigravity: 'Antigravity' };
/** The name the server gets in every CLI's MCP list. */
export const SERVER_NAME = 'dpro-memory';

export function isBridgeClient(v: unknown): v is BridgeClient {
  return typeof v === 'string' && (BRIDGE_CLIENTS as readonly string[]).includes(v);
}

export interface BridgeEnv { home?: string; env?: NodeJS.ProcessEnv }

/** The CLI's own MCP config file (user level). */
export function clientConfigFile(client: BridgeClient, where: BridgeEnv = {}): string {
  const home = where.home ?? os.homedir();
  const env = where.env ?? process.env;
  if (client === 'claude-code') return path.join(home, '.claude.json');
  if (client === 'codex') return path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
  if (client === 'gemini-cli') return path.join(home, '.gemini', 'settings.json');
  return path.join(home, '.gemini', 'config', 'mcp_config.json');
}

export interface ServerLaunch { command: string; args: string[]; env: Record<string, string> }

/**
 * How a CLI starts the dpro-memory server: this Node binary on the stdio
 * entry next to this file (built .js, or the .ts source through tsx). The
 * environment names only where things are (CLI config folder, backend URL);
 * no token or secret is ever part of a CLI config.
 */
export function serverLaunch(client: BridgeClient): ServerLaunch {
  const here = fileURLToPath(import.meta.url);
  const ext = path.extname(here);
  const entry = path.join(path.dirname(here), `mcp-stdio${ext}`);
  const args: string[] = [];
  if (ext === '.ts') {
    let loader = 'tsx';
    try { loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href; } catch { /* left as the bare name */ }
    args.push('--import', loader);
  }
  args.push(entry, '--client', client);
  const backendUrl = process.env.AGENT_PLAYER_URL || `http://127.0.0.1:${config.port}`;
  return { command: process.execPath, args, env: { AGENT_PLAYER_CONFIG_DIR: cliConfigDir(), AGENT_PLAYER_URL: backendUrl } };
}

/** True when the stdio entry this launch points at exists. */
export function launchReady(l: ServerLaunch): boolean {
  const entry = l.args.find((a) => /mcp-stdio\.(ts|js)$/.test(a));
  return !!entry && existsSync(entry);
}

/**
 * Claude Code's per-project folder name under ~/.claude/projects: the
 * absolute path with every character other than a letter or digit as '-'.
 */
export function claudeProjectDir(folder: string, home = os.homedir()): string {
  return path.join(home, '.claude', 'projects', path.resolve(folder).replace(/[^A-Za-z0-9]/g, '-'));
}
