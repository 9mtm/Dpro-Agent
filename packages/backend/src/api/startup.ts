import { fileURLToPath } from 'node:url';
/**
 * Backend startup chain (moved out of server.ts so it can be tested).
 *
 * `initializeBackend(fastify)` runs every init step server.ts ran before
 * `listen`. With `AGENT_PLAYER_BACKGROUND=off` (RUN-ISO F2) it still
 * initializes everything the API needs, but starts no scheduler, timer,
 * watcher, probe or child process; see config/background.ts.
 */

import type { FastifyInstance } from 'fastify';
import { processScheduledNotifications } from '../services/notification-service.js';
import { startCalendarSyncScheduler } from '../services/calendar-sync.js';
import { config } from '../config/index.js';
import { backgroundEnabled } from '../config/background.js';
import { dataPathOr } from '../config/data-root.js';

export interface StartupSummary {
  background: boolean;
  skills: number;
  jobs: number;
  channels: number;
  dockerAvailable: boolean;
}

/** Background startup jobs and how `AGENT_PLAYER_BACKGROUND=off` handles each one. */
export const BACKGROUND_JOBS: ReadonlyArray<{ id: string; off: string }> = [
  { id: 'skills-watcher', off: 'skillsRegistry.watch() not called (skills are still loaded once)' },
  { id: 'cron-engine', off: 'CronEngine.scheduleJob records the job but creates no node-cron task' },
  { id: 'automatic-project-import', off: 'automatic project-file timer and startup catch-up not started' },
  { id: 'local-import-recovery', off: 'resumePendingImports not called (explicit owner import requests still work)' },
  { id: 'memory-jobs', off: 'weekly-summary/retention jobs not ensured or scheduled' },
  { id: 'evolution-scheduler', off: 'initializeEvolutionScheduler not called (and the cron engine guard)' },
  { id: 'agent-cron', off: 'startAgentCronService not called; registerAgentCron creates no task' },
  { id: 'task-run-recovery', off: 'startTaskRunRecovery not called (no timer, no recovery kick)' },
  { id: 'handoff-sweep', off: 'startHandoffSweep not called (no generated handoff notes for idle chats / ended task runs)' },
  { id: 'memory-bridge-sync', off: 'startMemoryBridgeSync not called (managed project files and back-flow only on owner request)' },
  { id: 'login-pruning', off: 'startLoginRecordPruning not called' },
  { id: 'scheduled-notifications', off: '60 s interval not started' },
  { id: 'calendar-sync', off: 'startCalendarSyncScheduler not called' },
  { id: 'extension-stats', off: 'hourly interval not started' },
  { id: 'memory-consolidation', off: 'startScheduler not called' },
  { id: 'gateway-session-cleanup', off: 'SessionManager starts no 5 min cleanup interval' },
  { id: 'heartbeat-checks', off: 'HeartbeatMonitor starts no per-component interval' },
  { id: 'audit-flush', off: 'AuditLogger starts no 5 s flush interval (buffer is bounded instead)' },
  { id: 'camera-room-cleanup', off: 'module-level 5 min interval not started' },
  { id: 'storage-cleanup', off: 'startup storageManager.cleanup() skipped' },
  { id: 'docker-probe', off: 'docker --version / docker info not run (reported as not available)' },
  { id: 'desktop-cleanup', off: 'desktop_control hide_indicator not executed' },
  { id: 'extensions', off: 'extensionRunner.initialize and hot reload skipped' },
  { id: 'instance-identity-publish', off: 'publishInstanceIdentity not called' },
  { id: 'python-probe', off: 'python --version probes not run (server.ts)' },
];

export async function initializeBackend(fastify: FastifyInstance): Promise<StartupSummary> {
  const background = backgroundEnabled();
  if (!background) console.log('[Server] AGENT_PLAYER_BACKGROUND=off: no schedulers, timers, watchers or probes\n');

  // Initialize Database
  const { initializeDatabase, getDatabase } = await import('../db/index.js');
  const { dbDriver } = await import('../db/pg/config.js');
  await initializeDatabase();
  // Decorate Fastify instance with database for extensions to use. Extensions
  // are SQLite-only and off on PostgreSQL (Q-33), where no SQLite file is opened.
  if (dbDriver() !== 'postgres') fastify.decorate('db', getDatabase());
  console.log('[Server] ✅ Database initialized\n');

  // Seed database in development mode
  if (process.env.NODE_ENV === 'development') {
    const { seedDatabase } = await import('../db/seed.js');
    await seedDatabase();
  }

  // Initialize Skills Registry
  const { getSkillsRegistry } = await import('../skills/registry.js');
  const skillsRegistry = getSkillsRegistry();
  // GenVR SDK skills first: an SDK skill wins over an older Dpro copy of the same name.
  await skillsRegistry.load([fileURLToPath(new URL('../../../core-ui/vendor/genvr/package/skills/', import.meta.url)), './skills']);
  if (background) skillsRegistry.watch(); // Enable hot reload
  console.log(`[Server] ✅ Loaded ${skillsRegistry.getAll().length} skills\n`);

  // Start cron engine (with background off it schedules nothing).
  const { getCronEngine } = await import('../scheduler/engine.js');
  const cronEngine = getCronEngine();
  await cronEngine.start();

  // Initialize Memory System
  const { getMemoryStorage } = await import('../memory/index.js');
  const memoryStorage = getMemoryStorage();
  await memoryStorage.initialize();
  console.log('[Server] ✅ Memory system initialized\n');

  // Initialize Credentials System
  const { getCredentialStorage } = await import('../credentials/index.js');
  const credentialStorage = getCredentialStorage();
  await credentialStorage.initialize();
  console.log('[Server] ✅ Credentials system initialized\n');

  // SECURITY (S1.1): move plaintext agents_config.api_key values into
  // encrypted credentials (verified round-trip; refused without ENCRYPTION_KEY).
  const { migrateAgentApiKeys } = await import('../credentials/authority.js');
  await migrateAgentApiKeys();

  // Initialize Multi-Interface Gateway
  const { getGateway, WebChannelAdapter, DesktopChannelAdapter } = await import('../gateway/index.js');
  const { AgentRuntime } = await import('../agent/index.js');

  // Create agent runtime instance for gateway (uses default config)
  const agentRuntime = new AgentRuntime();

  const gateway = getGateway(agentRuntime, {
    storageDir: dataPathOr('./.data/gateway', 'gateway'),
    sessionTimeout: 3600000, // 1 hour
    syncAcrossChannels: true
  });

  // Register channel adapters
  await gateway.registerChannel(new WebChannelAdapter());
  await gateway.registerChannel(new DesktopChannelAdapter());

  // Start gateway
  await gateway.start();
  console.log('[Server] ✅ Gateway initialized with 2 channels\n');

  // Initialize Telephony Service (Twilio + Google Voice)
  const { initializeTelephonyService } = await import('../services/telephony-service.js');
  await initializeTelephonyService();
  console.log('[Server] ✅ Telephony service initialized\n');

  // Initialize Inbox System
  const { createInboxSystem } = await import('../inbox/index.js');
  const inboxSystem = createInboxSystem();

  // Attach to fastify instance for routes
  fastify.decorate('inboxGateway', inboxSystem.inboxGateway);
  fastify.decorate('messageStore', inboxSystem.messageStore);
  fastify.decorate('riskAnalyzer', inboxSystem.riskAnalyzer);
  fastify.decorate('approvalEngine', inboxSystem.approvalEngine);

  console.log('[Server] ✅ Inbox system initialized\n');

  // Register inbox routes (after initialization)
  const { inboxRoutes } = await import('./routes/inbox.js');
  await fastify.register(inboxRoutes); // 📥 Inbox System
  console.log('[Inbox API] ✅ Routes registered\n');

  // Initialize Sandbox System
  const { getSandboxExecutor, getDockerManager } = await import('../sandbox/index.js');
  getSandboxExecutor();
  const dockerManager = getDockerManager();
  const dockerAvailable = background ? await dockerManager.isDockerAvailable() : false;
  console.log(`[Server] ✅ Sandbox initialized (Docker: ${dockerAvailable ? 'Available' : 'Not Available'})\n`);

  // Initialize Audit System
  const { initializeAudit } = await import('../audit/index.js');
  const { logger: auditLogger } = await initializeAudit();
  auditLogger.log({
    category: 'system',
    action: 'startup',
    severity: 'low',
    actor: { type: 'system', id: 'server' },
    details: { version: '0.1.0', port: config.port },
    result: 'success',
  });
  console.log('[Server] ✅ Audit system initialized\n');

  // Initialize Encryption System
  const { initializeEncryption } = await import('../encryption/index.js');
  await initializeEncryption();
  console.log('[Server] ✅ Encryption system initialized\n');

  // Initialize Heartbeat System
  const { initializeHeartbeat } = await import('../heartbeat/index.js');
  await initializeHeartbeat();
  console.log('[Server] ✅ Heartbeat system initialized\n');

  // Initialize Webhooks System
  const { initializeWebhooks } = await import('../webhooks/index.js');
  await initializeWebhooks();
  console.log('[Server] ✅ Webhooks system initialized\n');

  // Initialize Multi-Agent System
  const { initializeMultiAgent, getOrchestrator } = await import('../multi-agent/index.js');
  const multiAgentOrchestrator = getOrchestrator();
  await multiAgentOrchestrator.initialize();
  await initializeMultiAgent();
  console.log('[Server] ✅ Multi-Agent system initialized\n');

  // Initialize Browser Automation System
  const { initializeBrowser } = await import('../browser/index.js');
  await initializeBrowser();
  console.log('[Server] ✅ Browser automation initialized\n');

  // Desktop cleanup on startup — kill any leftover indicator window and restore cursor
  // (handles the case where backend restarted without hide_indicator being called)
  if (background) {
    try {
      const { createToolsRegistry } = await import('../tools/index.js');
      const startupRegistry = createToolsRegistry({ userId: 'system', sessionId: 'startup', workspaceDir: process.cwd() });
      await startupRegistry.execute('desktop_control', { action: 'hide_indicator' });
      console.log('[Server] ✅ Desktop cleanup: indicator hidden, cursor restored\n');
    } catch {
      // Silently ignore — pyautogui may not be installed, that is fine
    }
  }

  // Initialize Storage System (Cache + CDN)
  const { getStorageManager } = await import('../services/storage-manager.js');
  const storageManager = getStorageManager();
  await storageManager.initialize();
  if (background) {
    const { deleted: expiredCleaned } = await storageManager.cleanup();
    if (expiredCleaned > 0) console.log(`[StorageManager] 🧹 Cleaned ${expiredCleaned} expired files on startup`);
  }
  console.log('[Server] ✅ Storage system initialized\n');

  if (background) {
    // Initialize Agent Cron Service
    const { startAgentCronService } = await import('../services/agent-cron.js');
    await startAgentCronService();

    // CORE-08: resume durable task runs interrupted by a restart (expired
    // leases), and continue runs whose approval was decided.
    const { startTaskRunRecovery } = await import('../services/task-run-executor.js');
    startTaskRunRecovery();

    // CORE-MEM-HANDOFF: one generated handoff note per idle conversation /
    // ended task run that has none (local model, fallback when none answers).
    const { startHandoffSweep } = await import('../memory/handoff/generate.js');
    startHandoffSweep();

    // MEM-BRIDGE-01: confirmed project folders get their managed AGENTS.md /
    // CLAUDE.md / GEMINI.md section refreshed; opted-in back-flow runs.
    const { startMemoryBridgeSync } = await import('../memory/bridge/sync.js');
    startMemoryBridgeSync();

    // S0-Q.21: prune old sign-in attempts (30 days) and expired device
    // tokens now and daily (unref'd timer, errors logged, never thrown).
    // B2.2b: through the selected driver's throttle store (loginThrottle.prune).
    const { startLoginRecordPruning } = await import('../repositories/index.js');
    startLoginRecordPruning();

    // Scheduled notifications — check every minute
    setInterval(() => {
      processScheduledNotifications().catch(() => { /* non-fatal */ });
    }, 60_000);

    // Initialize Calendar Sync Scheduler
    startCalendarSyncScheduler();
    console.log('[Server] ✅ Calendar sync scheduler started\n');

    // Initialize Extension Storage Stats Scheduler (hourly updates)
    const { updateAllExtensionStorageStats } = await import('../services/extension-analytics.js');
    setInterval(() => {
      updateAllExtensionStorageStats().catch((err) => {
        console.error('[Extension Analytics] Failed to update storage stats:', err);
      });
    }, 60 * 60 * 1000); // Every 60 minutes
    console.log('[Server] ✅ Extension analytics scheduler started (hourly storage updates)\n');

    // Initialize Multi-Tier Memory Consolidation Scheduler
    const { getConsolidationService } = await import('../services/memory-consolidation.js');
    const consolidationService = getConsolidationService();
    consolidationService.startScheduler();
    console.log('[Server] ✅ Memory consolidation scheduler started (runs daily at 3 AM)\n');

    // CORE-05/07: owner-scoped memory jobs (weekly summary), in-process.
    try {
      const { ensureMemoryJobs } = await import('../memory/jobs.js');
      for (const job of await ensureMemoryJobs()) {
        cronEngine.scheduleJob({
          id: job.id, name: job.name, cronExpression: job.cronExpression, actionType: 'memory-job',
          actionData: job.actionData as any, enabled: true, createdAt: new Date(), updatedAt: new Date(),
        });
      }
    } catch (err) {
      console.warn('[Server] Memory jobs not scheduled:', (err as Error).message);
    }

    // Initialize Agent Evolution Scheduler
    const { initializeEvolutionScheduler } = await import('../services/agent-evolution-scheduler.js');
    await initializeEvolutionScheduler();
    console.log('[Server] ✅ Agent evolution scheduler initialized\n');

    // Initialize Extension System
    const { getExtensionRunner } = await import('../plugins/extension-runner.js');
    const extensionRunner = getExtensionRunner();
    await extensionRunner.initialize(fastify, cronEngine);

    // Enable hot reload for extensions (development mode)
    if (process.env.NODE_ENV === 'development') {
      extensionRunner.enableHotReload();
    }
  }

  // Register Extension Analytics Middleware
  const { extensionAnalyticsMiddleware } = await import('../middleware/extension-analytics-middleware.js');
  const { recordApiCall } = await import('../services/extension-analytics.js');

  fastify.addHook('onRequest', extensionAnalyticsMiddleware());

  // Record analytics on response
  fastify.addHook('onResponse', async (request, reply) => {
    const extensionId = (request as any).__analyticsExtensionId;
    const startTime = (request as any).__analyticsStartTime;

    if (!extensionId || !startTime) return;

    const responseTime = Date.now() - startTime;
    const success = reply.statusCode < 400;

    recordApiCall(extensionId, {
      success,
      responseTimeMs: responseTime,
      errorType: success ? undefined : `HTTP ${reply.statusCode}`,
    });
  });

  console.log('[Server] ✅ Extension analytics middleware registered\n');

  // Email Sync Service moved to email-client extension
  // const { emailSyncService } = await import('../services/email-sync-service.js');
  // await emailSyncService.startAllAutoSync();
  // console.log('[Server] ✅ Email sync service initialized\n');

  // MCP-01b: per-install identity next to the CLI token, so the MCP server
  // can verify this backend before it sends the owner's token.
  if (background) {
    try {
      const { publishInstanceIdentity } = await import('../services/instance-identity.js');
      const written = publishInstanceIdentity();
      console.log(written ? '[Server] ✅ Instance identity ready for local clients' : '[Server] ⚠️  Instance identity file not written (a foreign file is in the way)');
    } catch (err: any) {
      console.warn('[Server] ⚠️  Could not write the instance identity:', err?.code ?? 'error');
    }
  }

  return {
    background,
    skills: skillsRegistry.getAll().length,
    jobs: cronEngine.getJobs().length,
    channels: gateway.getStats().channelCount,
    dockerAvailable,
  };
}
