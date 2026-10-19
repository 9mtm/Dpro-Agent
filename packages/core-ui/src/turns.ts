// CHAT-REBUILD-01: the chat transcript model. Pure functions only: a saved
// message or a live run's events become a Turn; tool calls become one short
// human line ("Ran npm test", "Read config.ts"); a finished turn splits into
// its work (reasoning, tools, interim notes) and its final answer.
import type { RunEvent, WireMessage, WirePart } from './conversation-contract.js';

export type ToolCall = Readonly<{ id: string; name: string; input: string; output?: string; isError?: boolean; ms?: number; running: boolean }>;
export type Part =
  | Readonly<{ kind: 'reasoning'; text: string; startedAt?: number; endedAt?: number }>
  | Readonly<{ kind: 'text'; text: string }>
  | Readonly<{ kind: 'tools'; step: number; calls: readonly ToolCall[] }>;
export type TurnStatus = 'running' | 'complete' | 'stopped' | 'error';
export type Turn = Readonly<{
  key: string; role: 'user' | 'assistant'; content: string; parts: readonly Part[]; status: TurnStatus;
  runId: string | null; durationMs: number | null; startedAt?: number; code?: 'model_unavailable' | 'lmstudio_not_running' | 'run_interrupted' | 'subscription_org_blocked'; lastSeq: number; pending?: boolean;
  /** Client clock time of the run's start, from the first event's `at` (keeps durations right after a re-attach). */
  base?: number;
  /** CHAT-PRO-02 I: the agent that wrote this reply (absent = the conversation's agent). */
  agentId?: string;
}>;

export function userTurn(key: string, content: string, runId: string | null, pending = false): Turn {
  return Object.freeze({ key, role: 'user', content, parts: [], status: 'complete', runId, durationMs: null, lastSeq: 0, ...(pending ? { pending } : {}) });
}

export function liveTurn(runId: string, now: number, agentId?: string): Turn {
  return Object.freeze({ key: `run:${runId}`, role: 'assistant', content: '', parts: [], status: 'running', runId, durationMs: null, startedAt: now, lastSeq: 0, ...(agentId ? { agentId } : {}) });
}

function fromWirePart(p: WirePart): Part {
  if (p.kind === 'tools') return { kind: 'tools', step: p.step, calls: p.calls.map(c => ({ ...c, running: false })) };
  if (p.kind === 'reasoning') return p.ms !== undefined ? { kind: 'reasoning', text: p.text, startedAt: 0, endedAt: p.ms } : { kind: 'reasoning', text: p.text };
  return { kind: 'text', text: p.text };
}

/** A stored message as a transcript turn. */
export function fromWire(m: WireMessage): Turn {
  const parts = m.role === 'assistant' ? (m.parts?.length ? m.parts.map(fromWirePart) : m.content ? [{ kind: 'text' as const, text: m.content }] : []) : [];
  return Object.freeze({ key: m.id, role: m.role === 'user' ? 'user' : 'assistant', content: m.content, parts, status: m.status, runId: m.runId, durationMs: m.durationMs, lastSeq: 0, ...(m.code ? { code: m.code } : {}), ...(m.agentId ? { agentId: m.agentId } : {}) });
}

/** Applies one run event to the live assistant turn (events at or below lastSeq are ignored). */
export function applyEvent(turn: Turn, e: RunEvent, received: number): Turn {
  if (e.seq <= turn.lastSeq) return turn;
  // Server time when known: replayed events keep their real spacing.
  const base = turn.base ?? (e.at !== undefined ? received - e.at : undefined);
  const now = e.at !== undefined && base !== undefined ? base + e.at : received;
  if (base !== undefined && turn.base === undefined) turn = { ...turn, base, startedAt: base };
  const parts = [...turn.parts];
  const last = parts.at(-1);
  let content = turn.content;
  // Thinking ends when anything else arrives.
  const closeReasoning = () => {
    const i = parts.length - 1;
    const p = parts[i];
    if (p?.kind === 'reasoning' && p.endedAt === undefined) parts[i] = { ...p, endedAt: now };
  };
  switch (e.type) {
    case 'reasoning':
      if (last?.kind === 'reasoning' && last.endedAt === undefined) parts[parts.length - 1] = { ...last, text: last.text + e.content };
      else parts.push({ kind: 'reasoning', text: e.content, startedAt: now });
      break;
    case 'text':
      closeReasoning();
      if (last?.kind === 'text') parts[parts.length - 1] = { ...last, text: last.text + e.content };
      else parts.push({ kind: 'text', text: e.content });
      content += e.content;
      break;
    case 'tool_start': {
      closeReasoning();
      const calls = e.tools.map(t => ({ id: t.id, name: t.name, input: t.input, running: true }));
      const i = parts.findIndex(p => p.kind === 'tools' && p.step === e.step);
      if (i >= 0) { const p = parts[i] as Extract<Part, { kind: 'tools' }>; parts[i] = { ...p, calls: [...p.calls, ...calls] }; }
      else parts.push({ kind: 'tools', step: e.step, calls });
      break;
    }
    case 'tool_result': {
      const i = parts.findIndex(p => p.kind === 'tools' && p.step === e.step);
      if (i >= 0) {
        const p = parts[i] as Extract<Part, { kind: 'tools' }>;
        parts[i] = { ...p, calls: p.calls.map((c, k) => {
          const r = e.results.find(x => x.id === c.id) ?? e.results[k];
          return r ? { ...c, output: r.output, isError: r.isError, ms: r.ms, running: false } : c;
        }) };
      }
      break;
    }
    case 'end':
      closeReasoning();
      return Object.freeze({ ...turn, parts: parts.map(p => (p.kind === 'tools' ? { ...p, calls: p.calls.map(c => (c.running ? { ...c, running: false } : c)) } : p)),
        content, status: e.status, durationMs: e.ms, lastSeq: e.seq, ...(e.code ? { code: e.code } : {}) });
  }
  return Object.freeze({ ...turn, parts, content, lastSeq: e.seq });
}

/**
 * The finished turn's work (everything up to the last tool step, plus any
 * thinking) and its answer (the text after the last tool step).
 */
export function splitWork(parts: readonly Part[]): { work: Part[]; answer: Part[] } {
  const lastTools = parts.map(p => p.kind).lastIndexOf('tools');
  const work: Part[] = []; const answer: Part[] = [];
  parts.forEach((p, i) => {
    if (p.kind === 'reasoning' || i <= lastTools) work.push(p);
    else answer.push(p);
  });
  return { work, answer };
}

export const toolCount = (parts: readonly Part[]) => parts.reduce((n, p) => n + (p.kind === 'tools' ? p.calls.length : 0), 0);

function args(input: string): Record<string, unknown> {
  try { const v = JSON.parse(input); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
const first = (a: Record<string, unknown>, keys: string[]) => { for (const k of keys) if (typeof a[k] === 'string' && (a[k] as string).trim()) return (a[k] as string).trim(); return ''; };
const base = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
const oneLine = (s: string, n = 80) => { const l = s.split('\n')[0]; return l.length > n ? `${l.slice(0, n - 1)}…` : l; };

export type ToolKind = 'command' | 'read' | 'write' | 'edit' | 'search' | 'web' | 'browser' | 'memory' | 'board' | 'other';
export type ToolView = { kind: ToolKind; verb: string; target: string; command?: string; args: Record<string, unknown> };

/** How a tool call reads in the transcript; verbs change tense while it runs. */
export function toolView(call: Pick<ToolCall, 'name' | 'input' | 'running'>): ToolView {
  const a = args(call.input); const n = call.name.toLowerCase(); const live = call.running;
  const v = (now: string, done: string) => (live ? now : done);
  if (/^(exec|terminal|bash|shell|run_command|execute_code|sandbox)/.test(n)) {
    const cmd = first(a, ['command', 'cmd', 'script', 'code']);
    return { kind: 'command', verb: v('Running', 'Ran'), target: oneLine(cmd || n), command: cmd, args: a };
  }
  if (/read|cat_file|open_file|view_file/.test(n) && !/browser/.test(n)) return { kind: 'read', verb: v('Reading', 'Read'), target: base(first(a, ['path', 'file', 'file_path', 'filename'])) || n, args: a };
  if (/edit|patch|replace/.test(n)) return { kind: 'edit', verb: v('Editing', 'Edited'), target: base(first(a, ['path', 'file', 'file_path'])) || n, args: a };
  if (/write|create_file|save_file/.test(n)) return { kind: 'write', verb: v('Writing', 'Wrote'), target: base(first(a, ['path', 'file', 'file_path', 'filename'])) || n, args: a };
  if (/memory/.test(n)) return { kind: 'memory', verb: /save|store|remember|write|add/.test(n) ? v('Saving to memory', 'Saved to memory') : v('Searching memory', 'Searched memory'), target: oneLine(first(a, ['query', 'text', 'content', 'key'])), args: a };
  if (/^board_/.test(n)) return { kind: 'board', verb: v('Updating the board', 'Updated the board'), target: oneLine(first(a, ['title', 'cardId', 'text'])), args: a };
  if (/search|grep|find/.test(n)) { const q = first(a, ['query', 'q', 'pattern', 'text']); return { kind: 'search', verb: v('Searching', 'Searched'), target: q ? `“${oneLine(q, 60)}”` : n, args: a }; }
  if (/browser|navigate|screenshot|click/.test(n)) return { kind: 'browser', verb: v('Browsing', 'Browsed'), target: oneLine(first(a, ['url', 'selector', 'action']) || n), args: a };
  if (/web|url|download|http|curl|wget/.test(n) || typeof a.url === 'string') { const u = first(a, ['url', 'href', 'uri']); return { kind: 'web', verb: v('Opening', 'Opened'), target: u ? oneLine(u.replace(/^[a-z]+:\/\//i, ''), 70) : n, args: a }; }
  return { kind: 'other', verb: v('Using', 'Used'), target: n.replace(/_/g, ' '), args: a };
}

/** One line for a group of finished tool calls: "Ran 3 commands, read 2 files, searched 1 time". */
export function workSummary(parts: readonly Part[]): string {
  const counts = new Map<ToolKind, number>();
  for (const p of parts) if (p.kind === 'tools') for (const c of p.calls) { const k = toolView({ ...c, running: false }).kind; counts.set(k, (counts.get(k) ?? 0) + 1); }
  const label: Record<ToolKind, [string, string, string]> = {
    command: ['ran', 'command', 'commands'], read: ['read', 'file', 'files'], write: ['wrote', 'file', 'files'], edit: ['edited', 'file', 'files'],
    search: ['searched', 'time', 'times'], web: ['opened', 'page', 'pages'], browser: ['used the browser', 'time', 'times'],
    memory: ['used memory', 'time', 'times'], board: ['updated the board', 'time', 'times'], other: ['used', 'tool', 'tools'],
  };
  const out = [...counts].map(([k, n]) => `${label[k][0]} ${n} ${n === 1 ? label[k][1] : label[k][2]}`);
  const s = out.join(', ');
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

/** "12s", "1m 05s", "1h 02m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `${m}m ${String(r).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Files the agent wrote or edited in these turns (newest last, no duplicates). */
export function turnOutputs(turns: readonly Turn[]): { path: string; kind: 'write' | 'edit' }[] {
  const out = new Map<string, 'write' | 'edit'>();
  for (const t of turns) for (const p of t.parts) if (p.kind === 'tools') for (const c of p.calls) {
    if (c.isError || c.running) continue;
    const v = toolView({ ...c, running: false });
    if (v.kind !== 'write' && v.kind !== 'edit') continue;
    const path = ['path', 'file', 'file_path', 'filename'].map(k => v.args[k]).find(x => typeof x === 'string') as string | undefined;
    if (path) { out.delete(path); out.set(path, v.kind); }
  }
  return [...out].map(([path, kind]) => ({ path, kind }));
}

/** A rough size of the conversation in tokens (about 4 characters each). */
export function approxTokens(turns: readonly Turn[]): number {
  let chars = 0;
  for (const t of turns) { chars += t.content.length; for (const p of t.parts) if (p.kind === 'tools') for (const c of p.calls) chars += c.input.length + (c.output?.length ?? 0); }
  return Math.round(chars / 4);
}

/** The agent's live task plan (CHAT-PRO-02 H): its latest plan_steps call. */
export const PLAN_TOOL = 'plan_steps';
export type PlanStatus = 'pending' | 'active' | 'done' | 'skipped';
export type PlanStep = Readonly<{ title: string; status: PlanStatus }>;
const PLAN_STATUS: readonly string[] = ['pending', 'active', 'done', 'skipped'];

/** The newest plan in this turn (a refused call does not replace the last good plan), or null. */
export function turnPlan(parts: readonly Part[]): PlanStep[] | null {
  let plan: PlanStep[] | null = null;
  for (const p of parts) if (p.kind === 'tools') for (const c of p.calls) {
    if (c.name !== PLAN_TOOL || c.isError) continue;
    const steps = args(c.input).steps;
    if (!Array.isArray(steps) || !steps.length) continue;
    const clean = steps.slice(0, 12).filter((s): s is { title: string; status?: string } => !!s && typeof s === 'object' && typeof (s as { title?: unknown }).title === 'string' && !!(s as { title: string }).title.trim())
      .map(s => ({ title: s.title.trim().slice(0, 120), status: (PLAN_STATUS.includes(s.status ?? '') ? s.status : 'pending') as PlanStatus }));
    if (clean.length) plan = clean;
  }
  return plan;
}

/** CHAT-PRO-02 I step 2: an agent's suggestion to put the task on the board (the owner decides). */
export const SUGGEST_TOOL = 'board_suggest_card';
export type CardSuggestion = Readonly<{ title: string; description: string; agents: readonly string[]; priority: 'low' | 'normal' | 'high' | 'urgent' }>;

/** The card suggestions in this turn (successful calls only), at most 3. */
export function turnSuggestions(parts: readonly Part[]): CardSuggestion[] {
  const out: CardSuggestion[] = [];
  for (const p of parts) if (p.kind === 'tools') for (const c of p.calls) {
    if (c.name !== SUGGEST_TOOL || c.isError || c.output === undefined) continue;
    const a = args(c.input);
    const title = typeof a.title === 'string' ? a.title.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    if (!title || out.length >= 3) continue;
    out.push(Object.freeze({
      title, description: typeof a.description === 'string' ? a.description.trim().slice(0, 2000) : '',
      agents: Array.isArray(a.agents) ? a.agents.filter((x): x is string => typeof x === 'string').map(x => x.trim().replace(/^@/, '')).filter(Boolean).slice(0, 10) : [],
      priority: (['low', 'normal', 'high', 'urgent'] as const).find(x => x === a.priority) ?? 'normal',
    }));
  }
  return out;
}

/** The parts without plan updates and card suggestions: both are shown on their own, not as tool work. */
export function withoutPlan(parts: readonly Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    if (p.kind !== 'tools') { out.push(p); continue; }
    const calls = p.calls.filter(c => c.name !== PLAN_TOOL && c.name !== SUGGEST_TOOL);
    if (calls.length) out.push(calls.length === p.calls.length ? p : { ...p, calls });
  }
  return out;
}
