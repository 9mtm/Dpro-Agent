import { safeConsole } from '../../services/safe-error-log.js';
/**
 * Channels API Routes
 * Manage messaging channels
 */

import type { FastifyInstance } from 'fastify';
import { getChannelRegistry } from '../../channels/index.js';
import {
  WebChannelAdapter,
  createWhatsAppAdapter,
  createTelegramAdapter,
} from '../../channels/index.js';
import { handleError } from '../error-handler.js';

export async function channelsRoutes(fastify: FastifyInstance) {
  const channelRegistry = getChannelRegistry();

  // Initialize built-in channels
  await initializeBuiltInChannels(channelRegistry);

  // GET /api/channels - List all channels
  fastify.get('/api/channels', async (request, reply) => {
    try {
      const channels = channelRegistry.getAll();

      return {
        success: true,
        channels: channels.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          status: c.getStatus(),
          connected: c.isConnected(),
          config: c.getConfig(),
        })),
        stats: {
          total: channelRegistry.count(),
          connected: channelRegistry.countConnected(),
        },
      };
    } catch (error: any) {
      console.error('[Channels API] ❌ List failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Channels] List failed');
    }
  });

  // GET /api/channels/:id - Get channel details
  fastify.get<{ Params: { id: string } }>(
    '/api/channels/:id',
    async (request, reply) => {
      try {
        const { id } = request.params;
        const channel = channelRegistry.get(id);

        if (!channel) {
          return reply.status(404).send({
            success: false,
            error: 'Channel not found',
          });
        }

        return {
          success: true,
          channel: {
            id: channel.id,
            name: channel.name,
            type: channel.type,
            status: channel.getStatus(),
            connected: channel.isConnected(),
            config: channel.getConfig(),
          },
        };
      } catch (error: any) {
        console.error('[Channels API] ❌ Get failed:', error);
        // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
        return handleError(reply, error, 'internal', '[Channels] Get failed');
      }
    }
  );

  // POST /api/channels/:id/connect - Connect channel
  fastify.post<{ Params: { id: string } }>(
    '/api/channels/:id/connect',
    async (request, reply) => {
      try {
        const { id } = request.params;
        const channel = channelRegistry.get(id);

        if (!channel) {
          return reply.status(404).send({
            success: false,
            error: 'Channel not found',
          });
        }

        await channel.connect();

        return {
          success: true,
          message: `Channel ${channel.name} connected`,
        };
      } catch (error: any) {
        console.error('[Channels API] ❌ Connect failed:', error);
        // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
        return handleError(reply, error, 'internal', '[Channels] Connect failed');
      }
    }
  );

  // POST /api/channels/:id/disconnect - Disconnect channel
  fastify.post<{ Params: { id: string } }>(
    '/api/channels/:id/disconnect',
    async (request, reply) => {
      try {
        const { id } = request.params;
        const channel = channelRegistry.get(id);

        if (!channel) {
          return reply.status(404).send({
            success: false,
            error: 'Channel not found',
          });
        }

        await channel.disconnect();

        return {
          success: true,
          message: `Channel ${channel.name} disconnected`,
        };
      } catch (error: any) {
        console.error('[Channels API] ❌ Disconnect failed:', error);
        // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
        return handleError(reply, error, 'internal', '[Channels] Disconnect failed');
      }
    }
  );

  // PUT /api/channels/:id/config - Update channel configuration
  fastify.put<{
    Params: { id: string };
    Body: { config: any };
  }>('/api/channels/:id/config', async (request, reply) => {
    try {
      const { id } = request.params;
      const { config } = request.body;

      const channel = channelRegistry.get(id);

      if (!channel) {
        return reply.status(404).send({
          success: false,
          error: 'Channel not found',
        });
      }

      channel.updateConfig(config);

      return {
        success: true,
        message: `Channel ${channel.name} configuration updated`,
      };
    } catch (error: any) {
      console.error('[Channels API] ❌ Config update failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Channels] Config update failed');
    }
  });

  // POST /api/channels/:id/send - Send message through channel
  fastify.post<{
    Params: { id: string };
    Body: { to: string; content: string; options?: any };
  }>('/api/channels/:id/send', async (request, reply) => {
    try {
      const { id } = request.params;
      const { to, content, options } = request.body;

      await channelRegistry.sendMessage(id, { channelId: id, to, content, options });

      return {
        success: true,
        message: 'Message sent',
      };
    } catch (error: any) {
      safeConsole.error('[Channels API] ❌ Send failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Channels] Send message failed');
    }
  });

  // GET /api/channels/whatsapp/qr - Get WhatsApp QR code
  fastify.get('/api/channels/whatsapp/qr', async (request, reply) => {
    try {
      const whatsapp = channelRegistry.get('whatsapp');

      if (!whatsapp) {
        return reply.status(404).send({
          success: false,
          error: 'WhatsApp channel not found',
        });
      }

      // TODO: Get QR code from WhatsApp adapter
      // const qrCode = (whatsapp as WhatsAppAdapter).getQRCode();

      return {
        success: true,
        qrCode: null, // placeholder
      };
    } catch (error: any) {
      console.error('[Channels API] ❌ QR failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Channels] Get QR code failed');
    }
  });
}

/**
 * Initialize built-in channels
 */
async function initializeBuiltInChannels(registry: any): Promise<void> {
  console.log('[Channels] 🚀 Initializing built-in channels...');

  // 1. Web channel (always enabled)
  const webChannel = new WebChannelAdapter();
  registry.register(webChannel);
  await webChannel.connect();

  // 2. WhatsApp (if configured)
  // TODO: Check if WhatsApp is configured in settings
  // const whatsappChannel = createWhatsAppAdapter();
  // registry.register(whatsappChannel);

  // 3. Telegram (if configured)
  // TODO: Check if Telegram is configured in settings
  // const telegramChannel = createTelegramAdapter(process.env.TELEGRAM_BOT_TOKEN);
  // registry.register(telegramChannel);

  console.log('[Channels] ✅ Built-in channels initialized');
}
