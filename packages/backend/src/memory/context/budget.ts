/**
 * Context budget of a chat turn (MEM-CACHE-01).
 *
 * The defaults fit the default local model (qwen3.5:9b) on a 32 GB Mac: a
 * 32K-token window (the model supports far more, RAM is the limit), of which
 * the prompt — system text, memory, summaries, kept turns and the new
 * message — may use 24K, leaving room for the reply and tool results.
 *
 *   CHAT_NUM_CTX          model window sent to Ollama (num_ctx), default 32768
 *   CHAT_CONTEXT_TOKENS   prompt budget, default 24576 (at most num_ctx)
 *   CHAT_SUMMARY_TOKENS   part of it for summaries of older turns, default 3072
 *   OLLAMA_KEEP_ALIVE     how long Ollama keeps the model (and its prompt cache)
 *                         loaded after a turn, default 30m
 *
 * Tokens are estimated from characters (3 per token: safe for Arabic and
 * English text alike); no tokenizer is loaded.
 */

const int = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export interface ContextBudget {
  numCtx: number;
  promptTokens: number;
  summaryTokens: number;
  keepAlive: string;
}

const KEEP_ALIVE = /^(-1|0|\d{1,6}(ms|s|m|h)?)$/;

export function contextBudget(env: NodeJS.ProcessEnv = process.env): ContextBudget {
  const numCtx = int(env.CHAT_NUM_CTX, 32768, 2048, 262144);
  const promptTokens = Math.min(numCtx, int(env.CHAT_CONTEXT_TOKENS, 24576, 1024, 262144));
  const summaryTokens = Math.min(Math.floor(promptTokens / 2), int(env.CHAT_SUMMARY_TOKENS, 3072, 256, 65536));
  const raw = (env.OLLAMA_KEEP_ALIVE ?? '').trim();
  return { numCtx, promptTokens, summaryTokens, keepAlive: KEEP_ALIVE.test(raw) ? raw : '30m' };
}

/** keep_alive as Ollama reads it: plain numbers are seconds, else a duration string. */
export function keepAliveValue(budget: ContextBudget = contextBudget()): string | number {
  return /^-?\d+$/.test(budget.keepAlive) ? Number(budget.keepAlive) : budget.keepAlive;
}

export const CHARS_PER_TOKEN = 3;

export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / CHARS_PER_TOKEN);
}
