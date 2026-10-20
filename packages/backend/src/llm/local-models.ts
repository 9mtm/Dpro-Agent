/**
 * Local Ollama models that can chat (CORE-MODEL-01).
 *
 * Ollama lists every installed model, including embedding models that cannot
 * answer a chat. A chat model is one whose `/api/show` capabilities include
 * `completion`; when that call fails, a name containing "embed" is treated as
 * an embedding model. Results are cached per model digest.
 *
 * `resolveLocalModel` keeps a wanted model when it is installed and otherwise
 * picks an installed chat model, so an agent that still names a deleted model
 * keeps answering. When Ollama cannot be asked, the wanted name is returned
 * unchanged and the normal "not installed" / "unreachable" errors apply.
 */

import { OLLAMA_URL } from './ollama.js';

export interface LocalModelInfo {
  name: string;
  size: number;
  modifiedAt?: string;
  digest?: string;
  details?: Record<string, unknown>;
  capabilities: string[];
  chat: boolean;
}

interface TagsResponse {
  models?: Array<{ name: string; size: number; modified_at?: string; digest?: string; details?: Record<string, unknown> }>;
}

const capabilityCache = new Map<string, string[] | null>();
let listCache: { at: number; models: LocalModelInfo[] } | null = null;
const LIST_TTL_MS = 5_000;

async function capabilitiesOf(name: string, digest: string | undefined): Promise<string[] | null> {
  const key = `${name}@${digest ?? ''}`;
  if (capabilityCache.has(key)) return capabilityCache.get(key)!;
  let caps: string[] | null = null;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name }),
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const body = await res.json() as { capabilities?: unknown };
      if (Array.isArray(body.capabilities)) caps = body.capabilities.filter((c): c is string => typeof c === 'string');
    }
  } catch {
    caps = null;
  }
  // Only a real answer is cached; a failed call is asked again next time.
  if (caps) capabilityCache.set(key, caps);
  return caps;
}

/** True when the model can answer a chat. */
export function isChatModel(name: string, capabilities: string[] | null): boolean {
  if (capabilities) return capabilities.includes('completion');
  return !/embed/i.test(name);
}

/** Installed Ollama models with their chat capability; [] when Ollama does not answer. */
export async function listLocalModels(): Promise<LocalModelInfo[]> {
  if (listCache && Date.now() - listCache.at < LIST_TTL_MS) return listCache.models;
  const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`ollama tags ${res.status}`);
  const data = await res.json() as TagsResponse;
  const models = await Promise.all((data.models ?? []).map(async (m) => {
    const caps = await capabilitiesOf(m.name, m.digest);
    return {
      name: m.name,
      size: m.size,
      modifiedAt: m.modified_at,
      digest: m.digest,
      details: m.details,
      capabilities: caps ?? [],
      chat: isChatModel(m.name, caps),
    };
  }));
  listCache = { at: Date.now(), models };
  return models;
}

/** Drop the cached model list (tests, or after a model is installed). */
export function clearLocalModelCache(): void {
  listCache = null;
  capabilityCache.clear();
}

/**
 * The installed name for `wanted`: the exact name, or the same model with a
 * longer tag (`qwen3.5:9b` → `qwen3.5:9b-q4_K_M`); `latest` is implied when no
 * tag is given. Null when none matches.
 */
export function matchInstalled(wanted: string, installed: string[]): string | null {
  const full = wanted.includes(':') ? wanted : `${wanted}:latest`;
  if (installed.includes(full)) return full;
  if (installed.includes(wanted)) return wanted;
  return installed.find((name) => name.startsWith(`${full}-`)) ?? null;
}

/**
 * The local model a turn should use. Keeps `wanted` when it is installed;
 * otherwise prefers `fallback` (the default model), then the first installed
 * chat model. Returns `wanted` unchanged when Ollama cannot be asked or has
 * no chat model, so the caller reports the usual error.
 */
export async function resolveLocalModel(wanted: string, fallback?: string): Promise<string> {
  let chatNames: string[];
  try {
    chatNames = (await listLocalModels()).filter((m) => m.chat).map((m) => m.name);
  } catch {
    return wanted;
  }
  if (!chatNames.length) return wanted;
  return matchInstalled(wanted, chatNames)
    ?? (fallback ? matchInstalled(fallback, chatNames) : null)
    ?? chatNames[0];
}
