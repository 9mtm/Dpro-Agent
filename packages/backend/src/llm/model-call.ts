/**
 * One choke point for model calls made without a user present (R2.2,
 * D-BUDGET, D-HYBRID).
 *
 *  - `modelCall(ctx, req)`: text completion for a background purpose
 *    (memory extraction, weekly-summary rewrite, cron heartbeat, ...).
 *    Background purposes use the free local Ollama model by default. A paid
 *    model provider is used only when the caller passes one (`req.paid`) AND
 *    the owner opted that purpose in with BACKGROUND_PAID_PURPOSES (comma
 *    list, default empty). Even then the call first reserves its worst case
 *    through the cost budget gate (`services/cost-budget.ts`); a refusal
 *    (daily cap, default 0) falls back to the local model and is reported
 *    in `result.refused`. Usage is recorded.
 *  - `gatedModelCall(meta, fn)`: the gate for callers that drive their own
 *    client (task-run steps with tools): reserve -> call -> record / release.
 *    Throws CostBudgetError when refused.
 *  - Interactive owner chat (`ctx.interactive`) is never gated (R1 decision)
 *    but its paid usage is recorded (`recordInteractiveUsage`) so
 *    GET /api/budget can show it next to the autonomous spend.
 *
 * Public rooms (`public_room`) and the world generator (`world_generator`)
 * are not owner chat: they take the background path too (R2.3), so a
 * visitor can never spend on a paid provider unless the owner opted that
 * purpose in AND the daily cap allows it.
 *
 * Nothing outside this file (and the provider client itself) may call a
 * paid model provider from a background path; test/model-call.test.mjs
 * checks that with a grep allow-list.
 */

import { ClaudeClient } from './claude-client.js';
import { DEFAULT_OLLAMA_MODEL, OLLAMA_URL, ollamaThinkOption } from './ollama.js';
import { resolveLocalModel } from './local-models.js';
import { run, sql } from '../repositories/sql-steps.js';
import {
  CostBudgetError,
  costCents,
  priceFor,
  recordPaidCall,
  releasePaidCall,
  reservePaidCall,
  utcDay,
  type PaidCallRequest,
  type PaidCallTicket,
  type RecordedUsage,
  type Usage,
} from '../services/cost-budget.js';

export type ModelPurpose = 'memory_extraction' | 'weekly_summary' | 'heartbeat' | 'task_run' | 'interactive_chat' | string;

export interface ModelCallContext {
  /** Who triggered the call (user/agent id), for logs only. */
  actor?: string | null;
  /** True only for chat with the owner present (never gated). */
  interactive?: boolean;
}

export interface PaidProviderConfig {
  provider: 'claude';
  model: string;
  apiKey: string;
}

export interface ModelCallRequest {
  purpose: ModelPurpose;
  prompt: string;
  /** A whole conversation instead of `prompt` (public rooms, R2.3). */
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** A paid model provider the caller has configured for this purpose (used only when allowed, see header). */
  paid?: PaidProviderConfig | null;
  /** Local model override (default DEFAULT_OLLAMA_MODEL). */
  localModel?: string;
  /** Skip the local fallback (the caller has its own deterministic fallback). */
  noLocal?: boolean;
}

export interface ModelCallResult {
  ok: boolean;
  text: string;
  provider: string;
  model: string;
  paid: boolean;
  usage: { inputTokens: number; outputTokens: number } | null;
  costCents: number;
  /** Why a configured paid provider was not used (budget refusal), if so. */
  refused?: string;
  error?: string;
}

/** Purposes the owner allows to use a paid model provider in the background. */
export function backgroundPaidPurposes(): Set<string> {
  return new Set(String(process.env.BACKGROUND_PAID_PURPOSES || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/** Which provider a background purpose would use (before the budget check). */
export function backgroundRoute(purpose: string, paid?: PaidProviderConfig | null): 'paid' | 'local' {
  return paid && backgroundPaidPurposes().has(String(purpose).toLowerCase()) ? 'paid' : 'local';
}

const PAID_HOSTS = ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com', 'api.mistral.ai', 'api.groq.com', 'openrouter.ai', 'api.deepseek.com', 'api.x.ai'];

/** True for the API host of a known paid model provider. */
export function isPaidProviderUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return PAID_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * Budget gate around a model call the caller drives itself. Free providers
 * pass without a reservation. Throws CostBudgetError when refused.
 */
export async function gatedModelCall<T extends { usage?: Usage | null; content?: string | null }>(
  meta: PaidCallRequest,
  call: () => Promise<T>,
): Promise<{ response: T; used: RecordedUsage; ticket: PaidCallTicket }> {
  const ticket = await reservePaidCall(meta);
  let response: T;
  try {
    response = await call();
  } catch (err) {
    await releasePaidCall(ticket);
    throw err;
  }
  const used = await recordPaidCall(ticket, response?.usage, response?.content ?? '');
  return { response, used, ticket };
}

/** Model call for a background (or interactive) purpose; never throws. */
export async function modelCall(ctx: ModelCallContext, req: ModelCallRequest): Promise<ModelCallResult> {
  const maxOutputTokens = Math.max(1, req.maxOutputTokens ?? 1024);
  let refused: string | undefined;

  if (req.paid && (ctx.interactive || backgroundRoute(req.purpose, req.paid) === 'paid')) {
    const paid = req.paid;
    const client = new ClaudeClient(paid.apiKey, paid.model);
    const send = () => client.sendMessage(req.messages?.length ? req.messages : [{ role: 'user', content: req.prompt }], {
      ...(req.system ? { systemPrompt: req.system } : {}),
      maxTokens: maxOutputTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.timeoutMs ? { timeoutMs: req.timeoutMs } : {}),
    });
    if (ctx.interactive) {
      try {
        const r = await send();
        const used = await recordInteractiveUsage({ provider: paid.provider, model: paid.model, usage: r.usage, outputText: r.content, purpose: req.purpose });
        return { ok: true, text: r.content ?? '', provider: paid.provider, model: paid.model, paid: true, usage: { inputTokens: used.inputTokens, outputTokens: used.outputTokens }, costCents: used.costCents };
      } catch (err) {
        return { ok: false, text: '', provider: paid.provider, model: paid.model, paid: true, usage: null, costCents: 0, error: (err as Error).message };
      }
    }
    try {
      const { response, used } = await gatedModelCall({
        provider: paid.provider,
        model: paid.model,
        payload: { prompt: req.messages?.length ? req.messages : req.prompt, system: req.system ?? '' },
        maxOutputTokens,
        purpose: req.purpose,
      }, send);
      return { ok: true, text: response.content ?? '', provider: paid.provider, model: paid.model, paid: true, usage: { inputTokens: used.inputTokens, outputTokens: used.outputTokens }, costCents: used.costCents };
    } catch (err) {
      if (!(err instanceof CostBudgetError)) {
        return { ok: false, text: '', provider: paid.provider, model: paid.model, paid: true, usage: null, costCents: 0, error: (err as Error).message };
      }
      refused = err.message;
      console.log(`[ModelCall] ${req.purpose}: paid model provider refused (${err.message}); using the local model`);
    }
  }

  // CORE-MODEL-01: a model that is not installed is replaced by an installed chat model.
  const model = req.noLocal
    ? req.localModel || DEFAULT_OLLAMA_MODEL
    : await resolveLocalModel(req.localModel || DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_MODEL);
  if (req.noLocal) {
    return { ok: false, text: '', provider: 'ollama', model, paid: false, usage: null, costCents: 0, ...(refused ? { refused } : {}), error: 'local model skipped' };
  }
  const chat = !!req.messages?.length;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/${chat ? 'chat' : 'generate'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        ...(chat
          ? { messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages!] }
          : { prompt: req.prompt, ...(req.system ? { system: req.system } : {}) }),
        stream: false,
        ...ollamaThinkOption(),
        ...(req.temperature !== undefined ? { options: { temperature: req.temperature } } : {}),
      }),
      signal: AbortSignal.timeout(req.timeoutMs ?? 120_000),
    });
    if (!res.ok) {
      return { ok: false, text: '', provider: 'ollama', model, paid: false, usage: null, costCents: 0, ...(refused ? { refused } : {}), error: `local model HTTP ${res.status}` };
    }
    const data = await res.json() as { response?: string; message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
    const text = chat ? data.message?.content : data.response;
    const usage = Number.isFinite(data.prompt_eval_count) && Number.isFinite(data.eval_count)
      ? { inputTokens: Number(data.prompt_eval_count), outputTokens: Number(data.eval_count) } : null;
    return { ok: true, text: typeof text === 'string' ? text : '', provider: 'ollama', model, paid: false, usage, costCents: 0, ...(refused ? { refused } : {}) };
  } catch (err) {
    return { ok: false, text: '', provider: 'ollama', model, paid: false, usage: null, costCents: 0, ...(refused ? { refused } : {}), error: (err as Error).message };
  }
}

/**
 * Record the usage of an interactive (owner present) paid model call. Not
 * part of the autonomous daily cap; shown separately by GET /api/budget.
 * Free providers are not recorded. Never throws.
 */
export async function recordInteractiveUsage(input: {
  provider: string; model?: string | null; usage?: Usage | null; outputText?: string | null; inputEstimate?: unknown; purpose?: string;
}): Promise<RecordedUsage> {
  const price = priceFor(input.provider, input.model);
  const fromProvider = !!input.usage && Number.isFinite(input.usage.inputTokens) && Number.isFinite(input.usage.outputTokens);
  const inputTokens = fromProvider ? Number(input.usage!.inputTokens) : 0;
  const outputTokens = fromProvider ? Number(input.usage!.outputTokens) : Math.ceil(String(input.outputText ?? '').length / 3);
  const cost = costCents(price, inputTokens, outputTokens);
  const out: RecordedUsage = { inputTokens, outputTokens, costCents: cost, source: fromProvider ? 'provider' : 'estimate' };
  if (price.input <= 0 && price.output <= 0) return out;
  try {
    await sql().read(run(`
      INSERT INTO interactive_usage (day, provider, model, purpose, cost_cents, input_tokens, output_tokens, usage_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, utcDay(), String(input.provider).toLowerCase() === 'anthropic' ? 'claude' : String(input.provider).toLowerCase(), input.model ?? null,
      input.purpose || 'interactive_chat', cost, inputTokens, outputTokens, out.source));
  } catch (err) {
    console.warn('[ModelCall] could not record interactive usage:', (err as Error).message);
  }
  return out;
}
