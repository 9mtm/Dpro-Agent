/**
 * Local Ollama settings shared by every route that talks to Ollama.
 *
 * Defaults to the IPv4 loopback address so requests never depend on how
 * "localhost" resolves, and never leave the machine unless OLLAMA_URL says so.
 */

import { defaultOllamaUrl } from '../config/ollama-url.js';

/** F4: OLLAMA_URL, else LOCAL_MODEL_API_URL without /v1, else http://127.0.0.1:11434. */
export const OLLAMA_URL = defaultOllamaUrl();

export const DEFAULT_OLLAMA_MODEL =
  process.env.DEFAULT_MODEL || process.env.LOCAL_MODEL_NAME || 'qwen3.5:9b';

/**
 * Optional `think` flag for reasoning models (e.g. Qwen3).
 * Only sent when OLLAMA_THINK is set, because models without thinking support reject it.
 */
export function ollamaThinkOption(): { think?: boolean } {
  const value = process.env.OLLAMA_THINK?.trim().toLowerCase();
  if (value === 'true' || value === '1') return { think: true };
  if (value === 'false' || value === '0') return { think: false };
  return {};
}
