import { mcpImportRoutes } from './routes/mcp-import.js';
/**
 * Agent Player Fastify app factory.
 *
 * buildServer() creates the Fastify instance with every global hook and the
 * core route plugins, without initializing background systems and without
 * listening. server.ts calls it and then runs start(); tests import it to
 * check the real route table (S0-A.1).
 */

import Fastify from 'fastify';
import { dbDriver } from '../db/pg/config.js';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { RATE_LIMIT_PLUGIN_OPTIONS } from './rate-limit-config.js';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { sessionsRoutes } from './routes/sessions.js';
import { chatConversationRoutes } from './routes/chat-conversations.js';
import { agentHandoffRoutes } from './routes/agent-handoffs.js'; // CORE-MEM-HANDOFF: owner-only done/left/next notes
import { modelsRoutes } from './routes/models.js';
import { chatRoutes } from './routes/chat.js';
import { smartChatRoutes } from './routes/smart-chat.js';
import { settingsRoutes } from './routes/settings.js';
import { agentsStatusRoutes } from './routes/agents-status.js';
import { pluginsRoutes } from './routes/plugins.js';
import { channelsRoutes } from './routes/channels.js';
import { specialtyTemplateRoutes } from './routes/specialty-templates.js';
import { skillLibraryRoutes } from './routes/skill-library.js';
import { skillsRoutes } from './routes/skills.js';
import { schedulerRoutes } from './routes/scheduler.js';
import { memoryRoutes } from './routes/memory.js';
import { memoryFilesRoutes } from './routes/memory-files.js';
import { memoryLearningRoutes } from './routes/memory-learning.js';
import { memoryDoctorRoutes } from './routes/memory-doctor.js';
import { memoryGraphRoutes } from './routes/memory-graph.js';
import { memoryRecallRoutes } from './routes/memory-recall.js';
import { genvrRoutes } from './routes/genvr.js';
import { connectionsRoutes } from './routes/connections.js';
import { agentConnectRoutes } from './routes/agent-connect.js';
import { memoryImportRoutes } from './routes/memory-import.js';
import { credentialsRoutes } from './routes/credentials.js';
// import { onboardingRoutes } from './routes/onboarding.js'; // S0-Q.14: disabled, see below
import { onboardingWebRoutes } from './routes/onboarding-web.js'; // F-05: web wizard after first owner login
import { teamPlanRoutes } from './routes/team-plan.js'; // ONBOARD-TEAM-01: company size -> departments -> proposed team
import { gatewayRoutes } from './routes/gateway.js';
import { authRoutes } from './routes/auth.js';
import { databaseRoutes } from './routes/database.js';
import { workflowRoutes } from './routes/workflows.js';
import { sandboxRoutes } from './routes/sandbox.js';
import { auditRoutes } from './routes/audit.js';
import { encryptionRoutes } from './routes/encryption.js';
import { heartbeatRoutes } from './routes/heartbeat.js';
import { webhooksRoutes } from './routes/webhooks.js';
import { multiAgentRoutes } from './routes/multi-agent.js';
import { browserRoutes } from './routes/browser.js';
import { inboxRoutes } from './routes/inbox.js';
import { registerAudioRoutes } from './routes/audio.js';
import { registerAvatarRoutes } from './routes/avatar.js';
import { agentsConfigRoutes } from './routes/agents-config.js';
import { approvalsRoutes } from './routes/approvals.js';
import { taskRunsRoutes } from './routes/task-runs.js';
import { smallAgentRoutes } from './routes/small-agent.js';
import { budgetRoutes } from './routes/budget.js';
import { mcpServersRoutes } from './routes/mcp-servers.js';
import { instanceRoutes } from './routes/instance.js';
import { agentGrantsRoutes } from './routes/agent-grants.js';
import { agentPermissionsRoutes } from './routes/agent-permissions.js'; // CORE-PERMS-01
import { taskBoardRoutes } from './routes/task-board.js'; // BOARD-01
import { terminalRoutes } from './routes/terminal.js';
import { agentPersonalityRoutes } from './routes/agent-personality.js';
import { storageRoutes } from './routes/storage.js';
import { uploadsRoutes } from './routes/uploads.js';
import { claudeLocalRoutes } from './routes/claude-local.js';
import { aiToolsRoutes } from './routes/ai-tools.js';
import { cameraRoutes } from './routes/camera.js';
import { profileRoutes } from './routes/profile.js';
import { notificationsRoutes } from './routes/notifications.js';
import { registerTeamRoutes } from './routes/team.js';
// Email routes moved to email-client extension
// import { registerEmailRoutes } from './routes/email.js';
// import emailAccountsRoutes from './routes/email-accounts.js';
// import emailFoldersRoutes from './routes/email-folders.js';
// import emailMessagesRoutes from './routes/email-messages.js';
// import emailSearchRoutes from './routes/email-search.js';
// import emailComposeRoutes from './routes/email-compose.js';
// import emailAttachmentsRoutes from './routes/email-attachments.js';
// import emailDraftsRoutes from './routes/email-drafts.js';
import { worldsRoutes } from './routes/worlds.js';
import { multiverseRoutes } from './routes/multiverse.js';
import { worldBotsRoutes } from './routes/world-bots.js';
import { worldGeneratorRoutes } from './routes/world-generator.js';
import { worldBuilderRoutes } from './routes/world-builder.js';
import { extensionsRoutes } from './routes/extensions.js';
import { systemRoutes } from './routes/system.js';
import { registerTelephonyRoutes } from './routes/telephony.js';
import { agentFilesRoutes } from './routes/agent-files.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerCalendarRoutes } from './routes/calendar.js';
import { registerPublicChatRoutes } from './routes/public-chat.js';
import { registerCostAnalyticsRoutes } from './routes/cost-analytics.js';
import evolutionRoutes from './routes/evolution.js';
import evaluationRoutes from './routes/evaluation.js';
import memorySharingRoutes from './routes/memory-sharing.js';
import memoryQualityRoutes from './routes/memory-quality.js';
import setupRoutes, { setupStateForReadOnlyStage } from './routes/setup.js';
import { registerReadOnlyStage } from './read-only-stage.js';
import { marketplaceRoutes } from './routes/marketplace.js';
import { config } from '../config/index.js';
import { registerCsrfProtection } from '../middleware/csrf-protection.js';
import { registerHttpsEnforcement } from '../middleware/https-enforcement.js';
import { registerHostCheck } from '../middleware/host-check.js';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { registerAuthGate } from '../auth/auth-gate.js';
import { isPublicStaticPath } from './static-access.js';
import { registerGlobalErrorHandler } from './error-handler.js';
import { registerLaunchToken } from './launch-token.js';

export interface BuildServerOptions {
  logger?: FastifyServerOptions['logger'];
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: options.logger ?? {
      level: process.env.LOG_LEVEL || 'info',
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname'
        }
      }
    }
  });

  // INSTALLER-05: inside the desktop app every request needs the per-launch
  // token; registered first so no other hook or route runs without it.
  registerLaunchToken(fastify);

  // RUN-ISO stage 1: with AGENT_PLAYER_READONLY=1 only reads, login/logout
  // and first-run setup pass. Registered first, before every other hook and
  // the auth gate (see src/api/read-only-stage.ts).
  registerReadOnlyStage(fastify, { setupState: setupStateForReadOnlyStage });

  // SECURITY (H-ERR-01): one global error handler, set before any plugin so
  // every encapsulated route context inherits it. Unknown / 5xx errors get
  // the fixed internal-error body; 4xx errors keep Fastify's default reply.
  registerGlobalErrorHandler(fastify);

  // RUN-ISO: on a fresh SQLite database the schema and migrations must run
  // before the route plugins below, because the memory and credential routes
  // create their tables at registration; otherwise a later migration fails
  // with "duplicate column" and the server cannot start on an empty data dir.
  if (dbDriver() === 'sqlite') {
    const { initializeDatabase } = await import('../db/index.js');
    await initializeDatabase();
  }

  // Register CORS — SECURITY: Restrict to allowed origins only
  const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:41521').split(',').map(o => o.trim());
  await fastify.register(cors, {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Idempotency-Key', 'If-Match'],
    exposedHeaders: ['X-Run-Id', 'X-Message-Id', 'Idempotent-Replayed', 'ETag', 'Date'],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  // Register Multipart (for file uploads - audio transcription)
  await fastify.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024 } // 25MB max
  });

  // SECURITY: Register rate limiting
  // Only routes with config.rateLimit are limited (see rate-limit-config.ts).
  await fastify.register(rateLimit, { ...RATE_LIMIT_PLUGIN_OPTIONS });

  // SECURITY: Register helmet for security headers (M-05)
  await fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
    crossOriginEmbedderPolicy: false, // Allow embedding for local dev
  });

  // SECURITY: Reject unknown Host headers (DNS rebinding) (S0-Q.1)
  registerHostCheck(fastify);

  // SECURITY: Register CSRF protection middleware (M-01)
  // Validates Origin/Referer headers for state-changing requests
  registerCsrfProtection(fastify);

  // SECURITY: Register HTTPS enforcement middleware (L-01)
  // Redirects HTTP to HTTPS in production mode
  registerHttpsEnforcement(fastify);

  // SECURITY (S0-A.1): deny-by-default auth gate. Registered before any
  // route plugin so it covers every route (see src/auth/auth-gate.ts).
  registerAuthGate(fastify);

  // Serve static files from public folder (avatars, backgrounds, worlds, etc.)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const publicDir = path.join(__dirname, '..', '..', '..', '..', 'public');

  await fastify.register(fastifyStatic, {
    root: publicDir,
    prefix: '/', // Serve files at root level (e.g., /avatars/user/1/abc/avatar.glb)
    // SECURITY (S0-A.7): runtime data zones under public/storage are not
    // served statically; see src/api/static-access.ts.
    allowedPath: (pathName, root) => isPublicStaticPath(pathName, root),
  });

  fastify.log.info(`[Server] ✅ Static files served from: ${publicDir}`);

  // Register Swagger Documentation
  const { registerSwagger } = await import('../docs/swagger.js');
  await registerSwagger(fastify);

  // Health check
  fastify.get('/health', {
    schema: {
      tags: ['Health'],
      summary: 'Health check endpoint',
      description: 'Returns the current health status of the API server',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ok', 'degraded', 'error'] },
            timestamp: { type: 'string', format: 'date-time' },
            version: { type: 'string' },
          },
        },
      },
    },
  }, async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.1.0'
  }));

  // Root route
  fastify.get('/', {
    schema: {
      tags: ['Health'],
      summary: 'API information',
      description: 'Returns basic information about the API',
      response: {
        200: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            version: { type: 'string' },
            docs: { type: 'string', description: 'Documentation URL' },
          },
        },
      },
    },
  }, async () => ({
    name: 'Agent Player Backend',
    version: '0.1.0',
    docs: '/docs'
  }));

  // i18n: Detect locale from request and attach to request object
  // Priority: 1) User preference from DB (via auth), 2) Accept-Language header, 3) 'en'
  fastify.addHook('preHandler', async (request) => {
    let locale = 'en';
    try {
      const acceptLang = request.headers['accept-language'];
      if (acceptLang) {
        const preferred = acceptLang.split(',')[0]?.split('-')[0]?.trim();
        if (preferred) {
          locale = preferred;
        }
      }
    } catch {
      // Ignore parsing errors
    }
    (request as any).locale = locale;
  });

  // Register routes
  await fastify.register(setupRoutes); // 🛠️ Setup Wizard (First-Time Installation)
  await fastify.register(authRoutes); // 🔐 Authentication
  await fastify.register(databaseRoutes); // 🗄️ Database Management (Stats, Backups, Vacuum)
  await fastify.register(workflowRoutes); // ⚡ Workflow Builder
  await fastify.register(sessionsRoutes);
  await fastify.register(modelsRoutes);
  await fastify.register(chatRoutes);
  await fastify.register(chatConversationRoutes); // saved conversations + resumable runs (CHAT-REBUILD-01)
  await fastify.register(agentHandoffRoutes); // CORE-MEM-HANDOFF: the agents' handoff notes (owner only)
  await fastify.register(smartChatRoutes); // 🧠 Smart Agent System
  await fastify.register(settingsRoutes); // ⚙️ Settings API
  await fastify.register(agentsStatusRoutes); // 📊 Agents Status
  await fastify.register(pluginsRoutes); // 🔌 Plugins System
  await fastify.register(channelsRoutes); // 📱 Channels System
  await fastify.register(skillsRoutes);
  await fastify.register(mcpImportRoutes);
  await fastify.register(skillLibraryRoutes);
  await fastify.register(specialtyTemplateRoutes); // 🛠️ Skills System
  await fastify.register(schedulerRoutes); // ⏰ Scheduler System
  await fastify.register(memoryRoutes); // 🧠 Memory System
  await fastify.register(memoryFilesRoutes); // CORE-04: owner-only memory files + reviewed proposals
  await fastify.register(memoryLearningRoutes); // CORE-05: owner-only weekly learning summary
  await fastify.register(memoryDoctorRoutes); // CORE-MEM-DOCTOR: owner-only health check + confirmed fixes
  await fastify.register(memoryGraphRoutes); // CORE-MEM-GRAPH: owner-only memory graph view + link review
  await fastify.register(memoryRecallRoutes); // MEM-CACHE-01: owner-only reply recall trace, cache metrics, memory moves
  await fastify.register(agentConnectRoutes);
  await fastify.register(genvrRoutes);
  await fastify.register(connectionsRoutes);
  await fastify.register(memoryImportRoutes); // CLI-02: owner-only safe import (preview -> quarantine proposals)
  await fastify.register(credentialsRoutes); // 🔐 Credentials System
  // SECURITY (S0-Q.14): the /api/onboarding/* routes started the interactive
  // terminal wizard inside the server process for any caller. They are disabled
  // here (the routes themselves are owner-only as a second line); the web
  // first-run flow is /setup. Re-enable only with a reviewed design.
  // await fastify.register(onboardingRoutes); // 🎯 Onboarding Wizard
  // F-05: the web wizard (/onboarding page) has its own owner-only API with
  // per-user state in the DB; it never runs the terminal wizard.
  await fastify.register(onboardingWebRoutes);
  await fastify.register(teamPlanRoutes);
  await fastify.register(gatewayRoutes); // 🌐 Multi-Interface Gateway
  await fastify.register(sandboxRoutes); // 🐳 Docker Sandbox System
  await fastify.register(auditRoutes); // 🛡️ Security Audit System
  await fastify.register(encryptionRoutes); // 🔒 Encryption & Vault
  await fastify.register(heartbeatRoutes); // 💓 Heartbeat Monitor
  await fastify.register(webhooksRoutes); // 🪝 Webhooks System
  await fastify.register(multiAgentRoutes); // 🤖 Multi-Agent System
  await fastify.register(browserRoutes); // 🌐 Browser Automation
  await fastify.register(registerAudioRoutes); // 🎤 Audio (Whisper STT + TTS)
  await fastify.register(registerAvatarRoutes); // 🧑‍🎨 Avatar Settings (Ready Player Me)
  await fastify.register(agentsConfigRoutes);  // 🤖 Agent Configurations CRUD
  await fastify.register(approvalsRoutes); // S1.3: owner approvals for held agent tool calls
  await fastify.register(taskRunsRoutes); // CORE-08: durable task runs (list, view, cancel, resolve)
  await fastify.register(smallAgentRoutes); // MCP-01: owner-only small local agent runs (MCP server backend)
  await fastify.register(budgetRoutes); // R2: owner-only paid model spend today and the daily cap
  await fastify.register(mcpServersRoutes); // M1: owner-only MCP client server registry, discovery, tool settings
  await fastify.register(instanceRoutes); // MCP-01b: public instance proof for local clients (no secret returned)
  await fastify.register(agentGrantsRoutes); // S1.4: owner view/edit of agent tool grants
  await fastify.register(agentPermissionsRoutes); // CORE-PERMS-01: memory scope + off/ask/allow per agent
  await fastify.register(taskBoardRoutes); // BOARD-01: company task board
  await fastify.register(terminalRoutes); // TERM-01: owner-only, loopback-only shell (off unless AGENT_TERMINAL=true)
  await fastify.register(agentPersonalityRoutes); // CORE-01: owner-only versioned personality
  await fastify.register(storageRoutes);       // 📦 Local Storage (Cache + CDN)
  await fastify.register(uploadsRoutes);       // 🔒 Runtime uploads in .data/uploads (CL-05)
  await fastify.register(claudeLocalRoutes);   // 🔗 Claude Local Integration
  await fastify.register(aiToolsRoutes);       // 🔍 AI Tools Scanner
  await fastify.register(cameraRoutes);        // 📷 Camera Sessions + WebRTC Signaling
  await fastify.register(profileRoutes);       // 👤 User Profile (GET/PUT /api/profile)
  await fastify.register(notificationsRoutes); // 🔔 Notifications (CRUD + Settings + Schedules)
  await fastify.register(registerTeamRoutes);     // 👥 Team Management (Teams, Members, Invitations)
  // Email routes moved to email-client extension (install via /dashboard/extensions)
  // await fastify.register(registerEmailRoutes);    // 📧 Email Configuration (SMTP Test + Verify)
  // await fastify.register(emailAccountsRoutes);    // 📬 Email Accounts (Multi-Account IMAP/SMTP + OAuth)
  // await fastify.register(emailFoldersRoutes);     // 📁 Email Folders (List, Create, Update, Delete)
  // await fastify.register(emailMessagesRoutes);    // 📨 Email Messages (List, Read, Star, Delete, Move, Bulk)
  // await fastify.register(emailSearchRoutes);      // 🔍 Email Search (FTS5 Full-Text Search)
  // await fastify.register(emailComposeRoutes);     // ✉️  Email Compose (Send, Reply, Forward)
  // await fastify.register(emailAttachmentsRoutes); // 📎 Email Attachments (Upload, Download)
  // await fastify.register(emailDraftsRoutes);      // 📝 Email Drafts (Auto-Save, CRUD)
  // await fastify.register(worldsRoutes);           // 🌍 Interactive 3D Worlds (DEPRECATED - merged into multiverseRoutes)
  await fastify.register(multiverseRoutes);    // 🪐 Multiverse (Worlds + Bots + System Worlds)
  // await fastify.register(worldBotsRoutes);     // 🤖 World Bots (DEPRECATED - merged into multiverseRoutes)
  await fastify.register(worldGeneratorRoutes); // ✨ AI World Generator (Prompt-based Generation)
  await fastify.register(worldBuilderRoutes);     // 🏗️  World Builder (Manual Building + Save/Load)
  await fastify.register(extensionsRoutes);    // 🔌 Extensions Management (SDK-based)
  await fastify.register(marketplaceRoutes);   // 🛒 Extension Marketplace (Registry, Install, Reviews)
  await fastify.register(registerTelephonyRoutes); // ☎️ Telephony / Assistant Center (Call Center)
  await fastify.register(systemRoutes);        // ⚙️ System Operations (Restart, Shutdown)
  await fastify.register(agentFilesRoutes);    // 📝 Agent Files (PERSONALITY.md + MEMORY.md)
  await fastify.register(registerDashboardRoutes); // 📊 Customizable Dashboard (Widgets + Layouts)
  await fastify.register(registerCalendarRoutes);  // 📅 Calendar System (Events + Google Calendar Sync)
  await fastify.register(registerPublicChatRoutes); // 💬 Public Chat Rooms (Multi-User Chat with AI Agents)
  await fastify.register(registerCostAnalyticsRoutes); // 💰 Cost Analytics (Model Usage & Savings Tracking)
  await fastify.register(evolutionRoutes);        // 🧬 Agent Evolution System (Self-Learning & Adaptation)
  await fastify.register(evaluationRoutes);       // 📊 Agent Evaluation Framework (Quality Assessment & Metrics)
  await fastify.register(memorySharingRoutes);    // 🤝 Multi-Agent Memory Sharing (Shared Knowledge & Deduplication)
  await fastify.register(memoryQualityRoutes);    // ✨ High-Quality Memory Content (Quality Scoring & Enrichment)

  return fastify;
}
