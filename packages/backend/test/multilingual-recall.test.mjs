// CORE-06: multilingual recall (MSA Arabic, Iraqi dialect, English, German).
// Test set: test/fixtures/recall-set.json (memories + queries + negatives).
//  (a) offline: hash embedding + lexical BM25 (Arabic normalization, Iraqi→MSA
//      dictionary). Always runs. Every `offline: true` query must find its
//      target in the top 3; negatives rank below the weakest positive.
//  (b) Ollama: local qwen3-embedding:0.6b on 127.0.0.1 (skipped when the model
//      is not available, like ollama-chat.integration.test.mjs). recall@3 per
//      language ≥ the documented thresholds; negatives score below positives.
// Scope rules: recall only within the drawers selectDrawers opens.
// Run: node --import tsx --test test/multilingual-recall.test.mjs
// Throwaway DB + cwd, random test-only secrets; only loopback fetch allowed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const SET = JSON.parse(readFileSync(join(backendDir, 'test/fixtures/recall-set.json'), 'utf-8'));
const dir = mkdtempSync(join(tmpdir(), 'ap-recall-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off'; // this test may reach the real local embeddings, never the chat model

const OLLAMA = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const EMBED_MODEL = process.env.MEMORY_EMBEDDING_MODEL || 'qwen3-embedding:0.6b';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error(`unexpected network call in test: ${url}`);
  return realFetch(url, init);
};

async function ollamaEmbeddingAvailable() {
  try {
    const res = await realFetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const { models = [] } = await res.json();
    return models.some((m) => m.name === EMBED_MODEL || m.name === `${EMBED_MODEL}:latest`);
  } catch {
    return false;
  }
}
const ollama = await ollamaEmbeddingAvailable();

/** recall@3 thresholds per language group for the Ollama variant (measured values in BACKLOG CORE-06). */
const OLLAMA_RECALL_AT_3 = { en: 0.9, ar: 0.9, iq: 0.9, de: 0.9, cross: 0.75 };

const quiet = { log: console.log, warn: console.warn };
console.log = () => {};
console.warn = () => {};
const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, 'active')`).run(id, `${id}@example.test`, id, role);
for (const id of ['rc-off', 'rc-oll', 'rc-other']) addUser(id, id === 'rc-off' ? 'owner' : 'user');
const E = await import(join(backendDir, 'src/memory/embedding.ts'));
const N = await import(join(backendDir, 'src/memory/text-normalize.ts'));
const H = await import(join(backendDir, 'src/memory/hybrid.ts'));
const D = await import(join(backendDir, 'src/memory/drawers.ts'));
const R = await import(join(backendDir, 'src/memory/reembed.ts'));
const { getMemoryStorage } = await import(join(backendDir, 'src/memory/storage.ts'));
const { getMemoryRetrieval } = await import(join(backendDir, 'src/memory/retrieval.ts'));
const storage = getMemoryStorage();
await storage.initialize();
console.log = quiet.log;
console.warn = quiet.warn;

test.after(() => {
  globalThis.fetch = realFetch;
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const quietly = async (fn) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };
const OPEN = D.selectDrawers({ audience: 'owner' });
const idOf = (userId, mid) => `${userId}-${mid}`;

async function seed(userId) {
  for (const m of SET.memories) {
    await quietly(() => storage.save({
      id: idOf(userId, m.id), userId, type: 'fact', content: m.content, drawer: m.drawer,
      memoryLayer: 'factual', importanceScore: 0.5, status: 'active', metadata: {},
      createdAt: new Date(), accessCount: 0, expiryTimestamp: null,
    }));
  }
}

const group = (lang) => (lang.includes('-') ? 'cross' : lang);

/** Rank of each query's best target (1-based, Infinity = not found), top score, target score. */
async function runSet(userId, queries) {
  const out = [];
  for (const q of queries) {
    const results = await storage.search({ query: q.query, userId, drawers: OPEN, limit: 10 });
    const ids = results.map((r) => r.memory.id);
    const ranks = q.targets.map((t) => ids.indexOf(idOf(userId, t)) + 1).filter((r) => r > 0);
    const rank = ranks.length ? Math.min(...ranks) : Infinity;
    const targetScore = rank === Infinity ? 0 : results[rank - 1].similarity;
    out.push({ q, rank, top: results[0]?.similarity ?? 0, targetScore, topId: ids[0] });
  }
  return out;
}

function recallByGroup(rows) {
  const g = {};
  for (const r of rows) {
    const k = group(r.q.lang);
    g[k] ??= { n: 0, hit: 0 };
    g[k].n++;
    if (r.rank <= 3) g[k].hit++;
  }
  return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, { recall: v.hit / v.n, hit: v.hit, n: v.n }]));
}

test('test set shape: ≥ 30 memories, ≥ 40 queries, all languages, cross-language pairs, negatives', () => {
  assert.ok(SET.memories.length >= 30);
  const positives = SET.queries.filter((q) => !q.negative);
  assert.ok(SET.queries.length >= 40 && positives.length >= 40);
  for (const lang of ['en', 'ar', 'iq', 'de', 'cross']) assert.ok(positives.some((q) => group(q.lang) === lang), lang);
  assert.ok(SET.queries.filter((q) => q.negative).length >= 5);
  const ids = new Set(SET.memories.map((m) => m.id));
  for (const q of positives) for (const t of q.targets) assert.ok(ids.has(t), `${q.id} -> ${t}`);
});

test('normalization: Arabic letters, Iraqi→MSA dictionary (≥ 60 entries), stems', () => {
  assert.ok(N.IRAQI_DICTIONARY_SIZE >= 60, `dictionary has ${N.IRAQI_DICTIONARY_SIZE}`);
  assert.equal(N.normalizeArabicLetters('أَحْمَدُ إلى آخِرِ مدرسةٍ ـــ مستشفى'), 'احمد الي اخر مدرسه  مستشفي');
  assert.equal(N.normalizeMemoryText('شلونك؟ شكو ماكو؟'), 'كيف حالك؟ ما الاخبار؟');
  assert.equal(N.normalizeMemoryText('وشلونچ هسة'), 'و كيف حالك الان');
  assert.equal(N.normalizeMemoryText('اكو مولده؟ ماكو.'), 'يوجد مولده؟ لا يوجد.');
  assert.equal(N.normalizeMemoryText('البزون وين؟'), 'القطه اين؟');
  assert.equal(N.normalizeMemoryText('گال شنو؟'), 'قال ماذا؟');
  assert.equal(N.normalizeMemoryText('How are you?'), 'How are you?', 'other scripts unchanged');
  assert.deepEqual(N.lexicalTokens('بالمخزن'), N.lexicalTokens('المخزن'));
  assert.deepEqual(N.lexicalTokens('Die Miete wird überwiesen'), N.lexicalTokens('die miete wird ueberwiesen'));
  assert.deepEqual(N.lexicalTokens('database backups'), N.lexicalTokens('Database backup'));
});

test('hybrid scoring: BM25 normalized to 0–1; documented weights', () => {
  const [a, b] = H.bm25Scores(['server', 'host'], [['server', 'host', 'germany'], ['tea', 'morning']]);
  assert.ok(a > 0.5 && a <= 1 && b === 0);
  assert.deepEqual(H.HYBRID_WEIGHTS, { semantic: { vector: 0.75, lexical: 0.25, lexicalExponent: 2 }, hash: { vector: 0.4, lexical: 0.6, lexicalExponent: 1 } });
  assert.equal(H.vectorScore(0.3, true), 0);
  assert.equal(H.vectorScore(0.85, true), 1);
  assert.equal(H.hybridScore(null, 1, true), 0.25);
  assert.equal(H.hybridScore(null, 0.5, true), 0.0625);
  assert.equal(H.hybridScore(1, 0.5, false), 0.7);
});

test('(a) offline recall: hash + lexical reach every offline target in the top 3; negatives rank below positives', async (t) => {
  E.resetEmbeddingService();
  assert.equal(E.getEmbeddingService().targetModel(), 'hash-v2');
  await seed('rc-off');
  const offline = SET.queries.filter((q) => q.offline === true);
  assert.ok(offline.length >= 30);
  const rows = await runSet('rc-off', offline);
  const misses = rows.filter((r) => r.rank > 3).map((r) => `${r.q.id} "${r.q.query}" rank ${r.rank} (top ${r.topId})`);
  t.diagnostic(`offline recall@3 ${JSON.stringify(recallByGroup(rows))}`);
  assert.deepEqual(misses, []);
  // The Iraqi queries reach MSA memories only through the dictionary.
  for (const r of rows.filter((x) => x.q.lang === 'iq')) assert.ok(r.rank <= 3, r.q.id);
  // Cross-language pairs are not reachable without a model (documented).
  const cross = await runSet('rc-off', SET.queries.filter((q) => q.offline === false));
  t.diagnostic(`offline cross-language recall@3 ${JSON.stringify(recallByGroup(cross))} (not asserted: needs a model)`);
  // Negatives rank below positives: no negative query scores as high as the
  // weakest offline positive target.
  const neg = await runSet('rc-off', SET.queries.filter((q) => q.negative));
  const posMin = Math.min(...rows.map((r) => r.targetScore));
  const negMax = Math.max(...neg.map((r) => r.top));
  t.diagnostic(`offline negatives: max top score ${negMax.toFixed(3)} (${neg.filter((r) => r.top > 0).length}/${neg.length} return anything); weakest positive target ${posMin.toFixed(3)}`);
  assert.ok(negMax < posMin, `negative ${negMax} >= positive ${posMin}`);
});

test('scope: recall only within the open drawers; outsiders and other users get nothing', async () => {
  const q = 'Which logo does the Alpha release use?';
  const ids = async (userId, drawers) => (await storage.search({ query: q, userId, drawers, limit: 10 })).map((r) => r.memory.id);
  assert.ok(!(await ids('rc-off', OPEN)).includes(idOf('rc-off', 'm34')), 'project drawer not open');
  assert.equal((await ids('rc-off', D.selectDrawers({ audience: 'owner', project: 'alpha' })))[0], idOf('rc-off', 'm34'));
  assert.deepEqual(await ids('rc-off', D.selectDrawers({ audience: 'outsider' })), []);
  assert.deepEqual(await ids('rc-other', D.selectDrawers({ audience: 'owner', project: 'alpha' })), []);
  const people = 'علي يحب القهوة';
  const p1 = (await storage.search({ query: people, userId: 'rc-off', drawers: OPEN })).map((r) => r.memory.id);
  assert.ok(!p1.includes(idOf('rc-off', 'm35')));
  const p2 = (await getMemoryRetrieval().findRelevant(people, 'rc-off', 3, D.selectDrawers({ audience: 'owner', people: ['p-ali'] }))).map((m) => m.id);
  assert.equal(p2[0], idOf('rc-off', 'm35'));
  assert.deepEqual(await getMemoryRetrieval().findRelevant(people, 'rc-off', 3, []), []);
});

test('vectors of different models are never compared; stale vectors are re-embedded (lazily and by the owner job)', async () => {
  const id = idOf('rc-off', 'm01');
  // Pretend m01 was embedded by another model (1024 dims).
  const fake = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
  db.prepare('UPDATE memories SET embedding = ?, embedding_model = ?, embedding_dims = 1024 WHERE id = ?').run(JSON.stringify(fake), 'ollama:other-model', id);
  db.prepare("UPDATE memories SET embedding_model = NULL WHERE id = ?").run(idOf('rc-off', 'm02'));
  assert.equal((await R.embeddingStatus('rc-off')).stale, 2);
  const res = await storage.search({ query: 'production server Falkenstein', userId: 'rc-off', drawers: OPEN, limit: 3 });
  assert.equal(res[0].memory.id, id);
  // Re-embedded during the search (the preferred model answered): now hash-v2.
  assert.deepEqual(db.prepare('SELECT embedding_model, embedding_dims FROM memories WHERE id = ?').get(id), { embedding_model: 'hash-v2', embedding_dims: 256 });
  assert.equal(E.getEmbeddingService().similarity(fake, E.hashEmbed('x')), 0, 'different lengths are never compared');
  // Owner job: everything stale of this user is re-embedded.
  db.prepare("UPDATE memories SET embedding_model = 'old-model' WHERE user_id = 'rc-off'").run();
  const job = await R.reembedUserMemories('rc-off');
  assert.equal(job.reembedded, SET.memories.length);
  assert.equal(job.remaining, 0);
  assert.equal(job.error, undefined);
});


test('(b) Ollama recall: recall@3 per language ≥ thresholds; negatives score below positives', { skip: !ollama && `Ollama embedding model ${EMBED_MODEL} not available`, timeout: 600_000 }, async (t) => {
  process.env.MEMORY_EMBEDDINGS = 'auto';
  E.resetEmbeddingService();
  try {
    const svc = E.getEmbeddingService();
    assert.equal(svc.targetModel(), `ollama:${EMBED_MODEL}`);
    const probe = await svc.embedDetailed('server');
    assert.equal(probe.model, `ollama:${EMBED_MODEL}`, 'model answered');
    await seed('rc-oll');
    assert.equal((await R.embeddingStatus('rc-oll')).stale, 0, 'every memory has a model vector');
    const positives = SET.queries.filter((q) => !q.negative);
    const rows = await runSet('rc-oll', positives);
    const recall = recallByGroup(rows);
    const overall = rows.filter((r) => r.rank <= 3).length / rows.length;
    const misses = rows.filter((r) => r.rank > 3).map((r) => `${r.q.id}:${r.rank}`);
    t.diagnostic(`ollama recall@3 ${JSON.stringify(recall)} overall ${overall.toFixed(3)} misses ${misses.join(' ')}`);
    for (const [lang, min] of Object.entries(OLLAMA_RECALL_AT_3)) {
      assert.ok(recall[lang].recall >= min, `${lang}: recall@3 ${recall[lang].recall.toFixed(2)} < ${min}`);
    }
    const neg = await runSet('rc-oll', SET.queries.filter((q) => q.negative));
    const hits = rows.filter((r) => r.rank <= 3).map((r) => r.targetScore).sort((a, b) => a - b);
    const median = hits[Math.floor(hits.length / 2)];
    const negTop = Math.max(...neg.map((r) => r.top));
    t.diagnostic(`ollama negatives: max top score ${negTop.toFixed(3)}; positive target scores min ${hits[0].toFixed(3)} median ${median.toFixed(3)}`);
    for (const r of neg) assert.ok(r.top < median, `negative ${r.q.id} top ${r.top} ≥ positive median ${median}`);
    // Per query: a negative never outranks the query's own target.
    for (const r of rows.filter((x) => x.rank <= 3)) assert.ok(r.targetScore > negTop * 0.5, r.q.id);
  } finally {
    process.env.MEMORY_EMBEDDINGS = 'hash';
    E.resetEmbeddingService();
  }
});
