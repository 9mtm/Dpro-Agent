/**
 * ask_coding_app (CORE-ROUTE-01, first step): the agent hands one request to
 * the owner's signed-in Claude Code or Codex in the chat's project folder,
 * waits for the answer and continues with it.
 *
 * Locks: it is exec-class (off unless the server sets AGENT_EXEC_TOOLS=true);
 * only an agent the owner granted it may call it; every call waits for the
 * owner's approval (approvals.ts); only an owner's turn may use it, the same
 * gate as a chat sent to a coding app directly; it runs only where the desktop app
 * turned the coding apps on (subscriptionEnabled), only in the chat's
 * project folder (or the chat's own private folder), never for an outside (channel) sender. The coding app gets
 * the same restricted flags as a chat sent to it directly (subscription-chat.ts).
 */
import type { Tool, ToolResult } from '../types.js';
import { chatWorkspace, runSubscription, subscriptionEnabled } from '../../services/subscription-chat.js';
import { one, sql } from '../../repositories/sql-steps.js';

const APPS = { claude: 'Claude Code', codex: 'Codex' } as const;
export const MAX_CODING_REQUEST_CHARS = 20_000;
const MAX_ANSWER_CHARS = 60_000;

const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], error: text });

const PREFIX = 'Work only inside the selected project directory. Do not access credentials, .env, .data, private keys or unrelated files. No git commit, push or publication. Request from the owner\'s assistant:\n';

export const askCodingAppTool: Tool = {
  name: 'ask_coding_app',
  execClass: true,
  description: 'Ask the owner\'s signed-in Claude Code or Codex to do or answer something in the current project folder, wait for its answer, then use it in your reply. Use it for coding work, reviewing code or questions that need a stronger model; answer simple things yourself. Write a complete, self-contained request (it does not see this conversation). The owner approves each call.',
  input_schema: {
    type: 'object',
    properties: {
      app: { type: 'string', enum: Object.keys(APPS), description: 'claude = Claude Code, codex = Codex (ChatGPT)' },
      request: { type: 'string', description: `The full request for the coding app (up to ${MAX_CODING_REQUEST_CHARS} characters)` },
    },
    required: ['app', 'request'],
  },
  async execute(params, context): Promise<ToolResult> {
    if (params.app !== 'claude' && params.app !== 'codex') return fail('app must be "claude" or "codex".');
    const app: keyof typeof APPS = params.app;
    const request = typeof params.request === 'string' ? params.request.trim() : '';
    if (!request) return fail('request is empty.');
    if (request.length > MAX_CODING_REQUEST_CHARS) return fail(`request is longer than ${MAX_CODING_REQUEST_CHARS} characters.`);
    if (context?.toolPolicy) return fail('Coding apps are not available for outside senders.');
    if (!subscriptionEnabled()) return fail('Claude Code and Codex are available only in the Dpro desktop app.');
    const caller = context?.userId ? await sql().read(one<{ role: string }>('SELECT role FROM users WHERE id=?', context.userId)) : null;
    if (caller?.role !== 'owner') return fail('Only the owner\'s own chats may use the coding apps.');
    let folder = context?.fileReadRoot;
    try {
      // Without a project folder the coding app works in this chat's private folder (CORE-PICKER-03).
      folder ??= context?.sessionId ? await chatWorkspace(context.sessionId) : undefined;
      if (!folder) return fail('Choose a project folder for this chat first; the coding app works only inside it.');
      const answer = await runSubscription(`subscription:${app}`, folder, PREFIX + request, AbortSignal.timeout(240_000));
      const text = answer.length > MAX_ANSWER_CHARS ? `${answer.slice(0, MAX_ANSWER_CHARS)}\n[answer shortened]` : answer;
      return { content: [{ type: 'text', text: `${APPS[app]} answered:\n${text}` }], details: { app } };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'cli_failed';
      const why = code === 'cli_missing' ? `${APPS[app]} is not installed on this computer.`
        : code === 'subscription_org_blocked' ? `${APPS[app]} refused this account for automated use.`
        : code === 'project_required' ? 'The project folder is not allowed (home or root folder).'
        : `${APPS[app]} did not answer (${code}).`;
      return fail(why);
    }
  },
};
