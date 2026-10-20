// CORE-MEM release check helper: one backend "boot" on an existing data dir.
// Started twice by test/memory-restart.test.mjs (write, then read) in its
// own process, so nothing survives in memory between the two runs: only
// what is on disk (database + memory folder). Listens on a loopback port and
// is called over real HTTP. Prints one JSON line with the results.
// Env (set by the test): DATABASE_PATH, HOME, JWT_SECRET, ENCRYPTION_KEY,
// MEMORY_EMBEDDINGS=hash; argv[2] = 'write' | 'read'; argv[3] = backend dir.
import { join } from 'node:path';

const [mode, backendDir] = process.argv.slice(2);
const quiet = { log: console.log, warn: console.warn };
console.log = () => {};
console.warn = () => {};
const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
if (mode === 'write') {
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES ('rs-owner', 'rs-owner@example.test', 'rs-owner', 'x', 'owner', 'active')`).run();
}
const { registerAuthGate } = await import(join(backendDir, 'src/auth/auth-gate.ts'));
const { memoryRoutes } = await import(join(backendDir, 'src/api/routes/memory.ts'));
const { memoryFilesRoutes } = await import(join(backendDir, 'src/api/routes/memory-files.ts'));
const { memoryDoctorRoutes } = await import(join(backendDir, 'src/api/routes/memory-doctor.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { default: Fastify } = await import('fastify');
const app = Fastify();
registerAuthGate(app);
await app.register(memoryRoutes);
await app.register(memoryFilesRoutes);
await app.register(memoryDoctorRoutes);
const base = await app.listen({ host: '127.0.0.1', port: 0 });
console.log = quiet.log;
console.warn = quiet.warn;

const headers = { authorization: `Bearer ${generateToken('rs-owner', 1)}`, 'content-type': 'application/json' };
const http = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json() };
};

const out = {};
if (mode === 'write') {
  out.a = await http('POST', '/api/memory', { type: 'fact', content: 'Restart check: deploy day is Thursday', importance: 9, topicKey: 'deploy-day' });
  out.b = await http('POST', '/api/memory', { type: 'fact', content: 'Restart check: deploy day is Friday', importance: 9, topicKey: 'deploy-day' });
  out.c = await http('POST', '/api/memory', { type: 'preference', content: 'Restart check: answers in Arabic', importance: 8, drawer: { kind: 'project', key: 'alpha' } });
} else {
  out.list = await http('GET', '/api/memory');
  out.drawers = await http('GET', '/api/memory/drawers');
  const first = out.list.body.memories?.find((m) => m.topicKey === 'deploy-day');
  out.versions = first ? await http('GET', `/api/memory/${first.id}/versions`) : null;
  out.again = await http('POST', '/api/memory', { type: 'fact', content: 'Restart check: deploy day is Monday', importance: 9, topicKey: 'deploy-day' });
  out.doctor = await http('GET', '/api/memory/doctor');
}
await app.close();
closeDatabase();
process.stdout.write(`\nRESULT ${JSON.stringify(out)}\n`);
