import { safeConsole } from '../../services/safe-error-log.js';
/**
 * Gemini CLI Tool
 *
 * Sends a prompt to the locally-installed Google Gemini CLI (`gemini`)
 * and returns the response. The CLI handles authentication via the local
 * ~/.gemini config — no API key needed from Agent Player.
 *
 * Capabilities exposed via this bridge:
 *   - Web search (Gemini CLI has Google Search built-in)
 *   - Code generation / explanation
 *   - File summarization (pass file content in the prompt)
 *   - Any task that benefits from Gemini 2.0+ models
 */

import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { Tool, ToolResult } from '../types.js';
import { execToolRefusal, isExecToolsEnabled, minimalChildEnv } from '../exec-policy.js';
import { getEnvProviderApiKey } from '../../credentials/authority.js';
import { cliFailureText, cliNoOutputText, safeErrorFields } from '../../services/safe-error-log.js';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// npm global bin dirs — checked in priority order
const NODE_BIN_DIRS_WIN = [
  path.join('C:', 'Program Files', 'nodejs'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'nodejs'),
];

async function findGeminiExecutable(): Promise<string> {
  if (process.platform === 'win32') {
    const candidates = NODE_BIN_DIRS_WIN.flatMap(d => [
      path.join(d, 'gemini.cmd'),
      path.join(d, 'gemini'),
    ]).concat(['gemini']);
    for (const bin of candidates) {
      try { await fs.access(bin); return bin; } catch { /* next */ }
    }
  } else {
    const candidates = [
      'gemini',
      '/usr/local/bin/gemini',
      path.join(os.homedir(), '.local', 'bin', 'gemini'),
    ];
    for (const bin of candidates) {
      try { await fs.access(bin); return bin; } catch { /* next */ }
    }
  }
  // Fall back to PATH — execFile will throw ENOENT if not found
  return 'gemini';
}

export const geminiCliTool: Tool = {
  name: 'gemini_cli',
  description:
    'Send a prompt to the locally-installed Google Gemini CLI and get the response. ' +
    'Gemini CLI has Google Search built-in, so use this for web search, real-time information, ' +
    'or to get a second opinion from Gemini models. ' +
    'Requires `gemini` CLI to be installed (`npm install -g @google/gemini-cli`).',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The prompt / question to send to Gemini CLI.',
      },
      model: {
        type: 'string',
        description:
          'Gemini model to use (optional). Examples: "gemini-2.0-flash", "gemini-2.5-pro". ' +
          'Leave empty to use the CLI default.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 120000 = 2 minutes).',
      },
    },
    required: ['prompt'],
  },

  async execute(params): Promise<ToolResult> {
    const { prompt, model, timeout = 120_000 } = params;

    // SECURITY: the CLI runs a host process with its own shell tools; off
    // unless AGENT_EXEC_TOOLS=true (S0-Q.5)
    if (!isExecToolsEnabled()) return execToolRefusal('gemini_cli');

    safeConsole.log(`[GeminiCLI] 🚀 Sending prompt (${prompt.length} chars)`);
    if (model) console.log(`[GeminiCLI]   Model: ${model}`);

    const gemini = await findGeminiExecutable();

    // Build args: gemini [-m model] -p "prompt"
    const args: string[] = [];
    if (model) {
      args.push('-m', model);
    }
    args.push('-p', prompt);

    // SECURITY: minimal environment; only the CLI's own key is passed (S0-Q.5)
    const childEnv = minimalChildEnv({
      NO_COLOR: '1',
      TERM: 'dumb',
      GEMINI_API_KEY: getEnvProviderApiKey('gemini') || undefined, // S1.1: via the credential authority
    });

    const startedAt = Date.now();
    try {
      let stdout: string;
      let stderr: string;

      if (process.platform === 'win32' && gemini.endsWith('.cmd')) {
        // On Windows, .cmd files need exec() (shell) — use the command name so PATH is used
        const binName = path.basename(gemini, '.cmd');
        const shellArgs = args.map(a => (a.includes(' ') ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
        const shellCmd = `${binName} ${shellArgs}`;
        ({ stdout, stderr } = await execAsync(shellCmd, {
          timeout,
          maxBuffer: 1024 * 1024 * 10,
          cwd: os.homedir(),
          env: childEnv,
        }));
      } else {
        ({ stdout, stderr } = await execFileAsync(gemini, args, {
          timeout,
          maxBuffer: 1024 * 1024 * 10,
          cwd: os.homedir(),
          env: childEnv,
        }));
      }

      // SECURITY (FU-03): stderr is never the answer, even on exit 0 (it can
      // hold the prompt, paths or tokens). Empty stdout gets a generic text.
      const answer = (stdout || '').trim();
      const output = answer || cliNoOutputText('Gemini');
      console.log(`[GeminiCLI] ✅ Response length: ${answer.length} chars, stderr length: ${(stderr || '').length} chars`);

      return {
        content: [{ type: 'text', text: output }],
        details: { model: model || 'default', promptLength: prompt.length },
      };
    } catch (err: any) {
      // SECURITY (FU-02): stderr and the message never reach the client; the
      // reply names only the exit code or signal (and a timeout note).
      const msg = cliFailureText('Gemini', err, timeout);

      // SECURITY (FU-01): stderr and the message can hold the prompt, paths or tokens.
      console.error('[GeminiCLI] ❌ Error', safeErrorFields(err, startedAt));

      // Only show install hint when the binary itself is missing (ENOENT), not for API errors
      const notFound = err.code === 'ENOENT';
      const hint = notFound
        ? '\n\nGemini CLI is not installed. Run: npm install -g @google/gemini-cli'
        : '';

      return {
        content: [{ type: 'text', text: `❌ ${msg}${hint}` }],
        error: msg,
      };
    }
  },
};
