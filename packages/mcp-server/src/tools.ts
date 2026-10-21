/**
 * The three MCP tools and the result-card rendering.
 *
 *   spawn_small_agent  { task, kind?, tools?, drawers?, max_steps?, read_dir? } -> run id (+ what was granted)
 *   get_result         { run_id, wait_seconds? }                     -> result card
 *   list_runs          { status?, limit? }                           -> runs + capacity (queue length)
 *
 * Every tool returns a short Markdown text for the model to read, the same
 * data as JSON text, and `structuredContent` (the JSON object).
 */

import { BackendError, type BackendClient } from './backend.js';

export const KINDS = ['lookup', 'summary', 'classification', 'draft', 'other'] as const;
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
