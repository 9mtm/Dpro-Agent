/**
 * Export a conversation as Markdown (CHAT-PRO-02 F).
 *
 * The caller's own conversation only (anything else is "not found"): a
 * heading with the title, the date, the project and the agent, then every
 * turn with who wrote it ("You" or the agent's name). Agent replies are
 * their text; tool calls are left out unless asked for, and then shown as a
 * collapsed summary (name, ok/error, time, a short input). Reasoning is
 * never exported. Every piece of text goes through the memory-import
 * redaction first, so tokens, keys and passwords do not leave in the file.
 * The Markdown is capped in bytes; a longer conversation keeps its first turns and
 * ends with a note.
 */

import { findConversation, findProject, listConversationMessages, type ConversationMessage, type ToolCallPart } from '../repositories/chat-conversations.js';
import { redactImportText } from '../memory/import/redact.js';
import { q } from '../repositories/sql-steps.js';

/** UTF-8 bytes the exported Markdown may have (JSON escaping at most doubles it: stays under the bridge's 4 MB answer limit). */
export const MAX_EXPORT_BYTES = 1_500_000;
/** Characters of a tool call's input shown in the summary. */
const TOOL_INPUT_CHARS = 160;
/** Tool calls listed per reply. */
const TOOLS_PER_TURN = 40;
const FILENAME_CHARS = 80;

export interface ChatExport {
  filename: string;
  markdown: string;
  /** Turns written to the file / in the conversation. */
  turns: number;
  totalTurns: number;
  truncated: boolean;
  /** Secret values replaced with [REDACTED:…]. */
  redacted: number;
}

/** A safe file name from the title: letters, digits, spaces and - _ . kept (any script), the rest dropped. */
export function exportFilename(title: string | null): string {
  const base = (title ?? '').normalize('NFC').replace(/[^\p{L}\p{N} _.-]+/gu, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  const cut = [...base].slice(0, FILENAME_CHARS).join('').trim();
  return `${cut || 'conversation'}.md`;
}

/** One line of plain text for headings and summaries (no Markdown or HTML control). */
function inline(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
}

const seconds = (ms: number | undefined | null) => (typeof ms === 'number' && ms >= 0 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : '');

function toolSummary(calls: ToolCallPart[], clean: (s: string) => string): string {
  const shown = calls.slice(0, TOOLS_PER_TURN);
  const lines = shown.map((c) => {
    const input = clean(c.input ?? '').replace(/\s+/g, ' ').trim();
    const short = [...input].length > TOOL_INPUT_CHARS ? `${[...input].slice(0, TOOL_INPUT_CHARS).join('')}…` : input;
    const state = c.isError ? 'error' : c.output === undefined ? 'no result' : 'ok';
    const time = seconds(c.ms);
    return `- \`${inline(c.name).replace(/`/g, "'")}\` — ${state}${time ? `, ${time}` : ''}${short ? `: ${inline(short)}` : ''}`;
  });
  if (calls.length > shown.length) lines.push(`- … and ${calls.length - shown.length} more`);
  return `<details>\n<summary>Tool calls (${calls.length})</summary>\n\n${lines.join('\n')}\n\n</details>`;
}

function toolCalls(m: ConversationMessage): ToolCallPart[] {
  return (m.parts ?? []).flatMap((p) => (p.kind === 'tools' && Array.isArray(p.calls) ? p.calls : []));
}

/** One turn: who wrote it and when, its text (Markdown stays Markdown), and the tool summary when asked for. */
function turnBlock(m: ConversationMessage, writer: string, tools: boolean, clean: (s: string) => string): string {
  const when = m.createdAt ? ` · ${m.createdAt.replace('T', ' ').slice(0, 16)}` : '';
  const head = `### ${inline(writer)}${when}${m.status === 'stopped' ? ' · stopped' : m.status === 'error' ? ' · error' : ''}`;
  const body = clean(m.content).trim();
  const parts = [head, ''];
  if (body) parts.push(body);
  else parts.push(m.role === 'assistant' ? '_(no text)_' : '_(empty)_');
  if (tools && m.role === 'assistant') {
    const calls = toolCalls(m);
    if (calls.length) parts.push('', toolSummary(calls, clean));
  }
  return parts.join('\n');
}

/** The caller's conversation as Markdown, or null when it is not theirs (or does not exist). */
export async function exportConversation(userId: string, conversationId: string, opts: { tools?: boolean; maxBytes?: number } = {}): Promise<ChatExport | null> {
  const c = await findConversation(userId, conversationId);
  if (!c) return null;
  const max = opts.maxBytes ?? MAX_EXPORT_BYTES;
  const project = c.projectId ? await findProject(userId, c.projectId) : undefined;
  const agents = new Map((await q.all<{ id: string; name: string | null }>('SELECT id, name FROM agents_config')).map((r) => [r.id, r.name || r.id]));
  const agentName = (id: string | null | undefined) => (id && agents.get(id)) || 'Main agent';

  let redacted = 0;
  const clean = (s: string) => { const r = redactImportText(s ?? ''); redacted += r.total; return r.text; };

  const title = inline(clean(c.title ?? '')) || 'Conversation';
  const meta = [
    `- Date: ${c.createdAt.replace('T', ' ').slice(0, 16)}${c.updatedAt && c.updatedAt !== c.createdAt ? ` (last active ${c.updatedAt.replace('T', ' ').slice(0, 16)})` : ''}`,
    project ? `- Project: ${inline(clean(project.name))}` : '',
    `- Agent: ${inline(agentName(c.agentId))}`,
  ].filter(Boolean);
  const header = `# ${title}\n\n${meta.join('\n')}\n`;

  const turns = (await listConversationMessages(c.id)).filter((m) => m.role === 'user' || m.role === 'assistant');
  const blocks: string[] = [];
  let used = Buffer.byteLength(header);
  let truncated = false;
  for (const m of turns) {
    const writer = m.role === 'user' ? 'You' : agentName(m.agentId ?? c.agentId);
    const block = `\n---\n\n${turnBlock(m, writer, !!opts.tools, clean)}\n`;
    // Room for the closing note.
    const size = Buffer.byteLength(block);
    if (used + size > max - 300) { truncated = true; break; }
    blocks.push(block);
    used += size;
  }
  const note = truncated ? `\n---\n\n_Export cut: ${blocks.length} of ${turns.length} turns fit in the size limit._\n` : '';
  const footer = `\n---\n\n_Exported from Dpro Agent${redacted ? ` · ${redacted} secret value${redacted === 1 ? ' was' : 's were'} left out` : ''}._\n`;
  return {
    filename: exportFilename(c.title),
    markdown: `${header}${blocks.join('')}${note}${footer}`,
    turns: blocks.length, totalTurns: turns.length, truncated, redacted,
  };
}
