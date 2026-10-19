import { safeConsole } from '../../services/safe-error-log.js';
/**
 * Extensions API Routes
 * Manage modern Extension SDK extensions
 */

import type { FastifyInstance } from 'fastify';
import { handleError } from '../error-handler.js';
import { q, run, sql, tableColumns, tableNames } from '../../repositories/sql-steps.js';
import { getExtensionRunner, extensionsAvailable, EXTENSIONS_SQLITE_ONLY } from '../../plugins/extension-runner.js';
import { getExtensionTools } from '../../tools/index.js';
import { readdirSync, existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { validateTableName } from '../../db/sql-utils.js';
import { requireActiveRole, OWNER_OR_ADMIN } from '../../auth/route-guards.js';
import { maskSecretFields, restoreMaskedFields } from '../../credentials/secret-mask.js';

// Extension ids are directory names; locales are short language tags. Both
// end up in filesystem paths (delete, i18n), so nothing else is accepted.
const EXTENSION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const LOCALE = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?$/;

export async function extensionsRoutes(fastify: FastifyInstance) {
  const extensionsDir = resolve('./extensions');
  // SECURITY (S0-Q.7): authorization is decided by the route Fastify actually
  // matched (request.routeOptions.url) and its decoded params, never by a regex
  // on the raw URL. Deny by default: every route in this plugin needs an active
  // owner/admin except the read-only metadata routes listed here.
  const PUBLIC_ROUTES = new Set([
    'GET /api/extensions',                                // manifest list (no config)
    'GET /api/extensions/enabled-routes',                 // sidebar links
    'GET /api/extensions/:id/status',                     // enabled flag
    'GET /api/extensions/:extensionId/i18n/:locale',      // UI translations
  ]);
  const requireOwnerOrAdmin = requireActiveRole(OWNER_OR_ADMIN);
  fastify.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions?.url;
    if (!route) return; // unmatched: Fastify answers 404
    if (!PUBLIC_ROUTES.has(`${request.method} ${route}`)) {
      await requireOwnerOrAdmin(request, reply);
      if (reply.sent) return reply;
    }
    const params = (request.params || {}) as Record<string, string>;
    for (const key of ['id', 'extensionId']) {
      if (params[key] !== undefined && !EXTENSION_ID.test(params[key])) {
        return reply.code(400).send({ error: 'Invalid extension id' });
      }
    }
    if (params.locale !== undefined && !LOCALE.test(params.locale)) {
      return reply.code(400).send({ error: 'Invalid locale' });
    }
  });

  /**
   * GET /api/extensions - List all extensions (installed + available)
   */
  fastify.get('/api/extensions', {
    schema: {
      tags: ['Extensions'],
      description: 'List all installed extensions with their status',
    },
  }, async (request, reply) => {
    try {
      const extensions = [];

      // Scan extensions directory
      if (existsSync(extensionsDir)) {
        const dirs = readdirSync(extensionsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);

        for (const dirName of dirs) {
          // Try both manifest filename formats (new and old)
          let manifestPath = join(extensionsDir, dirName, 'agentplayer.plugin.json');
          if (!existsSync(manifestPath)) {
            manifestPath = join(extensionsDir, dirName, 'agent-player.plugin.json');
          }

          if (!existsSync(manifestPath)) continue;

          const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

          // Get enabled state from DB
          const config = await q.one('SELECT enabled, config_json, installed_at FROM extension_configs WHERE extension_id = ?', manifest.id) as { enabled: number; config_json: string; installed_at: string } | undefined;

          extensions.push({
            id: manifest.id,
            name: manifest.name,
            description: manifest.description,
            version: manifest.version,
            type: manifest.type || (manifest.channels ? 'channel' : 'custom'),
            author: manifest.author || 'Unknown',
            enabled: config?.enabled === 1,
            installedAt: config?.installed_at || null,
            permissions: manifest.permissions || manifest.channels || [],
            settingsUI: manifest.settingsUI || undefined,
          });
        }
      }

      return {
        success: true,
        extensions,
        total: extensions.length,
        enabled: extensions.filter((e) => e.enabled).length,
      };
    } catch (error: any) {
      console.error('[Extensions API] ❌ List failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Extensions]');
    }
  });

  /**
   * POST /api/extensions/:id/enable - Enable an extension
   */
  fastify.post<{ Params: { id: string } }>('/api/extensions/:id/enable', {
    schema: {
      tags: ['Extensions'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      if (!extensionsAvailable()) return reply.code(409).send(EXTENSIONS_SQLITE_ONLY); // Q-33
      const extensionRunner = getExtensionRunner();

      await extensionRunner.enableExtension(id);

      return {
        success: true,
        message: `Extension "${id}" enabled. Restart backend to load routes.`,
        restartRequired: true,
      };
    } catch (error: any) {
      console.error('[Extensions API] ❌ Enable failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Extensions]');
    }
  });

  /**
   * POST /api/extensions/:id/disable - Disable an extension
   */
  fastify.post<{ Params: { id: string } }>('/api/extensions/:id/disable', {
    schema: {
      tags: ['Extensions'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const extensionRunner = getExtensionRunner();

      await extensionRunner.disableExtension(id);

      return {
        success: true,
        message: `Extension "${id}" disabled. Tools unregistered.`,
      };
    } catch (error: any) {
      console.error('[Extensions API] ❌ Disable failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Extensions]');
    }
  });

  /**
   * GET /api/extensions/:id/inspect - Get extension details (database, tools, routes, etc.)
   */
  fastify.get<{ Params: { id: string } }>('/api/extensions/:id/inspect', {
    schema: {
      tags: ['Extensions'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params;

      // 1. Get migrations history
      const migrations = await q.all('SELECT filename, ran_at FROM extension_migrations WHERE extension_id = ? ORDER BY ran_at DESC', id);

      // 2. Get config
      const configRow = await q.one('SELECT config_json FROM extension_configs WHERE extension_id = ?', id) as { config_json: string } | undefined;
      let config = configRow ? JSON.parse(configRow.config_json) : null;
      if (config && ['telegram', 'discord'].includes(id)) delete config.bot_token;
      if (config && id === 'agent-connect') delete config.channels;
      // SECURITY (S0-Q.4): never return secret config values in plaintext
      config = maskSecretFields(config);

      // 3. Get database tables (the database catalog: tables created by this extension)
      const allTables = (await sql().read(tableNames())).map((name) => ({ name }));

      // Filter tables that might belong to this extension (heuristic: contain extension id in name)
      const extensionTables = allTables.filter((t) =>
        t.name.toLowerCase().includes(id.replace('-', '_')) ||
        t.name.toLowerCase().includes(id.replace('_', ''))
      );

      // Get row count and column count for each table
      const tables: Array<{ name: string; rows: number; columns: number }> = [];
      for (const table of extensionTables) {
        // SECURITY: Validate table name before using in SQL
        const safeName = validateTableName(table.name);
        const rowCount = await q.one(`SELECT COUNT(*) as count FROM ${safeName}`) as { count: number };
        const columns = await sql().read(tableColumns(safeName));

        tables.push({
          name: table.name,
          rows: rowCount.count,
          columns: columns.length,
        });
      }

      // 4. Get registered tools (from extension tools global array)
      const extensionToolsList = getExtensionTools(id);
      const tools = extensionToolsList.map((t) => t.name);

      // 5. Get registered routes (inferred from extension ID)
      const routes = [`/api/ext/${id}/*`];

      return {
        success: true,
        data: {
          migrations,
          config,
          tables,
          tools,
          routes,
        },
      };
    } catch (error: any) {
      console.error('[Extensions API] ❌ Inspect failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Extensions]');
    }
  });

  /**
   * DELETE /api/extensions/:id - Delete an extension completely
   */
  fastify.delete<{ Params: { id: string } }>('/api/extensions/:id', {
    schema: {
      tags: ['Extensions'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params;

      // 1. Disable extension first (unregister tools, call onDisable)
      const extensionRunner = getExtensionRunner();
      await extensionRunner.disableExtension(id);

      // 2. Find and drop all extension tables
      const tables = (await sql().read(tableNames(id))).map((name) => ({ name }));

      for (const { name } of tables) {
        try {
          // SECURITY: Validate table name to prevent SQL injection
          const safeName = validateTableName(name);
          await q.run(`DROP TABLE IF EXISTS ${safeName}`);
          console.log(`[Extensions API] 🗑️  Dropped table: ${name}`);
        } catch (err) {
          console.warn(`[Extensions API] ⚠️  Failed to drop table ${name}:`, err);
        }
      }

      // 3. + 4. Delete extension config and migrations history (one transaction)
      await sql().tx(function* () {
        yield* run('DELETE FROM extension_configs WHERE extension_id = ?', id);
        yield* run('DELETE FROM extension_migrations WHERE extension_id = ?', id);
      });

      // 5. Delete extension storage files
      const { getStorageManager } = await import('../../services/storage-manager.js');
      const storageManager = getStorageManager();
      const storageFiles = await storageManager.search({
        zone: 'cdn',
        category: `extensions/${id}`,
        categoryTree: true, // FIX-STO-01: sub-category files too
        limit: 10000,
      });

      let deletedFiles = 0;
      for (const file of storageFiles) {
        await storageManager.delete(file.id);
        deletedFiles++;
      }

      // Also delete extension storage directory from disk
      const { uploadsPath } = await import('../../services/uploads.js');
      const extensionStorageDir = uploadsPath('extensions', id);
      if (existsSync(extensionStorageDir)) {
        const { rmSync } = await import('fs');
        rmSync(extensionStorageDir, { recursive: true, force: true });
      }

      console.log(`[Extensions API] 🗑️  Deleted ${deletedFiles} storage file(s)`);

      // 6. Delete extension directory
      const extensionPath = resolve(extensionsDir, id);
      if (existsSync(extensionPath)) {
        const { rmSync } = await import('fs');
        rmSync(extensionPath, { recursive: true, force: true });
      }

      return {
        success: true,
        message: `Extension "${id}" completely removed. Tables (${tables.length}), storage files (${deletedFiles}), config, migrations, and code deleted.`,
      };
    } catch (error: any) {
      console.error('[Extensions API] ❌ Delete failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Extensions]');
    }
  });

  /**
   * GET /api/extensions/:id/config - Get extension configuration
   */
  fastify.get<{ Params: { id: string } }>('/api/extensions/:id/config', {
    schema: {
      tags: ['Extensions'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params;

      const extension = await q.one('SELECT * FROM extension_configs WHERE extension_id = ?', id) as any;

      if (!extension) {
        return reply.status(404).send({
          success: false,
          error: 'Extension not found',
        });
      }

      const config = extension.config_json ? JSON.parse(extension.config_json) : {};
      if (id === 'agent-connect') return { success: true, config: {}, channels: Object.keys(config.channels || {}) };
      if (['telegram', 'discord'].includes(id)) {
        const hasToken = Boolean(config.bot_token);
        delete config.bot_token;
        return { success: true, config: maskSecretFields(config), hasToken };
      }

      return {
        success: true,
        // SECURITY (S0-Q.4): secret-looking keys are masked; a masked value sent
        // back on PUT keeps the stored secret.
        config: maskSecretFields(config),
      };
    } catch (error: any) {
      console.error('[Extensions API] ❌ Get config failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Extensions]');
    }
  });

  /**
   * Validate extension config against manifest schema
   */
  function validateExtensionConfig(
    manifest: any,
    config: Record<string, any>
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // For ui-web4 spec format
    if (manifest.settings?.type === 'ui-web4') {
      const components = manifest.settings.spec?.components || [];
      components.forEach((comp: any) => {
        if (comp.required && !config[comp.id]) {
          errors.push(`${comp.label || comp.id} is required`);
        }
      });
    }

    // For settingsUI form schema format
    if (manifest.settingsUI?.type === 'form') {
      manifest.settingsUI.fields.forEach((field: any) => {
        if (field.required && !config[field.name]) {
          errors.push(`${field.label} is required`);
        }
      });
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * PUT /api/extensions/:id/config - Update extension configuration
   */
  fastify.put<{ Params: { id: string }; Body: { config: Record<string, any> } }>('/api/extensions/:id/config', {
    schema: {
      tags: ['Extensions'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          config: { type: 'object' },
        },
        required: ['config'],
      },
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      let { config } = request.body;
      if (['telegram', 'discord', 'agent-connect'].includes(id)) {
        return reply.code(409).send({ error: 'Save channel settings through /api/ext/' + id + '/config. Enable the extension and restart the backend first.' });
      }

      // Check if extension exists
      const extension = await q.one('SELECT * FROM extension_configs WHERE extension_id = ?', id) as any;

      if (!extension) {
        return reply.status(404).send({
          success: false,
          error: 'Extension not found',
        });
      }

      // A masked secret echoed back by the UI keeps the stored value
      let storedConfig: Record<string, any> = {};
      try { storedConfig = extension.config_json ? JSON.parse(extension.config_json) : {}; } catch { /* keep {} */ }
      config = restoreMaskedFields(config, storedConfig);

      // Validate config against manifest
      const manifestPath = join(extensionsDir, id, 'agentplayer.plugin.json');
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const validation = validateExtensionConfig(manifest, config);

        if (!validation.valid) {
          return reply.status(400).send({
            success: false,
            error: 'Validation failed',
            details: validation.errors,
          });
        }
      }

      // Update config
      await q.run('UPDATE extension_configs SET config_json = ? WHERE extension_id = ?', JSON.stringify(config), id);

      safeConsole.log(`[Extensions API] ✅ Config updated for ${id}`);

      return {
        success: true,
        message: 'Configuration saved successfully',
      };
    } catch (error: any) {
      console.error('[Extensions API] ❌ Update config failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Extensions]');
    }
  });

  /**
   * GET /api/extensions/enabled-routes - Get frontend routes from enabled extensions
   * Used by sidebar to dynamically show/hide extension pages
   */
  fastify.get('/api/extensions/enabled-routes', {
    schema: {
      tags: ['Extensions'],
      description: 'Get frontend routes from all enabled extensions',
    },
  }, async (request, reply) => {
    try {
      const routes = [];

      // Get all enabled extensions
      const enabledExtensions = await q.all('SELECT extension_id FROM extension_configs WHERE enabled = 1') as Array<{ extension_id: string }>;

      if (!enabledExtensions.length) {
        return {
          success: true,
          routes: [],
        };
      }

      // Read manifest for each enabled extension to get frontendRoutes
      for (const { extension_id } of enabledExtensions) {
        // Try both manifest filename formats
        let manifestPath = join(extensionsDir, extension_id, 'agentplayer.plugin.json');
        if (!existsSync(manifestPath)) {
          manifestPath = join(extensionsDir, extension_id, 'agent-player.plugin.json');
        }

        if (!existsSync(manifestPath)) continue;

        try {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

          // Add frontendRoutes if defined
          if (manifest.frontendRoutes && Array.isArray(manifest.frontendRoutes)) {
            for (const route of manifest.frontendRoutes) {
              routes.push({
                id: extension_id,
                name: route.name || manifest.name,
                href: route.path,
                icon: route.icon || 'Puzzle',
                position: route.position || 'main', // main, settings, developer
              });
            }
          }
        } catch (err) {
          console.error(`[Extensions API] ⚠️  Failed to read manifest for ${extension_id}:`, err);
        }
      }

      return {
        success: true,
        routes,
      };
    } catch (error: any) {
      console.error('[Extensions API] ❌ Get enabled routes failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Extensions]');
    }
  });

  /**
   * GET /api/extensions/:id/status - Check if extension is enabled
   * Used by frontend catch-all route to determine if page should load
   */
  fastify.get('/api/extensions/:id/status', {
    schema: {
      tags: ['Extensions'],
      description: 'Check if an extension is currently enabled',
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };

      const config = await q.one('SELECT enabled FROM extension_configs WHERE extension_id = ?', id) as { enabled: number } | undefined;

      return {
        success: true,
        extensionId: id,
        enabled: config?.enabled === 1,
      };
    } catch (error: any) {
      safeConsole.error(`[Extensions API] ❌ Get status failed for ${(request.params as any).id}:`, error);
      return handleError(reply, error, 'internal', '[Extensions]');
    }
  });

  /**
   * GET /api/extensions/:id/audit-logs - Get extension audit logs
   * Returns last 100 audit events for this extension
   */
  fastify.get<{ Params: { id: string } }>('/api/extensions/:id/audit-logs', {
    schema: {
      tags: ['Extensions'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params;

      // Query audit_logs table for extension events
      const logs = await q.all(`
        SELECT
          id,
          event_type,
          event_category,
          severity,
          action,
          resource_type,
          resource_id,
          success,
          error_message,
          metadata,
          created_at,
          ip_address,
          user_agent
        FROM audit_logs
        WHERE event_category = 'extension'
          AND resource_id = ?
        ORDER BY created_at DESC
        LIMIT 100
      `, id) as any[];

      // Parse metadata JSON
      const parsedLogs = logs.map((log) => ({
        ...log,
        success: log.success === 1,
        metadata: log.metadata ? JSON.parse(log.metadata) : null,
      }));

      return {
        success: true,
        logs: parsedLogs,
        total: parsedLogs.length,
      };
    } catch (error: any) {
      console.error('[Extensions API] ❌ Get audit logs failed:', error);
      return handleError(reply, error, 'internal', '[Extensions]');
    }
  });

  /**
   * GET /api/extensions/:id/analytics - Get extension analytics
   * Returns usage stats, performance metrics, and error tracking
   */
  fastify.get<{ Params: { id: string } }>('/api/extensions/:id/analytics', {
    schema: {
      tags: ['Extensions'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const { getExtensionAnalytics } = await import('../../services/extension-analytics.js');

      const analytics = await getExtensionAnalytics(id);

      return {
        success: true,
        analytics,
      };
    } catch (error: any) {
      console.error('[Extensions API] ❌ Get analytics failed:', error);
      return handleError(reply, error, 'internal', '[Extensions]');
    }
  });

  /**
   * GET /api/extensions/analytics/overview - Get overview analytics for all extensions
   * Returns aggregate stats across all extensions
   */
  fastify.get('/api/extensions/analytics/overview', {
    schema: {
      tags: ['Extensions'],
      description: 'Get analytics overview for all extensions',
    },
  }, async (request, reply) => {
    try {
      const { getOverviewAnalytics } = await import('../../services/extension-analytics.js');

      const overview = await getOverviewAnalytics();

      return {
        success: true,
        overview,
      };
    } catch (error: any) {
      console.error('[Extensions API] ❌ Get overview analytics failed:', error);
      return handleError(reply, error, 'internal', '[Extensions]');
    }
  });

  /**
   * GET /api/extensions/:extensionId/i18n/:locale
   * Returns translation JSON for a specific extension and locale.
   * Falls back to English if the requested locale is not available.
   * Used by frontend useExtensionTranslations() hook.
   */
  fastify.get('/api/extensions/:extensionId/i18n/:locale', {
    schema: {
      tags: ['Extensions'],
      description: 'Get translations for an extension in a specific locale',
      params: {
        type: 'object',
        properties: {
          extensionId: { type: 'string' },
          locale: { type: 'string' },
        },
        required: ['extensionId', 'locale'],
      },
    },
  }, async (request, reply) => {
    try {
      const { extensionId, locale } = request.params as { extensionId: string; locale: string };

      const extensionPath = join(extensionsDir, extensionId);
      let manifestPath = join(extensionPath, 'agentplayer.plugin.json');
      if (!existsSync(manifestPath)) {
        manifestPath = join(extensionPath, 'agent-player.plugin.json');
      }

      if (!existsSync(manifestPath)) {
        return reply.status(404).send({ error: 'Extension not found' });
      }

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const i18nDir = manifest.i18n?.dir || 'i18n';
      const localePath = join(extensionPath, i18nDir, `${locale}.json`);

      if (existsSync(localePath)) {
        return JSON.parse(readFileSync(localePath, 'utf-8'));
      }

      // Fall back to English
      const fallbackPath = join(extensionPath, i18nDir, 'en.json');
      if (existsSync(fallbackPath)) {
        return JSON.parse(readFileSync(fallbackPath, 'utf-8'));
      }

      // No translations available
      return {};
    } catch (error: any) {
      console.error('[Extensions API] ❌ Get i18n translations failed:', error);
      return handleError(reply, error, 'internal', '[Extensions]');
    }
  });

  console.log('[Extensions API] ✅ Routes registered');
}
