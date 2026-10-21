/**
 * Agent loop for the local model (CHAT-REBUILD-01).
 *
 * One chat turn on the local model: stream the reply, show its reasoning,
 * run the tools it asks for, give it the results and continue, until it
 * answers without asking for a tool (or the step limit or the client stops
 * it). Every step goes to the client as one typed SSE frame:
 *
 *   { type: 'reasoning', content }                       thinking text delta
 *   { type: 'text', content }                            answer text delta
 *   { type: 'tool_start', step, tools: [{ id, name, input }] }
 *   { type: 'tool_result', step, results: [{ id, name, output, isError, ms }] }
 *   { type: 'done', done: true, steps }                  the turn ended normally
 *
 * Errors are not handled here: the caller ends the stream with its one typed
 * error frame. Tool security (exec policy, channel policy, agent grants,
 * approvals) stays in the tools registry; this loop only calls `execute`.
 */

import type { ToolResult } from '../tools/types.js';

/** Step limit for one turn; the model is asked to continue in a new turn after it. */
export const LOCAL_MAX_STEPS = 40;
/** Tool input shown to the client (the model still gets the whole call). */
export const TOOL_INPUT_CHARS = 2000;
/** Tool output shown to the client. */
export const TOOL_OUTPUT_CHARS = 6000;
/** Tool output given back to the model per call. */
export const TOOL_OUTPUT_MODEL_CHARS = 24000;

export type LoopFrame =
  | { type: 'reasoning'; content: string }
  | { type: 'text'; content: string }
  | { type: 'tool_start'; step: number; tools: { id: string; name: string; input: string }[] }
  | { type: 'tool_result'; step: number; results: { id: string; name: string; output: string; isError: boolean; ms: number }[] }
  | { type: 'done'; done: true; steps: number };

export interface ApiTool { name: string; description: string; input_schema: unknown }

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
  images?: string[];
}

export interface OllamaLoopOptions {
  url: string;
  model: string;
  messages: OllamaMessage[];
  tools: ApiTool[];
  execute: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  write: (frame: LoopFrame) => void;
  signal: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  think?: boolean;
  maxSteps?: number;
  /** MEM-CACHE-01: model window (num_ctx) and how long the model stays loaded (keep_alive). */
  numCtx?: number;
  keepAlive?: string | number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** The registry's tool list in the local model's function format. */
export function toOllamaTools(tools: readonly ApiTool[]) {
  return tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… ${s.length - n} more characters` : s);

/** Text of a tool result for the client and the model; images become a short note. */
export function toolResultText(result: ToolResult): { text: string; isError: boolean } {
  const parts = (result.content ?? []).map((b) => (b.type === 'text' ? b.text ?? '' : '[image]'));
  const text = parts.join('\n').trim() || (result.error ? `Error: ${result.error}` : '(no output)');
  return { text, isError: !!result.error || /^Error:/.test(text) };
}

class Aborted extends Error {}

/**
 * Run the loop. Resolves with the final answer text (all text frames of the
 * last step) or rejects on a model/transport failure; resolves early with
 * `aborted: true` when the signal fires.
 */
export async function runOllamaAgentLoop(o: OllamaLoopOptions): Promise<{ steps: number; answer: string; aborted: boolean }> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const maxSteps = o.maxSteps ?? LOCAL_MAX_STEPS;
  const messages = [...o.messages];
  const tools = o.tools.length ? toOllamaTools(o.tools) : undefined;
  let step = 0;
  let answer = '';
  let callSeq = 0;
  try {
    while (true) {
      if (o.signal.aborted) throw new Aborted();
      step++;
      const { content, thinking, calls } = await streamOne();
      if (!calls.length) { answer = content; break; }
      messages.push({ role: 'assistant', content, ...(thinking ? { thinking } : {}), tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.args } })) });
      o.write({ type: 'tool_start', step, tools: calls.map((c) => ({ id: c.id, name: c.name, input: clip(JSON.stringify(c.args), TOOL_INPUT_CHARS) })) });
      const results = await Promise.all(calls.map(async (c) => {
        const started = now();
        let out: { text: string; isError: boolean };
        try { out = toolResultText(await o.execute(c.name, c.args)); }
        catch (err) { out = { text: `Error: ${err instanceof Error ? err.message : 'tool failed'}`, isError: true }; }
        return { ...c, ...out, ms: Math.max(0, now() - started) };
      }));
      if (o.signal.aborted) throw new Aborted();
      o.write({ type: 'tool_result', step, results: results.map((r) => ({ id: r.id, name: r.name, output: clip(r.text, TOOL_OUTPUT_CHARS), isError: r.isError, ms: r.ms })) });
      for (const r of results) messages.push({ role: 'tool', tool_name: r.name, content: clip(r.text, TOOL_OUTPUT_MODEL_CHARS) });
      if (step >= maxSteps) {
        const note = `\n\nI used ${maxSteps} steps on this task. Tell me to continue and I will pick up from here.`;
        o.write({ type: 'text', content: note });
        answer = note.trim();
        break;
      }
    }
  } catch (err) {
    if (err instanceof Aborted || o.signal.aborted) return { steps: step, answer, aborted: true };
    throw err;
  }
  o.write({ type: 'done', done: true, steps: step });
  return { steps: step, answer, aborted: false };

  /** One model call, streamed; returns its text, thinking and tool calls. */
  async function streamOne() {
    const res = await fetchImpl(`${o.url}/api/chat`, {
      method: 'POST',
      signal: o.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: o.model, messages, stream: true, tools,
        ...(o.think === undefined ? {} : { think: o.think }),
        ...(o.keepAlive === undefined ? {} : { keep_alive: o.keepAlive }),
        options: { ...(o.temperature === undefined ? {} : { temperature: o.temperature }), ...(o.maxTokens ? { num_predict: o.maxTokens } : {}), ...(o.numCtx ? { num_ctx: o.numCtx } : {}) },
      }),
    });
    if (!res.ok || !res.body) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      throw new ModelUnavailable(res.status);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let thinking = '';
    const calls: { id: string; name: string; args: Record<string, unknown> }[] = [];
    const line = (raw: string) => {
      const t = raw.trim();
      if (!t) return;
      let json: any;
      try { json = JSON.parse(t); } catch { return; }
      if (json.error) throw new ModelUnavailable(500);
      const m = json.message ?? {};
      if (typeof m.thinking === 'string' && m.thinking) { thinking += m.thinking; o.write({ type: 'reasoning', content: m.thinking }); }
      if (typeof m.content === 'string' && m.content) { content += m.content; o.write({ type: 'text', content: m.content }); }
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const name = tc?.function?.name;
          if (typeof name !== 'string' || !name) continue;
          let args = tc.function.arguments;
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { input: args }; } }
          calls.push({ id: `call-${++callSeq}`, name, args: args && typeof args === 'object' && !Array.isArray(args) ? args : {} });
        }
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      lines.forEach(line);
    }
    line(buffer + decoder.decode());
    return { content, thinking, calls };
  }
}

/** The local model could not be reached or refused the request (no upstream text is kept). */
export class ModelUnavailable extends Error {
  constructor(readonly status: number) { super('model unavailable'); }
}
