import { safeConsole } from '../../services/safe-error-log.js';
/**
 * Claude Code CLI Tool
 *
 * Sends a prompt to the locally-installed Claude Code CLI (`claude`)
 * and returns the response. Uses the `--print` / `-p` flag for non-interactive
 * single-turn use.
 *
 * This creates a second Claude Code process — useful for:
 *   - Running Claude Code's own tools (file read/write/exec) on a sub-task
 *   - Getting a sandboxed agentic response without affecting the main chat
 *   - Delegating coding tasks with full Claude Code tool access
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { Tool, ToolResult, ToolExecutionContext } from '../types.js';
import { getAgentApiKey, getEnvProviderApiKey } from '../../credentials/authority.js';
import { getCredentialManager } from '../../credentials/manager.js';
import { resolveToolUser } from '../credentials/credentials-save.js';
import {
  execToolRefusal,
  isExecToolsEnabled,
  minimalChildEnv,
  safeChildCwd,
} from '../exec-policy.js';
import { cliFailureText, cliNoOutputText, safeErrorFields } from '../../services/safe-error-log.js';

const execFileAsync = promisify(execFile);
import { cliInvocation } from './process-invocation.js';

// npm global bin dirs — checked in priority order
const NODE_BIN_DIRS_WIN = [
  path.join('C:', 'Program Files', 'nodejs'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'nodejs'),
];

async function findClaudeExecutable(): Promise<string> {
  if (process.platform === 'win32') {
    const candidates = NODE_BIN_DIRS_WIN.flatMap(d => [
      path.join(d, 'claude.exe'),
      path.join(d, 'claude.cmd'),
      path.join(d, 'claude'),
    ]).concat(['claude']);
    for (const bin of candidates) {
      try { await fs.access(bin); return bin; } catch { /* next */ }
    }
  } else {
    const candidates = [
      'claude',
      '/usr/local/bin/claude',
      path.join(os.homedir(), '.local', 'bin', 'claude'),
    ];
    for (const bin of candidates) {
      try { await fs.access(bin); return bin; } catch { /* next */ }
    }
  }
  // Fall back to PATH — execFile will throw ENOENT if not found
  return 'claude';
}

/** Credential names checked, in order, for the Claude CLI's Anthropic API key. */
const ANTHROPIC_KEY_NAMES = ['anthropic_api_key', 'claude_api_key'];

/**
 * F-06: Anthropic API key from the calling user's own encrypted credentials
 * (by name, then the newest one saved for the 'claude'/'anthropic' service).
 * No user in the context → nothing is read; never another user's credential.
 */
export async function getAnthropicKeyForUser(userId: unknown): Promise<string> {
  const owner = await resolveToolUser(userId);
  if (!owner) return '';
  const manager = getCredentialManager();
  try {
    for (const name of ANTHROPIC_KEY_NAMES) {
      const credential = await manager.getByName(name, owner);
      if (credential) return await manager.getValue(credential.id);
    }
    const byService = (await manager.list(owner))
      .filter((c) => c.skillId === 'claude' || c.skillId === 'anthropic')
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    if (byService[0]) return await manager.getValue(byService[0].id);
  } catch {
    console.warn('[ClaudeCLI] Could not read the stored Anthropic key');
  }
  return '';
}

export const claudeCliTool: Tool = {
  name: 'claude_cli',
  description:
    'Send a prompt to the locally-installed Claude Code CLI and get the response. ' +
    'Claude Code CLI has its own tools: file read/write, shell exec, web fetch, memory. ' +
    'Use this to delegate a coding or file-system task to a separate Claude Code process, ' +
    'or to run Claude Code with a specific working directory. ' +
    'Requires `claude` CLI to be installed (`npm install -g @anthropic-ai/claude-code`).',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The prompt / task to send to Claude Code CLI.',
      },
      workdir: {
        type: 'string',
        description:
          'Working directory for the Claude Code process (optional). ' +
          'Defaults to the current backend working directory.',
      },
      model: {
        type: 'string',
        description:
          'Model to use (optional). Example: "claude-sonnet-4-5-20250929". ' +
          'Leave empty to use the CLI default.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 180000 = 3 minutes).',
      },
    },
    required: ['prompt'],
  },

  async execute(params, context?: ToolExecutionContext): Promise<ToolResult> {
    const { prompt, workdir, model, timeout = 180_000 } = params;

    // SECURITY: the CLI runs a host process with its own shell tools; off
    // unless AGENT_EXEC_TOOLS=true (S0-Q.5)
    if (!isExecToolsEnabled()) return execToolRefusal('claude_cli');

    // SECURITY: never run inside the data directory (S0-Q.5)
    let cwd: string;
    try {
      cwd = safeChildCwd(workdir);
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `❌ Blocked: ${error.message}` }],
        error: 'Working directory not allowed by security policy',
      };
    }

    safeConsole.log(`[ClaudeCLI] 🚀 Sending prompt (${prompt.length} chars)`);
    if (workdir) console.log(`[ClaudeCLI]   Workdir: ${workdir}`);
    if (model) safeConsole.log(`[ClaudeCLI]   Model: ${model}`);

    // SECURITY (S1.1): key from the credential authority only: the server env
    // key, then the calling agent's OWN key, then the caller's own credentials.
    // Never "any agent's key" (that was an unscoped read of other agents' keys).
    let anthropicApiKey = getEnvProviderApiKey('claude');
    if (!anthropicApiKey) {
      anthropicApiKey = await getAgentApiKey(context?.agentId);
    }
    if (!anthropicApiKey) {
      // Second try: the calling user's encrypted credentials (F-06)
      anthropicApiKey = await getAnthropicKeyForUser(context?.userId);
    }

    const claudeBin = await findClaudeExecutable();
    console.log(`[ClaudeCLI] Binary: ${claudeBin}, API key: ${anthropicApiKey ? 'found' : 'MISSING'}`);

    // SECURITY: minimal environment (no server secrets, no CLAUDECODE);
    // only the CLI's own API key is passed (S0-Q.5)
    const childEnv = minimalChildEnv({
      NO_COLOR: '1',
      TERM: 'dumb',
      ANTHROPIC_API_KEY: anthropicApiKey || undefined,
    });

    // claude -p "prompt" [--model model]
    const args: string[] = ['-p', prompt];
    if (model) args.push('--model', model);

    const startedAt = Date.now();
    try {

      let stdout: string;
      let stderr: string;

      const invocation = await cliInvocation(claudeBin, args);
      ({ stdout, stderr } = await execFileAsync(invocation.file, invocation.args, {
        timeout,
        maxBuffer: 1024 * 1024 * 10,
        cwd,
        env: childEnv,
        windowsHide: true,
      }));

      // SECURITY (FU-03): stderr is never the answer, even on exit 0 (it can
      // hold the prompt, paths or tokens). Empty stdout gets a generic text.
      const answer = (stdout || '').trim();
      const output = answer || cliNoOutputText('Claude');
      console.log(`[ClaudeCLI] ✅ Response length: ${answer.length} chars, stderr length: ${(stderr || '').length} chars`);

      return {
        content: [{ type: 'text', text: output }],
        details: { model: model || 'default', workdir: cwd },
      };
    } catch (err: any) {
      // SECURITY (FU-02): stderr and the message never reach the client; the
      // reply names only the exit code or signal (and a timeout note).
      const msg = cliFailureText('Claude', err, timeout);

      // SECURITY (FU-01): stderr and the message can hold the prompt, paths or tokens.
      console.error('[ClaudeCLI] ❌ Error', safeErrorFields(err, startedAt));

      // Only show install hint when the binary itself is missing (ENOENT), not for API errors
      const notFound = err.code === 'ENOENT';
      const hint = notFound
        ? '\n\nClaude Code CLI is not installed. Run: npm install -g @anthropic-ai/claude-code'
        : '';

      return {
        content: [{ type: 'text', text: `❌ ${msg}${hint}` }],
        error: msg,
      };
    }
  },
};
