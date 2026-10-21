// CRITICAL: must stay the first import. Loads .env, then the generated
// secrets from .data/secrets.env (INST-02), before any other module runs.
import '../config/load-env.js';

// SECURITY: Default to production mode if NODE_ENV not set (L-04)
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
  console.warn('[Security] NODE_ENV not set - defaulting to production mode');
}

/**
 * Agent Player Backend Server
 * Fastify-based REST API
 */

import path from 'node:path';
import { buildServer } from './app.js';
import { initializeBackend } from './startup.js';
import { config } from '../config/index.js';
import { dataRoot, mainDatabasePath } from '../config/data-root.js';
import { dbDriver } from '../db/pg/config.js';
import { ISOLATED_ENV } from '../config/isolation.js';
import { LAUNCH_TOKEN_ENV } from './launch-token.js';
import { assertSafeIsolatedTree } from '../config/isolated-tree.js';
import { flushAuditWritesWithin, SHUTDOWN_AUDIT_FLUSH_MS } from '../services/audit-logger.js';
import { startAutomaticProjectImports, stopAutomaticProjectImports } from '../memory/import/automatic-project-import.js';
import { startDiscoveryWatch, stopDiscoveryWatch } from '../discovery/service.js';
import { resumePendingImports, stopLocalImports } from '../memory/import/local-import.js';
import { getOrchestrator } from '../multi-agent/orchestrator.js';

const PORT = config.port;
const HOST = config.host;

const fastify = await buildServer();

/** Python availability for audio features (a startup probe: skipped with background off). */
async function probePython(): Promise<string> {
  let pythonStatus = '❌ Not found';
  try {
    const { execFileSync } = await import('child_process');
    const pythonPaths = [
      `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python312\\python.exe`,
      `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python311\\python.exe`,
      'python', 'py',
    ];
    for (const p of pythonPaths) {
      try {
        const ver = execFileSync(p, ['--version'], { timeout: 2000 }).toString().trim();
        pythonStatus = `✅ ${ver}`;
        break;
      } catch { /* try next */ }
    }
  } catch { /* ignore */ }
  return pythonStatus;
}

/** BUG-03: the real resolved locations (no fixed project path). */
function storageLines(): string {
  const db = dbDriver() === 'postgres' ? 'PostgreSQL (AGENT_PLAYER_PG_URL)' : path.resolve(mainDatabasePath());
  return `  📁 Data:     ${path.resolve(dataRoot())}\n  🗄️  Database: ${db}`;
}

// Start server
async function start() {
  try {
    console.log('[Server] 🚀 Initializing backend systems...\n');

    const summary = await initializeBackend(fastify);

    // RUN-ISO ISO-1: re-check the data tree after every store was opened.
    if (process.env[ISOLATED_ENV] === '1') assertSafeIsolatedTree(path.resolve(dataRoot()));

    await fastify.listen({ port: PORT, host: HOST });

    // RUN-ISO / INSTALLER-05: tell the isolated launcher or the desktop app
    // (IPC only, no secrets) that we listen, with the real port (PORT=0 = random).
    if ((process.env[ISOLATED_ENV] === '1' || process.env[LAUNCH_TOKEN_ENV]) && typeof process.send === 'function') {
      const addr = fastify.server.address();
      process.send({ type: 'listening', host: HOST, port: typeof addr === 'object' && addr ? addr.port : PORT });
    }

    if (summary.background) {
      void resumePendingImports().catch(() => console.warn('[Memory import] Saved progress unavailable; no new import started.')).finally(() => { startAutomaticProjectImports(); startDiscoveryWatch(); });
    }

    const pythonStatus = summary.background ? await probePython() : '— (background off)';

    console.log(`
╔══════════════════════════════════════════════════════╗
║            Agent Player Backend v1.3.0               ║
╠══════════════════════════════════════════════════════╣
║  🌐 Frontend:  ${config.frontendUrl.padEnd(32)}║
║  ⚙️  Backend:   http://${HOST}:${PORT}${' '.repeat(Math.max(0, 32 - (HOST.length + PORT.toString().length + 10)))}║
║  📖 API Docs:  http://${HOST}:${PORT}/docs${' '.repeat(Math.max(0, 26 - (HOST.length + PORT.toString().length + 10)))}║
║  💚 Health:    http://${HOST}:${PORT}/health${' '.repeat(Math.max(0, 24 - (HOST.length + PORT.toString().length + 10)))}║
╠══════════════════════════════════════════════════════╣
║  📦 Skills:       ${String(summary.skills).padEnd(2)} loaded                        ║
║  ⏰ Jobs:         ${String(summary.jobs).padEnd(2)} ${summary.background ? 'scheduled' : 'known (background off)'}                    ║
║  🧠 Memory:       Ready                              ║
║  🔐 Credentials:  Ready                              ║
║  🌐 Gateway:      ${String(summary.channels).padEnd(2)} channels active              ║
║  🐳 Sandbox:      ${(summary.dockerAvailable ? 'Docker Ready   ' : 'Native Mode    ')}                ║
║  🛡️  Audit:        Active                             ║
║  🔒 Encryption:   Ready                              ║
║  💓 Heartbeat:    ${summary.background ? 'Monitoring' : 'Off       '}                         ║
║  🪝 Webhooks:     Ready                              ║
║  🤖 Multi-Agent:  Ready                              ║
║  🌐 Browser:      Ready                              ║
║  📦 Storage:      Ready (Cache + CDN)                ║
║  ⏱️  Agent Cron:  ${summary.background ? 'Ready' : 'Off  '}                              ║
╠══════════════════════════════════════════════════════╣
║  🎙️  Python/TTS:   ${pythonStatus.padEnd(33)}║
╚══════════════════════════════════════════════════════╝
${storageLines()}
    `);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(1), 20000);
  deadline.unref();
  try {
    // Closing Fastify runs channel transport shutdown hooks before process exit.
    await stopAutomaticProjectImports();
    stopDiscoveryWatch();
    await stopLocalImports();
    await fastify.close();
    // B2.2b-2: audit rows still being written (PostgreSQL inserts are not
    // awaited by the request) get a short, bounded chance to land.
    if (!(await flushAuditWritesWithin(SHUTDOWN_AUDIT_FLUSH_MS))) {
      console.warn(`[Server] Some audit writes did not finish within ${SHUTDOWN_AUDIT_FLUSH_MS} ms of shutdown`);
    }
    // B2.2d-15: orchestrator writes queued for PostgreSQL get the same bounded chance.
    if (!(await flushAuditWritesWithin(SHUTDOWN_AUDIT_FLUSH_MS, () => getOrchestrator().flush()))) {
      console.warn(`[Server] Some orchestrator writes did not finish within ${SHUTDOWN_AUDIT_FLUSH_MS} ms of shutdown`);
    }
    process.exit(0);
  } catch {
    process.exit(1);
  }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void shutdown(); });
// INSTALLER-05: the desktop app asks over IPC (Windows has no SIGTERM for a child).
if (process.env[LAUNCH_TOKEN_ENV] && typeof process.send === 'function') {
  process.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'shutdown') void shutdown();
  });
  // The app is gone (crash, force quit): do not keep running without it.
  process.once('disconnect', () => { void shutdown(); });
}

start();

export default fastify;
