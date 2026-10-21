/**
 * The MCP tools and the result-card rendering.
 *
 *   spawn_small_agent  { task, kind?, tools?, drawers?, max_steps?, read_dir? } -> run id (+ what was granted)
 *   get_result         { run_id, wait_seconds? }                     -> result card
 *   list_runs          { status?, limit? }                           -> runs + capacity (queue length)
 *   list_handoffs      { agent_id?, kind?, project_id?, limit? }     -> newest handoff note of every chat / board task
 *   read_handoff       { kind, scope_id, agent_id }                  -> the note + its history
 *   edit_handoff       { kind, scope_id, agent_id, done?, left?, next?, questions? } -> a new version
 *                      (source "owner"); the agent's next session starts from it
 *
 * The handoff tools use the owner-only /api/handoffs routes (CORE-MEM-HANDOFF):
 * a session that is not the owner account gets 403, like the small-agent tools.
 *
 * Every tool returns a short Markdown text for the model to read, the same
 * data as JSON text, and `structuredContent` (the JSON object).
 */

import { BackendError, type BackendClient } from './backend.js';

export const KINDS = ['lookup', 'summary', 'classification', 'draft', 'other'] as const;
export const HANDOFF_KINDS = ['conversation', 'task'] as const;
const HANDOFF_SCOPE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const AGENT_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const handoffList = (what: string) => ({ type: 'array', maxItems: 8, items: { type: 'string', maxLength: 300 }, description: `${what} (up to 8 short lines; replaces the list)` });
export const STATUSES = ['queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled'] as const;
const FINAL = new Set(['completed', 'failed', 'cancelled', 'waiting_approval']);
const RUN_ID = /^[0-9a-f-]{36}$/i;

export const TOOL_DEFINITIONS = [
  {
    name: 'spawn_small_agent',
    title: 'Delegate a light task to the small local agent',
    description: [
      'Hand ONE light, self-contained task to the Agent Player small local agent (local Qwen model; free, private, slower and less capable than you).',
      'Good for: lookups in Agent Player memory/storage, summaries of text you pass in, classification/tagging, first drafts.',
      'Not for: code changes, security decisions, anything that sends, pays, deletes, installs or runs commands (the small agent has no such tools), or tasks needing deep reasoning.',
      'Returns a run id at once; fetch the result card with get_result. Outputs marked needs_review must be checked by you before use.',
      'The small agent only gets read-only tools (memory_search, storage_search, read, memory_graph) and only the memory drawers you name; delegation never adds permissions.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', minLength: 1, maxLength: 8000, description: 'The complete task, with all text the agent needs (it cannot see your context).' },
        kind: { type: 'string', enum: [...KINDS], description: 'lookup | summary | classification are informational; draft and other always need review. Default other.' },
        tools: {
          type: 'array', maxItems: 20, items: { type: 'string' },
          description: 'Tools the agent may use; only memory_search, storage_search, read and memory_graph (people/projects/links in memory) can be granted. Default: memory_search + storage_search.',
        },
        drawers: {
          type: 'array', maxItems: 14, items: { type: 'string' },
          description: 'Memory drawers to open, e.g. "owner", "experience", "project:alpha", "task:<id>", "people:<id>". Default: none (no memory).',
        },
        max_steps: { type: 'integer', minimum: 1, maximum: 100, description: 'Step budget (model + tool calls). Default and upper limit 15.' },
        read_dir: {
          type: 'string', maxLength: 1024,
          description: 'Absolute directory the "read" tool may read (only with tools including "read"; must be inside a folder the owner allowed with SMALL_AGENT_READ_ROOTS on the backend, otherwise refused; never the Agent Player backend, data, config or credential folders; .env, keys, tokens and databases stay blocked). Default: the small agent\'s own workspace.',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_result',
    title: 'Result card of a small-agent run',
    description: 'Get the result card of a small-agent run: status, summary, outputs, steps used, duration, model, needs_review and warnings. Optionally wait up to 60 s for it to finish.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Run id returned by spawn_small_agent.' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 60, description: 'Wait up to this many seconds for the run to finish (default 0).' },
      },
      required: ['run_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_runs',
    title: 'List small-agent runs and capacity',
    description: 'List recent small-agent runs and the current capacity (active, running, queued, waiting, limit, free slots). New spawns are refused while all slots are busy.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...STATUSES] },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 20.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_handoffs',
    title: 'List agent handoff notes',
    description: 'Owner only. The newest done / left / next note of every chat and board task, per agent, newest first. Read one in full with read_handoff.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', maxLength: 128, description: 'Only this agent\'s notes.' },
        kind: { type: 'string', enum: [...HANDOFF_KINDS], description: 'conversation (a saved chat) or task (a board task).' },
        project_id: { type: 'string', maxLength: 128, description: 'Only notes of chats in this chat project.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_handoff',
    title: 'Read one handoff note and its history',
    description: 'Owner only. The current handoff note of one agent for one chat or board task, with every earlier version.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...HANDOFF_KINDS] },
        scope_id: { type: 'string', maxLength: 128, description: 'The conversation id or the board task id.' },
        agent_id: { type: 'string', maxLength: 128 },
      },
      required: ['kind', 'scope_id', 'agent_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_handoff',
    title: 'Edit a handoff note (as the owner)',
    description: 'Owner only. Save a corrected done / left / next note for one agent in one chat or board task. It is kept as a new version (the old one stays in the history) and the agent\'s next session starts from it. Lists you leave out stay as they are; never put keys, passwords or tokens in a note.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...HANDOFF_KINDS] },
        scope_id: { type: 'string', maxLength: 128 },
        agent_id: { type: 'string', maxLength: 128 },
        done: handoffList('What is finished'),
        left: handoffList('What is still open'),
        next: handoffList('The next steps'),
        questions: handoffList('Open questions for the owner'),
      },
      required: ['kind', 'scope_id', 'agent_id'],
      additionalProperties: false,
    },
  },
] as const;

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

class InputError extends Error {}

function ok(markdown: string, data: Record<string, unknown>): ToolCallResult {
  return { content: [{ type: 'text', text: markdown }, { type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function fail(message: string, data?: Record<string, unknown>): ToolCallResult {
  return { content: [{ type: 'text', text: message }], ...(data ? { structuredContent: data } : {}), isError: true };
}

function obj(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new InputError('arguments must be an object');
  return args as Record<string, unknown>;
}

function only(args: Record<string, unknown>, allowed: string[]) {
  for (const k of Object.keys(args)) if (!allowed.includes(k)) throw new InputError(`unknown argument "${k}"`);
}

function intIn(v: unknown, name: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new InputError(`${name} must be an integer from ${min} to ${max}`);
  return v;
}

function strList(v: unknown, name: string, max: number): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 200)) {
    throw new InputError(`${name} must be a list of at most ${max} names`);
  }
  return v as string[];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const ms = (n: unknown) => (typeof n === 'number' ? (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`) : '?');

export function renderCard(card: any): string {
  const lines = [
    `### Small agent: ${card.status}${card.needs_review ? ' (needs review)' : ''}`,
    '',
    `**Summary:** ${card.summary || '(none)'}`,
    '',
    `- run: \`${card.run_id}\` (${card.kind})`,
    `- model: ${card.model}`,
    `- steps: ${card.steps_used}/${card.max_steps}, time: ${ms(card.duration_ms)} of ${ms(card.max_duration_ms)}`,
    `- tools granted: ${card.tools_granted?.length ? card.tools_granted.join(', ') : 'none'}; used: ${card.tools_used?.length ? card.tools_used.join(', ') : 'none'}`,
    `- memory drawers: ${card.drawers?.length ? card.drawers.join(', ') : 'none'}`,
    ...(card.read_dir ? [`- read directory: ${card.read_dir}`] : []),
    `- needs_review: ${card.needs_review}${card.review_reason ? ` (${card.review_reason})` : ''}`,
  ];
  if (card.warnings?.length) {
    lines.push('', '**Warnings:**', ...card.warnings.map((w: string) => `- ${w}`));
  }
  if (card.outputs?.length) {
    lines.push('', '**Output:**', '', ...card.outputs.map((o: any) => String(o.text ?? '')));
  }
  if (card.needs_review) {
    lines.push('', '_Check this output before you rely on it or pass it on._');
  }
  return lines.join('\n');
}

function capacityLine(c: any): string {
  return `capacity: ${c.active}/${c.limit} active (running ${c.running}, queued ${c.queued}, waiting ${c.waiting}), ${c.available} free`;
}

function renderList(runs: any[], capacity: any): string {
  const lines = [`### Small-agent runs`, '', capacityLine(capacity), ''];
  if (!runs.length) lines.push('No runs.');
  for (const r of runs) {
    lines.push(`- \`${r.run_id}\` ${r.status} (${r.kind}), steps ${r.steps_used}/${r.max_steps}, created ${r.created_at}${r.summary ? `: ${r.summary}` : ''}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

export interface HandlerDeps { backend: BackendClient; pollMs?: number }

export async function callTool(name: string, rawArgs: unknown, deps: HandlerDeps): Promise<ToolCallResult> {
  try {
    const args = obj(rawArgs);
    switch (name) {
      case 'spawn_small_agent': return await spawn(args, deps);
      case 'get_result': return await getResult(args, deps);
      case 'list_runs': return await list(args, deps);
      case 'list_handoffs': return await listHandoffs(args, deps);
      case 'read_handoff': return await readHandoff(args, deps);
      case 'edit_handoff': return await editHandoff(args, deps);
      default: return fail(`Unknown tool "${name}"`);
    }
  } catch (err) {
    if (err instanceof InputError) return fail(`Invalid arguments: ${err.message}`);
    if (err instanceof BackendError) {
      if (err.status === 429 && err.data?.capacity) {
        return fail(`The small agent is busy (${capacityLine(err.data.capacity)}). Do the task yourself or try again after a run finishes.`, { refused: 'capacity', capacity: err.data.capacity });
      }
      return fail(err.message);
    }
    return fail('Unexpected error in the Agent Player MCP server.');
  }
}

async function spawn(args: Record<string, unknown>, { backend }: HandlerDeps): Promise<ToolCallResult> {
  only(args, ['task', 'kind', 'tools', 'drawers', 'max_steps', 'read_dir']);
  if (typeof args.task !== 'string' || !args.task.trim() || args.task.length > 8000) throw new InputError('task must be a non-empty string of at most 8000 characters');
  if (args.kind !== undefined && !(KINDS as readonly unknown[]).includes(args.kind)) throw new InputError(`kind must be one of ${KINDS.join(', ')}`);
  const body: Record<string, unknown> = { task: args.task };
  if (args.kind !== undefined) body.kind = args.kind;
  const tools = strList(args.tools, 'tools', 20);
  if (tools) body.tools = tools;
  const drawers = strList(args.drawers, 'drawers', 14);
  if (drawers) body.drawers = drawers;
  const maxSteps = intIn(args.max_steps, 'max_steps', 1, 100);
  if (maxSteps !== undefined) body.max_steps = maxSteps;
  if (args.read_dir !== undefined) {
    if (typeof args.read_dir !== 'string' || !args.read_dir.trim() || args.read_dir.length > 1024) throw new InputError('read_dir must be an absolute directory path');
    body.read_dir = args.read_dir;
  }

  const res = await backend.request('POST', '/api/small-agent/runs', body);
  const data = {
    run_id: res.run_id,
    status: res.status,
    kind: res.kind,
    granted_tools: res.granted_tools ?? [],
    drawers: res.drawers ?? [],
    read_dir: res.read_dir ?? null,
    budget: res.budget,
    model: res.model,
    warnings: res.warnings ?? [],
    capacity: res.capacity,
  };
  const md = [
    `Small agent started: run \`${data.run_id}\` (${data.kind}, model ${data.model}).`,
    `Tools: ${data.granted_tools.length ? data.granted_tools.join(', ') : 'none'}; drawers: ${data.drawers.length ? data.drawers.join(', ') : 'none'}; budget ${data.budget?.max_steps} steps / ${ms(data.budget?.max_duration_ms)}.`,
    ...(data.warnings.length ? ['Warnings:', ...data.warnings.map((w: string) => `- ${w}`)] : []),
    `Call get_result with run_id "${data.run_id}" (wait_seconds up to 60) for the result card.`,
  ].join('\n');
  return ok(md, data);
}

async function getResult(args: Record<string, unknown>, { backend, pollMs = 1000 }: HandlerDeps): Promise<ToolCallResult> {
  only(args, ['run_id', 'wait_seconds']);
  if (typeof args.run_id !== 'string' || !RUN_ID.test(args.run_id)) throw new InputError('run_id must be a run id from spawn_small_agent');
  const wait = intIn(args.wait_seconds, 'wait_seconds', 0, 60) ?? 0;
  const end = Date.now() + wait * 1000;
  let card: any;
  for (;;) {
    card = (await backend.request('GET', `/api/small-agent/runs/${encodeURIComponent(args.run_id)}`)).card;
    if (FINAL.has(card?.status) || Date.now() >= end) break;
    await sleep(Math.min(pollMs, Math.max(0, end - Date.now())));
  }
  return ok(renderCard(card), card);
}

async function list(args: Record<string, unknown>, { backend }: HandlerDeps): Promise<ToolCallResult> {
  only(args, ['status', 'limit']);
  if (args.status !== undefined && !(STATUSES as readonly unknown[]).includes(args.status)) throw new InputError(`status must be one of ${STATUSES.join(', ')}`);
  const limit = intIn(args.limit, 'limit', 1, 100);
  const q = new URLSearchParams();
  if (args.status) q.set('status', String(args.status));
  if (limit) q.set('limit', String(limit));
  const qs = q.toString();
  const res = await backend.request('GET', `/api/small-agent/runs${qs ? `?${qs}` : ''}`);
  const capacity = { ...res.capacity, queue_length: (res.capacity?.queued ?? 0) + (res.capacity?.waiting ?? 0) };
  const data = { runs: res.runs ?? [], capacity };
  return ok(renderList(data.runs, capacity), data);
}

// ---------------------------------------------------------------------------
// Handoff notes (owner only)
// ---------------------------------------------------------------------------

function handoffTarget(args: Record<string, unknown>): { kind: string; scopeId: string; agentId: string } {
  if (!(HANDOFF_KINDS as readonly unknown[]).includes(args.kind)) throw new InputError(`kind must be one of ${HANDOFF_KINDS.join(', ')}`);
  if (typeof args.scope_id !== 'string' || !HANDOFF_SCOPE.test(args.scope_id)) throw new InputError('scope_id must be a conversation or board task id');
  if (typeof args.agent_id !== 'string' || !AGENT_ID.test(args.agent_id)) throw new InputError('agent_id must be an agent id');
  return { kind: args.kind as string, scopeId: args.scope_id, agentId: args.agent_id };
}

const handoffPath = (t: { kind: string; scopeId: string }) => `/api/handoffs/${encodeURIComponent(t.kind)}/${encodeURIComponent(t.scopeId)}`;

function renderHandoff(h: any): string {
  if (!h) return 'No handoff note yet.';
  const section = (title: string, items: unknown) => (Array.isArray(items) && items.length ? [`**${title}:**`, ...items.map((i) => `- ${String(i)}`)] : []);
  return [
    `### Handoff: ${h.agentName ?? h.agentId} — ${h.kind} \`${h.scopeId}\` (version ${h.version}, ${h.source}, ${h.createdAt})`,
    ...section('Done', h.done), ...section('Left', h.left), ...section('Next', h.next), ...section('Open questions', h.questions),
  ].join('\n');
}

async function listHandoffs(args: Record<string, unknown>, { backend }: HandlerDeps): Promise<ToolCallResult> {
  only(args, ['agent_id', 'kind', 'project_id', 'limit']);
  if (args.agent_id !== undefined && (typeof args.agent_id !== 'string' || !AGENT_ID.test(args.agent_id))) throw new InputError('agent_id must be an agent id');
  if (args.project_id !== undefined && (typeof args.project_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(args.project_id))) throw new InputError('project_id must be a chat project id');
  if (args.kind !== undefined && !(HANDOFF_KINDS as readonly unknown[]).includes(args.kind)) throw new InputError(`kind must be one of ${HANDOFF_KINDS.join(', ')}`);
  const limit = intIn(args.limit, 'limit', 1, 200);
  const q = new URLSearchParams();
  if (args.agent_id) q.set('agentId', String(args.agent_id));
  if (args.kind) q.set('kind', String(args.kind));
  if (args.project_id) q.set('projectId', String(args.project_id));
  if (limit) q.set('limit', String(limit));
  const qs = q.toString();
  const res = await backend.request('GET', `/api/handoffs${qs ? `?${qs}` : ''}`);
  const handoffs = Array.isArray(res?.handoffs) ? res.handoffs : [];
  const md = handoffs.length
    ? ['### Handoff notes', '', ...handoffs.map((h: any) => `- ${h.agentName ?? h.agentId} — ${h.kind} ${h.title ? `"${h.title}" ` : ''}\`${h.scopeId}\` v${h.version} (${h.createdAt}): ${Array.isArray(h.next) && h.next.length ? `next: ${h.next[0]}` : `${(h.done ?? []).length} done, ${(h.left ?? []).length} left`}`)].join('\n')
    : 'No handoff notes yet.';
  return ok(md, { handoffs });
}

async function readHandoff(args: Record<string, unknown>, { backend }: HandlerDeps): Promise<ToolCallResult> {
  only(args, ['kind', 'scope_id', 'agent_id']);
  const t = handoffTarget(args);
  const res = await backend.request('GET', `${handoffPath(t)}?agentId=${encodeURIComponent(t.agentId)}`);
  const history = Array.isArray(res?.history) ? res.history : [];
  return ok([renderHandoff(res?.handoff ?? null), ...(history.length > 1 ? ['', `${history.length - 1} earlier version(s).`] : [])].join('\n'), { handoff: res?.handoff ?? null, history });
}

async function editHandoff(args: Record<string, unknown>, { backend }: HandlerDeps): Promise<ToolCallResult> {
  only(args, ['kind', 'scope_id', 'agent_id', 'done', 'left', 'next', 'questions']);
  const t = handoffTarget(args);
  const body: Record<string, unknown> = { agentId: t.agentId };
  for (const k of ['done', 'left', 'next', 'questions'] as const) {
    if (args[k] === undefined) continue;
    const v = args[k];
    if (!Array.isArray(v) || v.length > 8 || !v.every((x) => typeof x === 'string' && x.length <= 300)) throw new InputError(`${k} must be a list of at most 8 short lines`);
    body[k] = v;
  }
  if (Object.keys(body).length === 1) throw new InputError('give at least one of done, left, next, questions');
  // Lists left out keep their current text.
  const current = (await backend.request('GET', `${handoffPath(t)}?agentId=${encodeURIComponent(t.agentId)}`))?.handoff;
  for (const k of ['done', 'left', 'next', 'questions'] as const) if (body[k] === undefined && Array.isArray(current?.[k])) body[k] = current[k];
  const res = await backend.request('PUT', handoffPath(t), body);
  return ok(`Saved as version ${res?.handoff?.version ?? '?'}. The agent's next session starts from it.\n\n${renderHandoff(res?.handoff)}`, { handoff: res?.handoff ?? null });
}
