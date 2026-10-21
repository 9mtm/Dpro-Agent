/**
 * Embedding Service (CORE-06)
 *
 * Providers:
 *  - `ollama`: the local model `qwen3-embedding:0.6b` (1024 dims, multilingual)
 *    through Ollama at OLLAMA_URL (src/llm/ollama.ts). Loopback only: a
 *    non-loopback OLLAMA_URL is never used for embeddings. Default when the
 *    model answers.
 *  - `hash`: offline fallback. A stable hashed bag of lexical tokens
 *    (FNV-1a into 256 buckets, normalized text, see text-normalize.ts). No
 *    vocabulary of seen words is kept (CORE-07).
 *
 * Every vector carries its model id (`ollama:<model>` / `hash-v2`; rows from
 * before CORE-06 are the 100-dim `hash-v1`). Vectors of different models are
 * never compared (`similarity` returns 0 for different lengths; callers check
 * the model id). When the preferred model changes, stored vectors are
 * re-embedded lazily during search and by the explicit owner job
 * (memory/reembed.ts).
 *
 * Config: MEMORY_EMBEDDINGS = auto (default) | ollama | hash;
 *         MEMORY_EMBEDDING_MODEL (default qwen3-embedding:0.6b).
 *
 * Text is normalized (Arabic letters + Iraqi→MSA dictionary) before it is
 * embedded, for stored memories and queries alike. Search queries sent to
 * the semantic model get the retrieval instruction QUERY_INSTRUCTION
 * (Qwen3-Embedding query format; stored memories are embedded without it).
 * On the CORE-06 test set it lifted cross-language recall@3 of the raw
 * cosine from 13/20 to 16/20.
 */

import { createHash } from 'node:crypto';
import type { IEmbeddingService } from './types.js';
import { countCache } from './context/metrics.js';
import { OLLAMA_URL } from '../llm/ollama.js';
import { lexicalTokens, normalizeMemoryText } from './text-normalize.js';

export const HASH_MODEL = 'hash-v2';
export const HASH_DIMS = 256;
/** Model id of rows embedded before CORE-06 (100-dim hash, no model column). */
export const LEGACY_HASH_MODEL = 'hash-v1';
export const DEFAULT_EMBEDDING_MODEL = 'qwen3-embedding:0.6b';
/** After a failed Ollama call, retry no sooner than this. */
export const OLLAMA_RETRY_MS = 60_000;
const OLLAMA_TIMEOUT_MS = 30_000;
const MAX_BATCH = 32;
export const QUERY_INSTRUCTION =
  'Given a question in any language (Arabic, Iraqi Arabic, English or German), retrieve the stored note in any language that answers it';

export interface EmbeddingResult {
  vector: number[];
  /** Model id, e.g. `ollama:qwen3-embedding:0.6b` or `hash-v2`. */
  model: string;
  dims: number;
  /** True for a real semantic model (not the hash fallback). */
  semantic: boolean;
}

export interface EmbeddingProvider {
  readonly id: string;
  readonly semantic: boolean;
  embedMany(texts: string[]): Promise<number[][]>;
}

function fnv1a(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return magnitude === 0 ? vector : vector.map((v) => v / magnitude);
}

/** Offline hash embedding of a text (sync, deterministic). */
export function hashEmbed(text: string): number[] {
  const vector = new Array(HASH_DIMS).fill(0);
  const tokens = lexicalTokens(text);
  if (tokens.length === 0) return vector;
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  for (const [t, n] of tf) vector[fnv1a(t) % HASH_DIMS] += n / tokens.length;
  return normalize(vector);
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const m = Math.sqrt(na) * Math.sqrt(nb);
  return m === 0 ? 0 : dot / m;
}

/**
 * Model-independent word similarity of two texts (hash cosine, 0–1). Used by
 * the learning classifier (contradiction check), which needs the same scale
 * whatever embedding model is active.
 */
export function textSimilarity(a: string, b: string): number {
  return cosine(hashEmbed(a), hashEmbed(b));
}

class HashProvider implements EmbeddingProvider {
  readonly id = HASH_MODEL;
  readonly semantic = false;
  async embedMany(texts: string[]): Promise<number[][]> {
    return texts.map((t) => hashEmbed(t));
  }
}

/** True for 127.0.0.1 / ::1 / localhost URLs. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

class OllamaProvider implements EmbeddingProvider {
  readonly semantic = true;
  readonly id: string;
  constructor(readonly baseUrl: string, readonly model: string) {
    this.id = `ollama:${model}`;
  }
  async embedMany(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const input = texts.slice(i, i + MAX_BATCH);
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input }),
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Ollama embed HTTP ${res.status}`);
      const data = await res.json() as { embeddings?: unknown };
      const vectors = data?.embeddings;
      if (!Array.isArray(vectors) || vectors.length !== input.length) throw new Error('Ollama embed: bad response');
      const dims = Array.isArray(vectors[0]) ? vectors[0].length : 0;
      for (const v of vectors) {
        if (!Array.isArray(v) || v.length !== dims || dims < 8 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
          throw new Error('Ollama embed: bad vector');
        }
        out.push(v as number[]);
      }
    }
    return out;
  }
}

/** Vectors of the semantic model kept in memory (MEM-CACHE-01), most recently used last. */
export const EMBEDDING_CACHE_SIZE = 2000;

/**
 * Embedding cache by text hash + model id (MEM-CACHE-01). Keys are SHA-256
 * hashes, never the text. Only vectors of the semantic model are cached
 * (the hash fallback is cheaper than a lookup). Cleared by forget (CORE-07).
 */
export class EmbeddingCache {
  private readonly map = new Map<string, number[]>();
  constructor(private readonly size = EMBEDDING_CACHE_SIZE) {}
  static key(model: string, text: string): string {
    return createHash('sha256').update(model).update('\0').update(text).digest('hex');
  }
  get(key: string): number[] | undefined {
    const v = this.map.get(key);
    if (v) { this.map.delete(key); this.map.set(key, v); }
    return v;
  }
  set(key: string, vector: number[]): void {
    this.map.delete(key);
    this.map.set(key, vector.slice());
    while (this.map.size > this.size) this.map.delete(this.map.keys().next().value as string);
  }
  clear(): void { this.map.clear(); }
  get entries(): number { return this.map.size; }
}

export class EmbeddingService implements IEmbeddingService {
  readonly cache = new EmbeddingCache();
  private readonly hash = new HashProvider();
  private readonly preferred: EmbeddingProvider;
  private retryAt = 0;
  private warned = false;
  /** Model id of vectors produced here (weak: nothing is kept alive). */
  private readonly models = new WeakMap<number[], string>();

  constructor(options: { mode?: string; model?: string; baseUrl?: string } = {}) {
    const mode = (options.mode ?? process.env.MEMORY_EMBEDDINGS ?? 'auto').trim().toLowerCase();
    const baseUrl = (options.baseUrl ?? OLLAMA_URL).replace(/\/+$/, '');
    const model = options.model ?? (process.env.MEMORY_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL);
    if (mode === 'hash') {
      this.preferred = this.hash;
    } else if (!isLoopbackUrl(baseUrl)) {
      console.warn('[Memory] OLLAMA_URL is not a loopback address; embeddings use the offline hash model');
      this.preferred = this.hash;
    } else {
      this.preferred = new OllamaProvider(baseUrl, model);
    }
  }

  /** The model new vectors should have (stored vectors of another model get re-embedded). */
  targetModel(): string {
    return this.preferred.id;
  }

  /** Embed several texts with the preferred provider, else the hash fallback. */
  async embedManyDetailed(texts: string[]): Promise<EmbeddingResult[]> {
    const inputs = texts.map((t) => normalizeMemoryText(String(t ?? '')));
    let provider: EmbeddingProvider = this.hash;
    let vectors: number[][] | null = null;
    if (this.preferred !== this.hash && Date.now() >= this.retryAt) {
      try {
        vectors = await this.cachedEmbedMany(inputs);
        provider = this.preferred;
        this.warned = false;
      } catch (err) {
        this.retryAt = Date.now() + OLLAMA_RETRY_MS;
        if (!this.warned) {
          this.warned = true;
          console.warn(`[Memory] Embedding model ${this.preferred.id} not available (${(err as Error).message}); using ${HASH_MODEL}`);
        }
      }
    }
    if (!vectors) { vectors = await this.hash.embedMany(inputs); provider = this.hash; }
    return vectors.map((vector) => {
      this.models.set(vector, provider.id);
      return { vector, model: provider.id, dims: vector.length, semantic: provider.semantic };
    });
  }

  /** The preferred provider's vectors, reusing cached ones; only misses are sent to the model. */
  private async cachedEmbedMany(inputs: string[]): Promise<number[][]> {
    const keys = inputs.map((t) => EmbeddingCache.key(this.preferred.id, t));
    const out: Array<number[] | undefined> = keys.map((k) => this.cache.get(k)?.slice());
    const missing = [...new Set(inputs.filter((_, i) => !out[i]))];
    for (let i = 0; i < inputs.length; i++) countCache('embedding', !!out[i]);
    if (missing.length) {
      const fresh = await this.preferred.embedMany(missing);
      const byText = new Map(missing.map((t, i) => [t, fresh[i]]));
      for (const t of missing) this.cache.set(EmbeddingCache.key(this.preferred.id, t), byText.get(t)!);
      inputs.forEach((t, i) => { if (!out[i]) out[i] = byText.get(t)!.slice(); });
    }
    return out as number[][];
  }

  /**
   * Embed a search query: like embedDetailed, plus the retrieval instruction
   * for the semantic model (the hash fallback ignores it). The result is
   * compared with stored vectors of the same model; it is never stored.
   */
  async embedQuery(text: string): Promise<EmbeddingResult> {
    const norm = normalizeMemoryText(String(text ?? ''));
    if (this.preferred !== this.hash && Date.now() >= this.retryAt) {
      const [r] = await this.embedManyDetailed([`Instruct: ${QUERY_INSTRUCTION}\nQuery: ${norm}`]);
      if (r.semantic) return r;
    }
    return { vector: hashEmbed(norm), model: HASH_MODEL, dims: HASH_DIMS, semantic: false };
  }

  async embedDetailed(text: string): Promise<EmbeddingResult> {
    return (await this.embedManyDetailed([text]))[0];
  }

  /** Vector only (the model id stays known through `modelOf`). */
  async embed(text: string): Promise<number[]> {
    return (await this.embedDetailed(text)).vector;
  }

  /** Model id of a vector produced by this service in this process, if known. */
  modelOf(vector: number[] | undefined | null): string | undefined {
    return vector ? this.models.get(vector) : undefined;
  }

  /** Cosine similarity; 0 when the vectors cannot be compared (different length). */
  similarity(embedding1: number[], embedding2: number[]): number {
    return cosine(embedding1, embedding2);
  }
}

// Singleton instance
let embeddingService: EmbeddingService | null = null;

export function getEmbeddingService(): EmbeddingService {
  if (!embeddingService) {
    embeddingService = new EmbeddingService();
  }
  return embeddingService;
}

/** Drop every cached vector (forget, model change). */
export function clearEmbeddingCache(): void {
  embeddingService?.cache.clear();
}

/** Tests / config reload: next getEmbeddingService() reads the env again. */
export function resetEmbeddingService(): void {
  embeddingService = null;
}
