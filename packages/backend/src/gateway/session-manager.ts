import { safeConsole } from '../services/safe-error-log.js';
/**
 * Session Manager
 *
 * Manages shared sessions across all interfaces
 */

import { backgroundEnabled } from '../config/background.js';
import { dataPathOr } from '../config/data-root.js';
import { randomUUID } from 'crypto';
// TEMPORARY: Using in-memory database until better-sqlite3 build issues are resolved on Windows
import TempDatabase from '../db/temp-db.js';
import path from 'path';
import fs from 'fs';
import type { SharedSession, ChannelType } from './types.js';

export class SessionManager {
  private db!: any; // Will be initialized in initialize()
  private sessions: Map<string, SharedSession> = new Map();
  private sessionTimeout: number;

  constructor(
    private storageDir: string = dataPathOr('./.data/gateway', 'gateway'),
    sessionTimeout: number = 3600000 // 1 hour default
  ) {
    this.sessionTimeout = sessionTimeout;
  }

  /**
   * Initialize session manager
   */
  async initialize(): Promise<void> {
    // Ensure storage directory exists
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }

    // Initialize SQLite database (temporary in-memory solution)
    const dbPath = path.join(this.storageDir, 'sessions.db');
    this.db = new TempDatabase(dbPath);

    // Create sessions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        active_channels TEXT NOT NULL,
        last_active_channel TEXT,
        conversation_history TEXT,
        context TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity_at);
    `);

    // Load active sessions into memory
    await this.loadActiveSessions();

    // Start cleanup interval
    this.startCleanupInterval();

    console.log('[SessionManager] ✅ Initialized');
  }

  /**
   * Get or create session for user
   */
  async getSession(userId: string): Promise<SharedSession> {
    // Check in-memory cache first
    const cached = Array.from(this.sessions.values()).find(
      (s) => s.userId === userId
    );

    if (cached) {
      // Update last activity
      cached.lastActivityAt = new Date();
      await this.updateSession(cached);
      return cached;
    }

    // Check database
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_activity_at DESC LIMIT 1')
      .get(userId) as any;

    if (row) {
      const session = this.deserializeSession(row);
      this.sessions.set(session.sessionId, session);
      return session;
    }

    // Create new session
    return await this.createSession(userId);
  }

  /**
   * Create new session
   */
  private async createSession(userId: string): Promise<SharedSession> {
    const session: SharedSession = {
      userId,
      sessionId: randomUUID(),
      activeChannels: [],
      lastActiveChannel: 'web' as ChannelType,
      conversationHistory: [],
      context: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      lastActivityAt: new Date()
    };

    // Save to database
    await this.saveSession(session);

    // Cache in memory
    this.sessions.set(session.sessionId, session);

    safeConsole.log(`[SessionManager] Created session ${session.sessionId} for user ${userId}`);

    return session;
  }

  /**
   * Update session
   */
  async updateSession(session: SharedSession): Promise<void> {
    session.updatedAt = new Date();
    session.lastActivityAt = new Date();

    // Update in memory
    this.sessions.set(session.sessionId, session);

    // Update in database
    await this.saveSession(session);
  }

  /**
   * Register channel activity
   */
  async registerChannelActivity(
    sessionId: string,
    channelId: ChannelType
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Add channel if not already active
    if (!session.activeChannels.includes(channelId)) {
      session.activeChannels.push(channelId);
    }

    // Update last active channel
    session.lastActiveChannel = channelId;

    await this.updateSession(session);
  }

  /**
   * Add message to conversation history
   */
  async addMessage(
    sessionId: string,
    role: 'user' | 'agent',
    content: string,
    channelId: ChannelType
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.conversationHistory.push({
      role,
      content,
      channelId,
      timestamp: Date.now()
    });

    // Limit history size (keep last 100 messages)
    if (session.conversationHistory.length > 100) {
      session.conversationHistory = session.conversationHistory.slice(-100);
    }

    await this.updateSession(session);
  }

  /**
   * Get conversation history for session
   */
  getHistory(sessionId: string, limit?: number): Array<any> {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    const history = session.conversationHistory;
    return limit ? history.slice(-limit) : history;
  }

  /**
   * Save session to database
   */
  private async saveSession(session: SharedSession): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sessions (
          session_id, user_id, active_channels, last_active_channel,
          conversation_history, context, created_at, updated_at, last_activity_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.sessionId,
        session.userId,
        JSON.stringify(session.activeChannels),
        session.lastActiveChannel,
        JSON.stringify(session.conversationHistory),
        JSON.stringify(session.context),
        session.createdAt.getTime(),
        session.updatedAt.getTime(),
        session.lastActivityAt.getTime()
      );
  }

  /**
   * Load active sessions from database
   */
  private async loadActiveSessions(): Promise<void> {
    const cutoff = Date.now() - this.sessionTimeout;

    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE last_activity_at > ?')
      .all(cutoff) as any[];

    for (const row of rows) {
      const session = this.deserializeSession(row);
      this.sessions.set(session.sessionId, session);
    }

    console.log(`[SessionManager] Loaded ${rows.length} active sessions`);
  }

  /**
   * Deserialize session from database row
   */
  private deserializeSession(row: any): SharedSession {
    return {
      sessionId: row.session_id,
      userId: row.user_id,
      activeChannels: JSON.parse(row.active_channels),
      lastActiveChannel: row.last_active_channel,
      conversationHistory: JSON.parse(row.conversation_history || '[]'),
      context: JSON.parse(row.context || '{}'),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      lastActivityAt: new Date(row.last_activity_at)
    };
  }

  /**
   * Cleanup expired sessions
   */
  private startCleanupInterval(): void {
    // RUN-ISO F2: no cleanup timer with AGENT_PLAYER_BACKGROUND=off.
    if (!backgroundEnabled()) return;
    setInterval(() => {
      this.cleanup();
    }, 300000); // Every 5 minutes
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.sessionTimeout;

    // Remove from memory
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.lastActivityAt.getTime() < cutoff) {
        this.sessions.delete(sessionId);
      }
    }

    // Remove from database
    const deleted = this.db
      .prepare('DELETE FROM sessions WHERE last_activity_at < ?')
      .run(cutoff);

    if (deleted.changes > 0) {
      console.log(`[SessionManager] Cleaned up ${deleted.changes} expired sessions`);
    }
  }

  /**
   * Shutdown
   */
  async shutdown(): Promise<void> {
    // Save all in-memory sessions
    for (const session of this.sessions.values()) {
      await this.saveSession(session);
    }

    this.db.close();
    console.log('[SessionManager] Shutdown complete');
  }
}

// Singleton instance
let sessionManager: SessionManager | null = null;

export function getSessionManager(
  storageDir?: string,
  sessionTimeout?: number
): SessionManager {
  if (!sessionManager) {
    sessionManager = new SessionManager(storageDir, sessionTimeout);
  }
  return sessionManager;
}
