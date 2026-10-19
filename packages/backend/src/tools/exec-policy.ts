/**
 * Exec policy for agent tools.
 *
 * Exec-class tools run host processes or shell commands on behalf of a model
 * (exec, execute_code, desktop_control, the CLI bridges). They are OFF unless
 * the server operator sets AGENT_EXEC_TOOLS=true in the server environment.
 * No API call or database setting can turn them on.
 *
 * When they are on, child processes get a minimal environment (no server
 * secrets such as ENCRYPTION_KEY, JWT_SECRET or provider API keys) and never
 * a working directory inside the server's data directory.
 */

import { protectedDataDirs, realish } from '../config/data-root.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolResult } from './types.js';

export const EXEC_TOOLS_ENV_FLAG = 'AGENT_EXEC_TOOLS';

/** Tools that spawn host processes or run shell commands. */
export const EXEC_CLASS_TOOLS: ReadonlySet<string> = new Set([
  'exec',
  'execute_code',
  'desktop_control',
  'claude_cli',
  'gemini_cli',
]);

export function isExecToolsEnabled(): boolean {
  // RUN-ISO ISO-2: an isolated server never runs exec tools or CLI providers.
  if (process.env.AGENT_PLAYER_ISOLATED === '1') return false;
  return process.env[EXEC_TOOLS_ENV_FLAG] === 'true';
}

export function isExecClassTool(name: string): boolean {
  return EXEC_CLASS_TOOLS.has(name);
}

/** True when the tool may be offered to / run by a model right now. */
export function isToolAllowedByExecPolicy(name: string): boolean {
  return !isExecClassTool(name) || isExecToolsEnabled();
}

/**
 * Extension manifest permissions that mark an extension's tools as
 * exec-class (they may spawn processes). Such tools follow the same gate as
 * the built-in exec tools and are never used in channel conversations.
 */
export const EXEC_EXTENSION_PERMISSIONS: readonly string[] = ['process', 'exec'];

/** Exec-class by name, or an extension tool marked exec-class at registration. */
export function isToolExecClass(tool: { name: string; execClass?: boolean }): boolean {
  return isExecClassTool(tool.name) || tool.execClass === true;
}

/** Like isToolAllowedByExecPolicy, but also honours the tool's own exec flag. */
export function isToolObjectAllowedByExecPolicy(tool: { name: string; execClass?: boolean }): boolean {
  return !isToolExecClass(tool) || isExecToolsEnabled();
}

export function execToolRefusal(name: string): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text:
          `Tool "${name}" is disabled: host command execution for agents is off. ` +
          `The server operator must set ${EXEC_TOOLS_ENV_FLAG}=true to enable it.`,
      },
    ],
    error: 'Exec-class tools are disabled by server policy',
  };
}

/**
 * Environment variables a child process may inherit. Everything else in
 * process.env (secrets, API keys, tokens, DB paths) is dropped.
 */
const CHILD_ENV_ALLOWLIST = [
  // POSIX basics
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  'TERM', 'TZ', 'TMPDIR', 'TMP', 'TEMP',
  // GUI session (needed by desktop control on Linux/macOS)
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR',
  // Windows basics
  'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'PROGRAMDATA',
  'ProgramFiles', 'PROGRAMFILES', 'ProgramFiles(x86)', 'HOMEDRIVE', 'HOMEPATH',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
];

/**
 * Build a minimal child environment. `extra` adds explicit values a specific
 * tool needs (e.g. NO_COLOR); undefined values are skipped.
 */
export function minimalChildEnv(
  extra: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  const entries: Array<[string, string]> = [];
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === 'string') entries.push([key, value]);
  }
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === 'string') entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

function realOrResolved(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * True when `p` is inside a folder that holds server data. Uses the shared
 * protectedDataDirs() list (config/data-root.ts), the same one the file
 * sandbox uses; symlinks are resolved on both sides (realish), also for a
 * path that does not exist yet.
 */
export function isInsideDataDir(p: string): boolean {
  const targets = [path.resolve(p), realish(p)];
  if (targets.some((t) => t.split(path.sep).includes('.data'))) return true;
  const fold = (x: string) => (process.platform === 'darwin' || process.platform === 'win32' ? x.toLowerCase() : x);
  return protectedDataDirs().some((dir) => targets.some((t) => {
    const a = fold(t);
    const d = fold(dir);
    return a === d || a.startsWith(d + path.sep);
  }));
}

/**
 * Working directory for an agent-tool child process. Throws when the
 * requested directory is inside the data directory.
 */
export function safeChildCwd(requested?: string): string {
  if (requested) {
    if (isInsideDataDir(requested)) {
      throw new Error('Working directory inside the data directory is not allowed');
    }
    return path.resolve(requested);
  }
  const fallback = process.cwd();
  return isInsideDataDir(fallback) ? os.tmpdir() : fallback;
}
