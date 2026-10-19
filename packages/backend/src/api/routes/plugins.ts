import { safeConsole } from '../../services/safe-error-log.js';
/**
 * Plugins API Routes
 * Manage plugins and extensions
 */

import type { FastifyInstance } from 'fastify';
import { getPluginManager } from '../../plugins/index.js';
import { handleError } from '../error-handler.js';

export async function pluginsRoutes(fastify: FastifyInstance) {
  const pluginManager = getPluginManager();

  // GET /api/plugins - List all plugins
  fastify.get('/api/plugins', async (request, reply) => {
    try {
      const plugins = pluginManager.getAllPlugins();
      const stats = pluginManager.getStats();

      return {
        success: true,
        plugins: plugins.map((p) => ({
          id: p.id,
          name: p.name,
          version: p.version,
          type: p.type,
          enabled: p.enabled,
          settingsSchema: p.settingsSchema || [],
        })),
        stats,
      };
    } catch (error: any) {
      console.error('[Plugins API] ❌ List failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Plugins] List failed');
    }
  });

  // GET /api/plugins/:id - Get plugin details
  fastify.get<{ Params: { id: string } }>(
    '/api/plugins/:id',
    async (request, reply) => {
      try {
        const { id } = request.params;
        const plugin = pluginManager.getPlugin(id);

        if (!plugin) {
          return reply.status(404).send({
            success: false,
            error: 'Plugin not found',
          });
        }

        return {
          success: true,
          plugin: {
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            type: plugin.type,
            enabled: plugin.enabled,
            config: plugin.config,
            settingsSchema: plugin.settingsSchema || [],
          },
        };
      } catch (error: any) {
        console.error('[Plugins API] ❌ Get failed:', error);
        // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
        return handleError(reply, error, 'internal', '[Plugins] Get failed');
      }
    }
  );

  // POST /api/plugins/:id/enable - Enable a plugin
  fastify.post<{ Params: { id: string } }>(
    '/api/plugins/:id/enable',
    async (request, reply) => {
      try {
        const { id } = request.params;

        await pluginManager.enablePlugin(id);

        return {
          success: true,
          message: `Plugin ${id} enabled`,
        };
      } catch (error: any) {
        safeConsole.error('[Plugins API] ❌ Enable failed:', error);
        // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
        return handleError(reply, error, 'internal', '[Plugins] Enable failed');
      }
    }
  );

  // POST /api/plugins/:id/disable - Disable a plugin
  fastify.post<{ Params: { id: string } }>(
    '/api/plugins/:id/disable',
    async (request, reply) => {
      try {
        const { id } = request.params;

        await pluginManager.disablePlugin(id);

        return {
          success: true,
          message: `Plugin ${id} disabled`,
        };
      } catch (error: any) {
        safeConsole.error('[Plugins API] ❌ Disable failed:', error);
        // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
        return handleError(reply, error, 'internal', '[Plugins] Disable failed');
      }
    }
  );

  // POST /api/plugins/:id/reload - Reload a plugin
  fastify.post<{ Params: { id: string } }>(
    '/api/plugins/:id/reload',
    async (request, reply) => {
      try {
        const { id } = request.params;

        await pluginManager.reloadPlugin(id);

        return {
          success: true,
          message: `Plugin ${id} reloaded`,
        };
      } catch (error: any) {
        safeConsole.error('[Plugins API] ❌ Reload failed:', error);
        // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
        return handleError(reply, error, 'internal', '[Plugins] Reload failed');
      }
    }
  );

  // DELETE /api/plugins/:id - Uninstall a plugin
  fastify.delete<{ Params: { id: string } }>(
    '/api/plugins/:id',
    async (request, reply) => {
      try {
        const { id } = request.params;

        await pluginManager.unloadPlugin(id);

        return {
          success: true,
          message: `Plugin ${id} uninstalled`,
        };
      } catch (error: any) {
        safeConsole.error('[Plugins API] ❌ Uninstall failed:', error);
        // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
        return handleError(reply, error, 'internal', '[Plugins] Uninstall failed');
      }
    }
  );

  // GET /api/plugins/stats - Get plugin statistics
  fastify.get('/api/plugins/stats', async (request, reply) => {
    try {
      const stats = pluginManager.getStats();

      return {
        success: true,
        stats,
      };
    } catch (error: any) {
      console.error('[Plugins API] ❌ Stats failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Plugins] Get stats failed');
    }
  });
}
