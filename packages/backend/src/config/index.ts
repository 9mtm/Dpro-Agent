/**
 * Backend Centralized Configuration
 * All backend routes and services should import from this file
 */

import { dataPathOr } from './data-root.js';
import { defaultOllamaApiUrl, defaultOllamaUrl } from './ollama-url.js';

export const config = {
  /**
   * Server Configuration
   */
  port: parseInt(process.env.PORT || '41522', 10),
  // SECURITY (S0-Q.1): loopback only unless HOST is set explicitly.
  host: process.env.HOST || '127.0.0.1',
  nodeEnv: process.env.NODE_ENV || 'development',

  /**
   * Frontend URL - configured via NEXT_PUBLIC_APP_URL in .env
   * Used for CORS, OAuth redirects, and embed URLs
   */
  frontendUrl: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:41521',

  /**
   * Database Configuration
   */
  databaseUrl: process.env.DATABASE_URL || 'file:./.data/agent-player.db',
  databasePath: process.env.DATABASE_PATH || dataPathOr('./.data/agent-player.db', 'agent-player.db'),

  /**
   * OAuth Redirect URIs
   */
  gmailRedirectUri: process.env.GMAIL_REDIRECT_URI || `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:41521'}/auth/gmail/callback`,
  outlookRedirectUri: process.env.OUTLOOK_REDIRECT_URI || `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:41521'}/auth/outlook/callback`,

  /**
   * Encryption & Security
   */
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  masterEncryptionKey: process.env.MASTER_ENCRYPTION_KEY || '',
  jwtSecret: process.env.JWT_SECRET || '',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

  /**
   * AI Providers
   */
  ai: {
    // Provider API keys are not kept here: read them through the credential
    // authority (credentials/authority.ts, S1.1).
    ollama: {
      url: defaultOllamaUrl(),
      apiUrl: defaultOllamaApiUrl(),
      modelName: process.env.DEFAULT_MODEL || process.env.LOCAL_MODEL_NAME || 'qwen3.5:9b',
      apiKey: process.env.LOCAL_MODEL_API_KEY || 'sk-dummy',
    },
  },

  /**
   * Storage Configuration
   */
  storage: {
    provider: process.env.STORAGE_PROVIDER || 'local',
    dataDir: dataPathOr('./.data'),
  },

  /**
   * Optional Channels
   */
  channels: {
    whatsappSessionPath: process.env.WHATSAPP_SESSION_PATH || dataPathOr('./.data/whatsapp-session', 'whatsapp-session'),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    discordBotToken: process.env.DISCORD_BOT_TOKEN || '',
  },
} as const;
