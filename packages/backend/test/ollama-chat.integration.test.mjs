// Chat round trip through the backend /api/chat route to a local Ollama model.
// Runs in-process with fastify.inject (no listening port) on a throwaway database.
// Run: node --import tsx --test test/ollama-chat.integration.test.mjs
// Skipped when Ollama is not reachable or the model is not pulled.
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OLLAMA = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MODEL = process.env.OLLAMA_TEST_MODEL || 'qwen3.5:9b';

async function modelAvailable() {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const { models = [] } = await res.json();
    return models.some((m) => m.name === MODEL);
  } catch {
    return false;
  }
}

const available = await modelAvailable();

test('POST /api/chat answers through local Ollama', { skip: !available && `Ollama model ${MODEL} not available`, timeout: 300_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ap-ollama-chat-'));
  // Every store under the temp folder: the agent files (.data/agents/<id>) were
  // written below the cwd, i.e. the real .data when run from the main checkout.
  const startDir = process.cwd();
  process.chdir(dir);
  process.env.HOME = dir;
  process.env.AGENT_PLAYER_DATA_DIR = join(dir, 'data');
  process.env.DATABASE_PATH = join(dir, 'data', 'agent-player.db');
  process.env.OLLAMA_THINK ??= 'false';
  process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only

  const { getDatabase, closeDatabase } = await import(join(startDir, 'src/db/database.ts'));
  const { default: Fastify } = await import('fastify');
  const { chatRoutes } = await import(join(startDir, 'src/api/routes/chat.ts'));

  const db = getDatabase();
  await db.initialize();
  db.prepare(
    `INSERT INTO agents_config (id, name, system_prompt, model, provider, is_primary, temperature, max_tokens)
     VALUES ('local-qwen', 'Local Qwen', 'Answer in one short sentence.', ?, 'ollama', 0, 0, 128)`
  ).run(MODEL);
  // S0-Q.9: /api/chat needs a verified bearer token.
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES ('u-test', 'u-test@example.test', 'u-test', 'x', 'owner', 'active')`).run();
  const { generateToken } = await import(join(startDir, 'src/auth/jwt.ts'));
  const headers = { authorization: `Bearer ${generateToken('u-test', 1)}` };

  const app = Fastify();
  await app.register(chatRoutes);
  t.after(async () => {
    await app.close();
    closeDatabase();
    process.chdir(startDir);
    rmSync(dir, { recursive: true, force: true });
  });

  const nonStream = await app.inject({
    method: 'POST',
    url: '/api/chat',
    headers,
    payload: {
      agentId: 'local-qwen',
      stream: false,
      messages: [{ role: 'user', content: 'What is the capital of Germany? Reply with the city name only.' }],
    },
  });
  assert.equal(nonStream.statusCode, 200, nonStream.body);
  const body = nonStream.json();
  assert.match(body.message.content, /Berlin/i);

  const streamed = await app.inject({
    method: 'POST',
    url: '/api/chat',
    headers,
    payload: {
      agentId: 'local-qwen',
      stream: true,
      messages: [{ role: 'user', content: 'ما هي عاصمة العراق؟ أجب باسم المدينة فقط.' }],
    },
  });
  assert.equal(streamed.statusCode, 200, streamed.body);
  const events = streamed.body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)));
  assert.ok(events.some((e) => e.done === true), 'stream ends with a done event');
  const text = events.map((e) => e.content || '').join('');
  assert.match(text, /بغداد|Baghdad/i);
});
