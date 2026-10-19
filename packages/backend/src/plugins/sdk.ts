import { safeConsole } from '../services/safe-error-log.js';
import { extensionResourcePath } from './resource-path.js';
/**
 * Extension SDK
 * Provides ExtensionApi interface for extensions to register routes, tools, migrations, cron jobs, etc.
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import type { Tool } from '../tools/types.js';
import { registerExtensionTool, unregisterExtensionTool, isReservedToolName } from '../tools/index.js';
import { EXEC_EXTENSION_PERMISSIONS } from '../tools/exec-policy.js';
import { beginChannelTurn, CHANNEL_TURN_HEADER, type ChannelOrigin } from '../tools/channel-policy.js';
import { getDatabase } from '../db/index.js';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, sep, join } from 'path';
import { getTranslator, registerExtensionBackendTranslations } from '../i18n/index.js';
import { checkPermissions, getExtensionPermissions } from '../middleware/extension-permissions.js';
import { logSecurityEvent } from '../services/audit-logger.js';
import { getUserIdFromRequest } from '../auth/jwt.js';
import type { FastifyRequest } from 'fastify';
import type { Message } from '../agent/types.js';
import { extractAgentReply } from '../../extensions/shared/agent-reply.js';

/**
 * Extension SDK API Interface
 * Extensions receive this interface when their register() hook is called
 */
export interface ExtensionApi {
  authorizeChannelRequest(request: FastifyRequest): string;
  authorizeChannelUser(userId: string): void;
  /**
   * Run one inbound channel message through the agent as `userId` (the channel
   * owner). The turn gets the restricted channel tool set (S0-Q.8); `origin`
   * names the channel and inbound conversation so send tools can only reply there.
   */
  processChannelMessage(userId: string, sessionId: string, message: string, history: Message[], origin?: Partial<ChannelOrigin>): Promise<string>;
  // Route registration — routes registered at startup, mounted under /api/ext/:extensionId/
  registerRoutes(routesFn: (fastify: FastifyInstance) => Promise<void>, prefix?: string): void;

  // Tool registration — dynamic, available immediately to AI agents
  registerTool(tool: Tool): void;
  unregisterTool(name: string): void;

  // Dashboard widget registration — extensions can add custom dashboard widgets
  registerDashboardWidget(widget: {
    id: string;
    name: string;
    description?: string;
    component: 'stats' | 'chart' | 'list' | 'table' | 'calendar' | 'activity';
    size?: 'small' | 'medium' | 'large' | 'full';
    category?: string;
    icon?: string;
    dataEndpoint: string;
    refreshInterval?: number;
    settingsSchema?: Record<string, unknown>;
  }): void;

  // Database migrations — idempotent, tracked per extension
  runMigrations(sqlFilePaths: string[]): Promise<void>;

  // Cron/Scheduler registration — for scheduled tasks
  registerCronJob(schedule: string, handler: () => Promise<void>, jobId: string): void;
  unregisterCronJob(jobId: string): void;

  // Services — access to core systems
  db: Database;

  // Config — persisted per-extension in SQLite (extension_configs table)
  getConfig<T = Record<string, unknown>>(): T | null;
  setConfig<T = Record<string, unknown>>(config: T): void;

  // Logger
  log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void;

  // Storage API — sandboxed per extension
  storage: {
    /**
     * Save file to extension's isolated storage
     * Files go to .data/uploads/cdn/extensions/{extensionId}/ (storage manager, cdn zone)
     */
    save(
      filename: string,
      data: Buffer | string,
      options?: { category?: string; mimeType?: string }
    ): Promise<{ id: string; url: string }>;

    /**
     * List all files in extension's storage
     */
    list(category?: string): Promise<Array<{ id: string; filename: string; url: string; size: number }>>;

    /**
     * Delete file from extension's storage
     */
    delete(fileId: string): Promise<boolean>;

    /**
     * Get public URL for a file
     */
    getUrl(fileId: string): Promise<string>;
  };

  // Notifications API — send notifications to users through Core system
  notifications: {
    /**
     * Create a notification for a user
     * Automatically tags notification with extensionId as source
     */
    create(notification: {
      userId: string;
      title: string;
      body?: string;
      type?: 'info' | 'success' | 'warning' | 'error' | 'agent' | 'system' | 'reminder';
      channel?: 'in_app' | 'email' | 'push' | 'whatsapp' | 'sound';
      actionUrl?: string;
      meta?: Record<string, unknown>;
    }): Promise<{ id: string; createdAt: string }>;

    /**
     * Get notification statistics for this extension
     * Returns count of sent/read/unread notifications
     */
    getStats(): Promise<{
      total: number;
      unread: number;
      byType: Record<string, number>;
    }>;
  };

  // i18n — internationalization support
  /**
   * Register translations from extension's i18n directory.
   * Reads all JSON files from the directory and registers them as translation bundles.
   * Extensions place their translations in an i18n/ folder:
   *   i18n/en.json, i18n/ar.json, etc.
   * @param localeDir - Relative path to i18n directory (default: 'i18n')
   */
  registerTranslations(localeDir?: string): void;

  /**
   * Get a translated string for this extension's namespace.
   * @param key - Translation key (e.g., 'title', 'settings.label')
   * @param locale - Language code (default: 'en')
   * @param options - Interpolation options (e.g., { count: 5 })
   */
  t(key: string, locale?: string, options?: Record<string, any>): string;

  // Extension metadata
  extensionId: string;
}

/**
 * Create Extension SDK API instance
 * SECURITY: extensionDir parameter added for path validation (H-04)
 */
export function createExtensionApi(
  extensionId: string,
  fastify: FastifyInstance,
  db: Database,
  cronEngine: any, // CronEngine type (avoid circular dependency)
  extensionDir: string // Extension's base directory for path validation
): ExtensionApi {
  const routesToRegister: Array<{ fn: (fastify: FastifyInstance) => Promise<void>; prefix?: string }> = [];

  return {
    extensionId,
    authorizeChannelRequest(request) {
      const userId = getUserIdFromRequest(request);
      this.authorizeChannelUser(userId);
      return userId;
    },
    authorizeChannelUser(userId) {
      const user = db.prepare('SELECT role, status FROM users WHERE id = ?').get(userId) as any;
      if (!user || user.status !== 'active' || !['owner', 'admin'].includes(user.role)) {
        throw new Error('Channel administration requires an active owner or admin');
      }
    },
    async processChannelMessage(userId, sessionId, message, history, origin) {
      this.authorizeChannelUser(userId);
      // SECURITY (S0-Q.8): the message comes from an outside sender, so the turn runs
      // with the restricted channel tool policy, not the owner's full tool set. The
      // policy is bound to a random per-turn token only server code can create.
      const turn = beginChannelTurn({
        channel: origin?.channel || extensionId,
        conversationId: origin?.conversationId || '',
        allowedDestinations: origin?.allowedDestinations || [],
      }, userId); // S0-Q.9: /api/chat takes the user from this server-side turn, not the body
      try {
        // Reuse the configured primary agent, provider and tool loop from the real chat route.
        const response = await fastify.inject({
          method: 'POST', url: '/api/chat',
          headers: {
            origin: (process.env.ALLOWED_ORIGINS || 'http://localhost:41521').split(',')[0].trim(),
            [CHANNEL_TURN_HEADER]: turn.token,
          },
          payload: { sessionId, stream: false,
            messages: [...history, { role: 'user', content: message }],
            systemPromptAppend: 'Reply in plain text suitable for a messaging channel. Do not output UI specifications.',
            chatContext: { sessionType: 'minimal', hasAvatarViewer: false, hasDesktopControl: false } },
        });
        this.authorizeChannelUser(userId);
        return extractAgentReply(response);
      } finally {
        turn.end();
      }
    },

    // Database access with permission check
    get db(): Database {
      const result = checkPermissions(extensionId, ['database']);
      if (!result.granted) {
        const error = `Extension "${extensionId}" missing permission: database`;
        safeConsole.error(`[ExtensionApi:${extensionId}] ❌ ${error}`);

        logSecurityEvent({
          event_type: 'extension.permission.denied',
          severity: 'high',
          user_id: null,
          ip_address: null,
          user_agent: null,
          resource_type: 'extension',
          resource_id: extensionId,
          action: 'database_access',
          status: 'blocked',
          metadata: { missing_permissions: result.missing },
        }).catch(console.error);

        throw new Error(error);
      }

      return db;
    },

    // Route Registration (collected, registered later at startup)
    registerRoutes(routesFn, prefix?) {
      routesToRegister.push({ fn: routesFn, prefix });
      safeConsole.log(`[ExtensionApi:${extensionId}] ✅ Route registered: /api/ext/${extensionId}${prefix || ''}`);
    },

    // Tool Registration (global - available to all sessions)
    registerTool(tool) {
      // Check permission
      const result = checkPermissions(extensionId, ['tools']);
      if (!result.granted) {
        const error = `Extension "${extensionId}" missing permission: tools`;
        safeConsole.error(`[ExtensionApi:${extensionId}] ❌ ${error}`);

        logSecurityEvent({
          event_type: 'extension.permission.denied',
          severity: 'medium',
          user_id: null,
          ip_address: null,
          user_agent: null,
          resource_type: 'extension',
          resource_id: extensionId,
          action: 'register_tool',
          status: 'blocked',
          metadata: { tool_name: tool.name, missing_permissions: result.missing },
        }).catch(console.error);

        throw new Error(error);
      }

      // SECURITY: an extension tool may not replace a built-in tool (and its policy)
      if (isReservedToolName(tool.name)) {
        const error = `Extension "${extensionId}" may not register reserved tool name: ${tool.name}`;
        safeConsole.error(`[ExtensionApi:${extensionId}] ❌ ${error}`);
        try {
          logSecurityEvent({
            event_type: 'extension.permission.denied',
            severity: 'error',
            user_id: null,
            ip_address: null,
            user_agent: null,
            resource_type: 'extension',
            resource_id: extensionId,
            action: 'register_tool',
            status: 'blocked',
            metadata: { tool_name: tool.name, reason: 'reserved_name' },
          });
        } catch (logError) {
          console.error('[ExtensionApi] Failed to log blocked tool registration:', logError);
        }
        throw new Error(error);
      }

      // SECURITY: tools of extensions that declare `process`/`exec` in their manifest may
      // spawn processes, so they follow the exec gate (AGENT_EXEC_TOOLS) and are never
      // used in channel conversations. The extension cannot clear this flag.
      const declared: unknown = getExtensionPermissions(extensionId);
      const execClass = tool.execClass === true
        || (Array.isArray(declared) && EXEC_EXTENSION_PERMISSIONS.some((p) => declared.includes(p)));

      // Tag tool with extensionId for tracking
      const taggedTool = { ...tool, extensionId, execClass };
      registerExtensionTool(taggedTool);
      safeConsole.log(`[ExtensionApi:${extensionId}] ✅ Tool registered globally: ${tool.name}`);

      // Log successful registration
      try {
        logSecurityEvent({
          event_type: 'extension.tool.registered',
          severity: 'info',
          user_id: null,
          ip_address: null,
          user_agent: null,
          resource_type: 'extension',
          resource_id: extensionId,
          action: 'register_tool',
          status: 'success',
          metadata: { tool_name: tool.name },
        });
      } catch (error) {
        console.error('[ExtensionApi] Failed to log tool registration:', error);
      }
    },

    unregisterTool(name) {
      unregisterExtensionTool(name);
      safeConsole.log(`[ExtensionApi:${extensionId}] ❌ Tool unregistered globally: ${name}`);
    },

    // Dashboard Widget Registration
    registerDashboardWidget(widget) {
      const widgetId = `${extensionId}-${widget.id}`;

      // Check if widget already exists
      const existing = db.prepare('SELECT id FROM dashboard_widgets WHERE id = ?').get(widgetId);

      if (existing) {
        safeConsole.log(`[ExtensionApi:${extensionId}] ⏭️  Dashboard widget already registered: ${widget.id}`);
        return;
      }

      // Insert widget
      db.prepare(`
        INSERT INTO dashboard_widgets
        (id, name, description, component_type, extension_id, default_size, icon, category, data_endpoint, refresh_interval, settings_schema)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        widgetId,
        widget.name,
        widget.description || '',
        widget.component,
        extensionId,
        widget.size || 'medium',
        widget.icon || 'square',
        widget.category || 'extensions',
        widget.dataEndpoint,
        widget.refreshInterval || 60000,
        widget.settingsSchema ? JSON.stringify(widget.settingsSchema) : null
      );

      safeConsole.log(`[ExtensionApi:${extensionId}] ✅ Dashboard widget registered: ${widget.id} → ${widget.name}`);
    },

    // Migration Runner (idempotent per extension)
    // SECURITY: Validates paths are within extension directory (H-04)
    async runMigrations(sqlFilePaths) {
      for (const filePath of sqlFilePaths) {
        // Resolve URL to filesystem path if needed
        let resolvedPath = filePath;
        if (filePath.startsWith('file://')) {
          resolvedPath = fileURLToPath(filePath);
        }

        // SECURITY: Resolve to absolute path and validate it's within extension directory (H-04)
        const absolutePath = resolve(resolvedPath);
        const normalizedExtensionDir = resolve(extensionDir);

        // Path traversal protection: ensure the resolved path is within the extension directory
        if (!absolutePath.startsWith(normalizedExtensionDir + sep) &&
            absolutePath !== normalizedExtensionDir) {
          throw new Error(
            `SECURITY: Migration file outside extension directory rejected: ${resolvedPath}\n` +
            `Extension dir: ${normalizedExtensionDir}\n` +
            `Attempted path: ${absolutePath}`
          );
        }

        // Extract filename for tracking
        const filename = resolvedPath.split(/[\\/]/).pop() || filePath;

        // Check if already run
        const alreadyRun = db
          .prepare('SELECT 1 FROM extension_migrations WHERE extension_id = ? AND filename = ?')
          .get(extensionId, filename);

        if (alreadyRun) {
          safeConsole.log(`[ExtensionApi:${extensionId}] ⏭️  Migration already run: ${filename}`);
          continue;
        }

        // Read and execute SQL
        if (!existsSync(absolutePath)) {
          throw new Error(`Migration file not found: ${absolutePath}`);
        }

        const sql = readFileSync(absolutePath, 'utf-8');
        db.exec(sql);

        // Track migration
        db.prepare(
          'INSERT INTO extension_migrations (extension_id, filename) VALUES (?, ?)'
        ).run(extensionId, filename);

        safeConsole.log(`[ExtensionApi:${extensionId}] ✅ Migration executed: ${filename}`);
      }
    },

    // Cron Job Registration
    registerCronJob(schedule, handler, jobId) {
      // Check permission
      const result = checkPermissions(extensionId, ['cron']);
      if (!result.granted) {
        const error = `Extension "${extensionId}" missing permission: cron`;
        safeConsole.error(`[ExtensionApi:${extensionId}] ❌ ${error}`);

        logSecurityEvent({
          event_type: 'extension.permission.denied',
          severity: 'medium',
          user_id: null,
          ip_address: null,
          user_agent: null,
          resource_type: 'extension',
          resource_id: extensionId,
          action: 'register_cron',
          status: 'blocked',
          metadata: { job_id: jobId, schedule, missing_permissions: result.missing },
        }).catch(console.error);

        throw new Error(error);
      }

      const fullJobId = `ext:${extensionId}:${jobId}`;
      cronEngine.register(fullJobId, schedule, handler);
      safeConsole.log(`[ExtensionApi:${extensionId}] ✅ Cron job registered: ${jobId} (${schedule})`);

      // Log successful registration
      logSecurityEvent({
        event_type: 'extension.cron.registered',
        severity: 'info',
        user_id: null,
        ip_address: null,
        user_agent: null,
        resource_type: 'extension',
        resource_id: extensionId,
        action: 'register_cron',
        status: 'success',
        metadata: { job_id: jobId, schedule },
      }).catch(console.error);
    },

    unregisterCronJob(jobId) {
      const fullJobId = `ext:${extensionId}:${jobId}`;
      cronEngine.unregister(fullJobId);
      safeConsole.log(`[ExtensionApi:${extensionId}] ❌ Cron job unregistered: ${jobId}`);
    },

    // Config Management
    getConfig<T = Record<string, unknown>>(): T | null {
      const row = db
        .prepare('SELECT config_json FROM extension_configs WHERE extension_id = ?')
        .get(extensionId) as { config_json: string } | undefined;

      if (!row) return null;
      return JSON.parse(row.config_json) as T;
    },

    setConfig<T = Record<string, unknown>>(config: T): void {
      db.prepare(
        `INSERT INTO extension_configs (extension_id, config_json, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(extension_id) DO UPDATE SET
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      ).run(extensionId, JSON.stringify(config));

      safeConsole.log(`[ExtensionApi:${extensionId}] ✅ Config saved`);
    },

    // Logger
    log(level, message, data?) {
      const prefix = `[Extension:${extensionId}]`;
      const msg = data ? `${message} ${JSON.stringify(data)}` : message;

      switch (level) {
        case 'info':
          safeConsole.log(`${prefix} ℹ️  ${msg}`);
          break;
        case 'warn':
          safeConsole.warn(`${prefix} ⚠️  ${msg}`);
          break;
        case 'error':
          safeConsole.error(`${prefix} ❌ ${msg}`);
          break;
      }
    },

    // Storage API — sandboxed per extension
    storage: {
      /**
       * Save file to extension's isolated storage
       * Files go to .data/uploads/cdn/extensions/{extensionId}/ (storage manager, cdn zone)
       */
      async save(
        filename: string,
        data: Buffer | string,
        options?: { category?: string; mimeType?: string }
      ): Promise<{ id: string; url: string }> {
        const { getStorageManager } = await import('../services/storage-manager.js');
        const storageManager = getStorageManager();

        // Force category to be extension-specific
        const category = `extensions/${extensionId}${options?.category ? `/${options.category}` : ''}`;

        const file = await storageManager.save({
          zone: 'cdn',
          category,
          data,
          filename,
          mimeType: options?.mimeType,
          ttl: 'persistent',
          createdBy: `extension:${extensionId}`,
        });

        return {
          id: file.id,
          url: await storageManager.getPublicUrl(file.id),
        };
      },

      /**
       * List all files in extension's storage
       */
      async list(category?: string): Promise<Array<{ id: string; filename: string; url: string; size: number }>> {
        const { getStorageManager } = await import('../services/storage-manager.js');
        const storageManager = getStorageManager();

        const cat = category
          ? `extensions/${extensionId}/${category}`
          : `extensions/${extensionId}`;

        // FIX-STO-01: files saved with a sub-category live below `cat`.
        const files = await storageManager.search({ zone: 'cdn', category: cat, categoryTree: true, limit: 1000 });

        return Promise.all(files.map(async f => ({
          id: f.id,
          filename: f.filename,
          url: await storageManager.getPublicUrl(f.id),
          size: f.sizeBytes || 0,
        })));
      },

      /**
       * Delete file from extension's storage
       */
      async delete(fileId: string): Promise<boolean> {
        const { getStorageManager, inCategoryTree } = await import('../services/storage-manager.js');
        const storageManager = getStorageManager();

        // Verify file belongs to this extension before deletion (FIX-STO-01:
        // `extensions/<id>` or below it — a bare prefix let extension "ab"
        // delete the files of extension "abc")
        const file = await storageManager.getById(fileId);
        if (!file || !inCategoryTree(file.category, `extensions/${extensionId}`)) {
          throw new Error('Access denied: file does not belong to this extension');
        }

        return storageManager.delete(fileId);
      },

      /**
       * Get public URL for a file
       */
      async getUrl(fileId: string): Promise<string> {
        const { getStorageManager } = await import('../services/storage-manager.js');
        return getStorageManager().getPublicUrl(fileId);
      },
    },

    // Notifications API — unified notification system
    notifications: {
      /**
       * Create a notification for a user
       * Automatically tags with extensionId as source
       */
      async create(notification: {
        userId: string;
        title: string;
        body?: string;
        type?: 'info' | 'success' | 'warning' | 'error' | 'agent' | 'system' | 'reminder';
        channel?: 'in_app' | 'email' | 'push' | 'whatsapp' | 'sound';
        actionUrl?: string;
        meta?: Record<string, unknown>;
      }): Promise<{ id: string; createdAt: string }> {
        const { notify } = await import('../services/notification-service.js');

        // Auto-tag with extensionId as source
        const result = await notify({
          ...notification,
          source: extensionId,
        });

        safeConsole.log(`[ExtensionApi:${extensionId}] 📬 Notification created: "${notification.title}"`);

        return {
          id: result.id,
          createdAt: result.createdAt,
        };
      },

      /**
       * Get notification statistics for this extension
       */
      async getStats(): Promise<{
        total: number;
        unread: number;
        byType: Record<string, number>;
      }> {
        // B2.2c: on the process driver (services/notification-service.ts)
        const { notificationStatsBySource } = await import('../services/notification-service.js');
        const { total, unread, byType } = await notificationStatsBySource(extensionId);

        return { total, unread, byType };
      },
    },

    // i18n: Register translations from extension's i18n directory
    registerTranslations(localeDir = 'i18n') {
      const i18nDir = extensionResourcePath(extensionDir, localeDir);

      if (!existsSync(i18nDir)) {
        return; // No i18n directory — skip silently
      }

      const files = readdirSync(i18nDir).filter(f => f.endsWith('.json'));

      for (const file of files) {
        const locale = file.replace('.json', '');
        const filePath = extensionResourcePath(extensionDir, join(localeDir, file));
        try {
          const translations = JSON.parse(readFileSync(filePath, 'utf-8'));
          registerExtensionBackendTranslations(extensionId, locale, translations);
          safeConsole.log(`[ExtensionApi:${extensionId}] 🌐 Loaded ${locale} translations (${Object.keys(translations).length} keys)`);
        } catch (err) {
          safeConsole.error(`[ExtensionApi:${extensionId}] ❌ Failed to load ${locale} translations:`, err);
        }
      }
    },

    // i18n: Translator helper for this extension's namespace
    t(key: string, locale: string = 'en', options?: Record<string, any>): string {
      const translator = getTranslator(locale);
      return String(translator(`ext-${extensionId}:${key}`, options || {}));
    },

    // Internal: Get pending routes (used by extension-runner)
    __getRoutesToRegister() {
      return routesToRegister;
    },
  } as ExtensionApi & { __getRoutesToRegister: () => typeof routesToRegister };
}
