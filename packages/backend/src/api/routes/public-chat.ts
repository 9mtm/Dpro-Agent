/**
 * Public Chat Rooms API Routes
 * Multi-user chat rooms with AI agents, customizable avatars, and embeddable widgets
 *
 * B2.2c: every query runs on the process driver (sql-steps); SQLite SQL and
 * row shapes unchanged. A message and its room counter are one transaction;
 * owner checks and their writes run in one transaction with the room row
 * locked on PostgreSQL; joining a room is one transaction under a per-room
 * lock (no duplicate participant, no double count). Messages with the same
 * created_at second keep insertion order on SQLite (rowid); PostgreSQL
 * breaks the tie by id, which is time-ordered (orderedId, a UUIDv7). The
 * S0-A.14 outsider-memory rule and the Q-14
 * anonymous-room rule are unchanged.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { dialect, lockName, one, q, run, sql, type Step } from '../../repositories/sql-steps.js';
import { forUpdate, greatest } from '../../db/pg/dialect.js';
import { orderedId } from '../../repositories/ordered-id.js';
import { getUserIdFromRequest } from '../../auth/jwt.js';
import { randomUUID } from 'crypto';
import { readPersonality, readMemory } from '../../services/agent-files.js';
import { outsiderAgentMemoryEnabled } from '../../services/outsider-memory.js';
import { handleError } from '../error-handler.js';
import { DEFAULT_OLLAMA_MODEL, OLLAMA_URL } from '../../llm/ollama.js';
import { resolveLocalModel } from '../../llm/local-models.js';
import { modelCall } from '../../llm/model-call.js';
import { resolveProviderApiKey } from '../../credentials/authority.js';
import { anonymousChatLimiter } from '../public-chat-limits.js';
import { anonymousPublicRoomsEnabled } from '../../services/public-rooms.js';

interface PublicChatRoom {
  id: string;
  name: string;
  description: string | null;
  owner_user_id: string;
  model: string;
  system_prompt: string | null;
  agent_id: string | null;
  workflow_id: string | null;
  skills: string | null;
  avatar_url: string | null;
  avatar_gender: string;
  bg_color: string;
  bg_scene: string;
  wall_text: string | null;
  wall_logo_url: string | null;
  wall_video_url: string | null;
  wall_layout: string | null;
  fx_state: string | null;
  is_public: number;
  require_auth: number;
  allowed_users: string | null;
  max_message_length: number;
  rate_limit_seconds: number;
  enable_voice: number;
  enable_avatar: number;
  enable_developer_mode: number;
  embed_enabled: number;
  embed_size: string;
  embed_theme: string;
  message_count: number;
  participant_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * Check if user can access room
 */
function canAccessRoom(room: PublicChatRoom, userId?: string, role?: string): boolean {
  // Q-13 (CL-06): guest accounts may use public rooms only, never private ones.
  if (role === 'guest') return !!room.is_public;

  // Public room without auth requirement
  if (room.is_public && !room.require_auth) return true;

  // Public room with auth requirement
  if (room.is_public && room.require_auth && userId) return true;

  // Private room
  if (!room.is_public && userId) {
    const allowedUsers = room.allowed_users ? JSON.parse(room.allowed_users) : [];
    return room.owner_user_id === userId || allowedUsers.includes(userId);
  }

  return false;
}

/**
 * Get user ID (optional - may be null for anonymous users)
 */
function getOptionalUserId(request: FastifyRequest): string | null {
  try {
    return getUserIdFromRequest(request);
  } catch {
    return null;
  }
}

/**
 * Stream AI response for public chat room
 */
async function streamPublicChatResponse(
  reply: FastifyReply,
  room: PublicChatRoom,
  roomId: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  systemPrompt: string,
  userId: string | null,
  displayName: string
) {
  // Set up SSE headers
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  let fullResponse = '';
  const assistantMessageId = orderedId();

  try {
    // R2.3 (Q-32d): a room reply is never the owner's own chat (visitors,
    // members, guests, and the owner in a shared room all count), so it takes
    // the budget-gated background path, purpose `public_room`: the free local
    // model by default; a paid model provider only when the owner listed
    // `public_room` in BACKGROUND_PAID_PURPOSES and the daily paid cap
    // (DAILY_PAID_CAP_CENTS, default 0) allows the reservation. A refusal
    // falls back to the local model. Rate limits (S0-A.10, CL-06) run before.
    const paidModel = /^(claude|gpt|gemini|o\d)/i.test(room.model);
    let answered = false;
    if (/^claude/i.test(room.model)) {
      const apiKey = await resolveProviderApiKey('claude', { agentId: room.agent_id ?? undefined, allowEnv: true });
      if (apiKey) {
        const r = await modelCall({ actor: userId ?? 'anonymous' }, {
          purpose: 'public_room',
          prompt: '',
          messages: history,
          system: systemPrompt,
          maxOutputTokens: 4096,
          paid: { provider: 'claude', model: room.model, apiKey },
          noLocal: true, // the local model streams below
        });
        if (r.paid && !r.ok) throw new Error(r.error || 'paid model call failed');
        if (r.paid && r.ok) {
          fullResponse = r.text;
          reply.raw.write(`data: ${JSON.stringify({ type: 'content', content: r.text })}\n\n`);
          answered = true;
        }
      }
    }

    if (!answered) {
      // Local Ollama streaming. A room set to a paid model that was not
      // allowed (or has no key) is answered by the default local model.
      const ollamaMessages = [
        { role: 'system', content: systemPrompt },
        ...history,
      ];

      const localModel = await resolveLocalModel(paidModel ? DEFAULT_OLLAMA_MODEL : room.model, DEFAULT_OLLAMA_MODEL);
      const response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: localModel,
          messages: ollamaMessages,
          stream: true,
        }),
      });

      if (!response.ok) {
        throw new Error('Ollama request failed');
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split('\n').filter(Boolean);

          for (const line of lines) {
            try {
              const json = JSON.parse(line);
              if (json.message?.content) {
                const text = json.message.content;
                fullResponse += text;
                reply.raw.write(`data: ${JSON.stringify({ type: 'content', content: text })}\n\n`);
              }
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }
    }

    // Store AI response and update the message count (one transaction)
    await sql().tx(function* () {
      yield* run(`
      INSERT INTO public_chat_messages (id, room_id, user_id, username, role, content)
      VALUES (?, ?, ?, ?, 'assistant', ?)
    `, assistantMessageId, roomId, null, 'AI', fullResponse);
      yield* run('UPDATE public_chat_rooms SET message_count = message_count + 1 WHERE id = ?', roomId);
    });

    // Send completion event
    reply.raw.write(`data: ${JSON.stringify({ type: 'done', messageId: assistantMessageId })}\n\n`);
  } catch (error: any) {
    // SECURITY: Don't expose error details in SSE stream (H-09)
    console.error('[PublicChat] Streaming error:', error);
    reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: 'Chat request failed' })}\n\n`);
  } finally {
    reply.raw.end();
  }
}

/** ORDER BY created_at for messages; PostgreSQL adds the id as the tie-break (SQLite: rowid order). */
function msgOrder(dir: 'ASC' | 'DESC'): string {
  return q.dialect === 'postgres' ? `created_at ${dir}, id ${dir}` : `created_at ${dir}`;
}

type Refusal = { status: 403 | 404; error: string };

/** The room row, locked for the rest of the transaction (PostgreSQL). */
function* lockedRoom(id: string): Step<PublicChatRoom | undefined> {
  const d = yield* dialect();
  return yield* one<PublicChatRoom>(`SELECT * FROM public_chat_rooms WHERE id = ?${forUpdate(d)}`, id);
}

export async function registerPublicChatRoutes(fastify: FastifyInstance) {
  // ══════════════════════════════════════════════════════════════════════════════
  // Room Management
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * GET /api/public-chat/policy (BE-UI-01) - read-only public-room policy for
   * signed-in users (guests included): whether anonymous visitors may use
   * public rooms (owner setting `publicRooms.allowAnonymous`, default off)
   * and the default visibility of new rooms. Changing it stays owner-only
   * through PUT /api/settings.
   */
  fastify.get('/api/public-chat/policy', async (request, reply) => {
    if (!request.authUser) return reply.code(401).send({ error: 'Authentication required' });
    return {
      publicRooms: {
        allowAnonymous: await anonymousPublicRoomsEnabled(),
        newRoomsPublicByDefault: false,
      },
    };
  });

  /**
   * POST /api/public-chat/rooms
   * Create new chat room (auth required)
   */
  fastify.post('/api/public-chat/rooms', async (request, reply) => {
    try {
      const userId = getUserIdFromRequest(request);
      const body = request.body as any;

      const roomId = randomUUID();
      const now = new Date().toISOString();

      const room = await sql().tx(function* () {
      yield* run(`
        INSERT INTO public_chat_rooms (
          id, name, description, owner_user_id,
          model, system_prompt, agent_id, workflow_id, skills,
          avatar_url, avatar_gender, bg_color, bg_scene,
          wall_text, wall_logo_url, wall_video_url, wall_layout, fx_state,
          is_public, require_auth, allowed_users,
          max_message_length, rate_limit_seconds,
          enable_voice, enable_avatar, enable_developer_mode,
          embed_enabled, embed_size, embed_theme,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?
        )
      `, roomId,
        body.name,
        body.description || null,
        userId,
        body.model || 'claude-sonnet-4.5',
        body.system_prompt || null,
        body.agent_id || null,
        body.workflow_id || null,
        body.skills ? JSON.stringify(body.skills) : null,
        body.avatar_url || null,
        body.avatar_gender || 'female',
        body.bg_color || '#09090b',
        body.bg_scene || 'none',
        body.wall_text || null,
        body.wall_logo_url || null,
        body.wall_video_url || null,
        body.wall_layout ? JSON.stringify(body.wall_layout) : null,
        body.fx_state ? JSON.stringify(body.fx_state) : null,
        // BE-UI-01: new rooms are private unless the creator asks for public.
        body.is_public !== undefined ? (body.is_public ? 1 : 0) : 0,
        body.require_auth ? 1 : 0,
        body.allowed_users ? JSON.stringify(body.allowed_users) : null,
        body.max_message_length || 1000,
        body.rate_limit_seconds !== undefined ? body.rate_limit_seconds : 5,
        body.enable_voice !== undefined ? (body.enable_voice ? 1 : 0) : 1,
        body.enable_avatar !== undefined ? (body.enable_avatar ? 1 : 0) : 1,
        body.enable_developer_mode ? 1 : 0,
        body.embed_enabled !== undefined ? (body.embed_enabled ? 1 : 0) : 1,
        body.embed_size || 'medium',
        body.embed_theme || 'auto',
        now,
        now);
      return yield* one('SELECT * FROM public_chat_rooms WHERE id = ?', roomId);
      });

      return { success: true, room };
    } catch (error: any) {
      if (error.message?.includes('Unauthorized')) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[PublicChat] Operation failed');
    }
  });

  /**
   * GET /api/public-chat/rooms
   * List all public rooms (or user's rooms if filter=my)
   */
  fastify.get('/api/public-chat/rooms', async (request, reply) => {
    const { filter } = request.query as { filter?: string };
    const userId = getOptionalUserId(request);

    let rooms: PublicChatRoom[];

    if (filter === 'my' && userId && request.authUser?.role !== 'guest') {
      // User's rooms
      rooms = await q.all(`
        SELECT * FROM public_chat_rooms
        WHERE owner_user_id = ?
        ORDER BY created_at DESC
      `, userId) as PublicChatRoom[];
    } else {
      // All public rooms
      rooms = await q.all(`
        SELECT * FROM public_chat_rooms
        WHERE is_public = 1
        ORDER BY created_at DESC
      `) as PublicChatRoom[];
    }

    return { rooms };
  });

  /**
   * GET /api/public-chat/rooms/:id
   * Get room details (for joining)
   */
  fastify.get('/api/public-chat/rooms/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = getOptionalUserId(request);

    // Q-14 (CL-07): anonymous visitors only when the owner turned it on.
    if (!userId && !(await anonymousPublicRoomsEnabled())) return reply.code(404).send({ error: 'Room not found' });

    const room = await q.one('SELECT * FROM public_chat_rooms WHERE id = ?', id) as PublicChatRoom | undefined;

    if (!room) {
      return reply.code(404).send({ error: 'Room not found' });
    }

    // Check access
    if (!canAccessRoom(room, userId || undefined, request.authUser?.role)) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    return { room };
  });

  /**
   * PUT /api/public-chat/rooms/:id
   * Update room settings (owner only)
   */
  fastify.put('/api/public-chat/rooms/:id', async (request, reply) => {
    try {
      const userId = getUserIdFromRequest(request);
      const { id } = request.params as { id: string };
      const body = request.body as any;

      const updates: string[] = [];
      const values: any[] = [];

      // Build dynamic UPDATE query
      const fields = [
        'name', 'description', 'model', 'system_prompt', 'agent_id', 'workflow_id', 'skills',
        'avatar_url', 'avatar_gender', 'bg_color', 'bg_scene',
        'wall_text', 'wall_logo_url', 'wall_video_url', 'wall_layout', 'fx_state',
        'is_public', 'require_auth', 'allowed_users',
        'max_message_length', 'rate_limit_seconds',
        'enable_voice', 'enable_avatar', 'enable_developer_mode',
        'embed_enabled', 'embed_size', 'embed_theme'
      ];

      for (const field of fields) {
        if (body[field] !== undefined) {
          updates.push(`${field} = ?`);

          // Handle JSON fields
          if (['skills', 'allowed_users', 'wall_layout', 'fx_state'].includes(field) && typeof body[field] === 'object') {
            values.push(JSON.stringify(body[field]));
          }
          // Handle boolean fields
          else if (['is_public', 'require_auth', 'enable_voice', 'enable_avatar', 'enable_developer_mode', 'embed_enabled'].includes(field)) {
            values.push(body[field] ? 1 : 0);
          }
          // Regular fields
          else {
            values.push(body[field]);
          }
        }
      }

      if (updates.length > 0) {
        updates.push('updated_at = ?');
        values.push(new Date().toISOString());
        values.push(id);
      }

      // One transaction: the owner check on the locked row, the update, the read-back.
      const out = await sql().tx(function* (): Step<Refusal | { status: 200; room: unknown }> {
        const room = yield* lockedRoom(id);
        if (!room) return { status: 404, error: 'Room not found' };
        if (room.owner_user_id !== userId) return { status: 403, error: 'Only room owner can update settings' };
        if (updates.length > 0) {
          yield* run(`
          UPDATE public_chat_rooms
          SET ${updates.join(', ')}
          WHERE id = ?
        `, ...values);
        }
        return { status: 200, room: yield* one('SELECT * FROM public_chat_rooms WHERE id = ?', id) };
      });
      if (out.status !== 200) return reply.code(out.status).send({ error: out.error });

      return { success: true, room: out.room };
    } catch (error: any) {
      if (error.message?.includes('Unauthorized')) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[PublicChat] Operation failed');
    }
  });

  /**
   * DELETE /api/public-chat/rooms/:id
   * Delete room (owner only)
   */
  fastify.delete('/api/public-chat/rooms/:id', async (request, reply) => {
    try {
      const userId = getUserIdFromRequest(request);
      const { id } = request.params as { id: string };

      const out = await sql().tx(function* (): Step<Refusal | { status: 200 }> {
        const room = yield* lockedRoom(id);
        if (!room) return { status: 404, error: 'Room not found' };
        if (room.owner_user_id !== userId) return { status: 403, error: 'Only room owner can delete room' };
        // Delete room (CASCADE will delete messages and participants)
        yield* run('DELETE FROM public_chat_rooms WHERE id = ?', id);
        return { status: 200 };
      });
      if (out.status !== 200) return reply.code(out.status).send({ error: out.error });

      return { success: true };
    } catch (error: any) {
      if (error.message?.includes('Unauthorized')) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[PublicChat] Operation failed');
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Chat Messages
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * GET /api/public-chat/rooms/:id/messages
   * Get room messages (paginated)
   */
  fastify.get('/api/public-chat/rooms/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { limit = 50, offset = 0 } = request.query as { limit?: number; offset?: number };
    const userId = getOptionalUserId(request);

    // Q-14 (CL-07): anonymous visitors only when the owner turned it on.
    if (!userId && !(await anonymousPublicRoomsEnabled())) return reply.code(404).send({ error: 'Room not found' });

    const room = await q.one('SELECT * FROM public_chat_rooms WHERE id = ?', id) as PublicChatRoom | undefined;

    if (!room) {
      return reply.code(404).send({ error: 'Room not found' });
    }

    if (!canAccessRoom(room, userId || undefined, request.authUser?.role)) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    const messages = await q.all(`
      SELECT * FROM public_chat_messages
      WHERE room_id = ?
      ORDER BY ${msgOrder('ASC')}
      LIMIT ? OFFSET ?
    `, id, limit, offset);

    return { messages };
  });

  /**
   * POST /api/public-chat/rooms/:id/messages
   * Send message (SSE streaming AI response)
   */
  fastify.post('/api/public-chat/rooms/:id/messages', async (request, reply) => {
    const { id: roomId } = request.params as { id: string };
    const { content, username } = request.body as { content: string; username?: string };
    const userId = getOptionalUserId(request);

    // Q-14 (CL-07): anonymous visitors only when the owner turned it on.
    if (!userId && !(await anonymousPublicRoomsEnabled())) return reply.code(404).send({ error: 'Room not found' });

    const room = await q.one('SELECT * FROM public_chat_rooms WHERE id = ?', roomId) as PublicChatRoom | undefined;

    if (!room) {
      return reply.code(404).send({ error: 'Room not found' });
    }

    if (!canAccessRoom(room, userId || undefined, request.authUser?.role)) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    if (typeof content !== 'string' || content.trim().length === 0) {
      return reply.code(400).send({ error: 'Message content is required' });
    }

    // SECURITY (S0-A.10): anonymous messages make the agent answer on the
    // owner's model keys -> per-IP, per-room and daily limits. Guest accounts
    // (public rooms only, CL-06) get the same limits, keyed by IP + user id.
    const isGuest = request.authUser?.role === 'guest';
    if (!userId || isGuest) {
      const retryAfter = anonymousChatLimiter.check(`${request.ip}:${userId ?? ''}`, roomId);
      if (retryAfter !== null) {
        return reply.code(429).header('Retry-After', String(retryAfter))
          .send({ error: 'Too many messages, please wait and try again' });
      }
    }

    // Validate message length
    if (content.length > room.max_message_length) {
      return reply.code(400).send({
        error: `Message too long (max ${room.max_message_length} characters)`
      });
    }

    // Get username
    const displayName = userId
      ? (await q.one('SELECT COALESCE(full_name, username) AS name FROM users WHERE id = ?', userId) as any)?.name || 'User'
      : (username || 'Anonymous');

    // Store user message
    const userMessageId = orderedId();
    // The message and the room's message count: one transaction.
    await sql().tx(function* () {
      yield* run(`
      INSERT INTO public_chat_messages (id, room_id, user_id, username, role, content)
      VALUES (?, ?, ?, ?, 'user', ?)
    `, userMessageId, roomId, userId || null, displayName, content);
      yield* run('UPDATE public_chat_rooms SET message_count = message_count + 1 WHERE id = ?', roomId);
    });

    // Get recent message history (last 20 messages)
    const recentMessages = await q.all(`
      SELECT * FROM public_chat_messages
      WHERE room_id = ?
      ORDER BY ${msgOrder('DESC')}
      LIMIT 20
    `, roomId) as any[];

    // Build conversation history (reverse to chronological order)
    const history = recentMessages.reverse().map(msg => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    }));

    // SECURITY (S0-A.14): the agent's MEMORY.md is the owner's private data.
    // Only the room owner, when allowed to read agent memory anyway (owner or
    // admin role), gets it in the prompt; anonymous and other visitors do not,
    // unless the server opts in (OUTSIDER_AGENT_MEMORY=true).
    const senderRole = userId
      ? (await q.one('SELECT role FROM users WHERE id = ?', userId) as { role?: string } | undefined)?.role
      : undefined;
    const senderIsOwner = !!userId && userId === room.owner_user_id && (senderRole === 'owner' || senderRole === 'admin');
    const includeAgentMemory = senderIsOwner || outsiderAgentMemoryEnabled();

    // Load agent files if agent is configured
    let personalityContent = '';
    let memoryContent = '';
    if (room.agent_id) {
      try {
        personalityContent = await readPersonality(room.agent_id);
        memoryContent = includeAgentMemory ? await readMemory(room.agent_id) : '';
      } catch {
        // No agent files, will use room system_prompt
      }
    }

    // Build system prompt (priority: room > agent PERSONALITY.md > default)
    const systemPrompt =
      room.system_prompt ||
      personalityContent ||
      'You are a helpful AI assistant in a public chat room.';

    // Add memory if available
    let fullSystemPrompt = systemPrompt;
    if (memoryContent) {
      fullSystemPrompt += `\n\n## Agent Memory\n${memoryContent}`;
    }

    // Stream AI response
    await streamPublicChatResponse(
      reply,
      room,
      roomId,
      history,
      fullSystemPrompt,
      userId || null,
      displayName
    );
  });

  /**
   * DELETE /api/public-chat/messages/:id
   * Delete message (owner/sender only)
   */
  fastify.delete('/api/public-chat/messages/:id', async (request, reply) => {
    try {
      const userId = getUserIdFromRequest(request);
      const { id } = request.params as { id: string };

      const out = await sql().tx(function* (): Step<Refusal | { status: 200 }> {
        const d = yield* dialect();
        const message = yield* one<any>(`SELECT * FROM public_chat_messages WHERE id = ?${forUpdate(d)}`, id);
        if (!message) return { status: 404, error: 'Message not found' };

        const room = yield* one<PublicChatRoom>('SELECT * FROM public_chat_rooms WHERE id = ?', message.room_id);

        // Only room owner or message sender can delete
        if (room!.owner_user_id !== userId && message.user_id !== userId) return { status: 403, error: 'Access denied' };

        yield* run('DELETE FROM public_chat_messages WHERE id = ?', id);
        return { status: 200 };
      });
      if (out.status !== 200) return reply.code(out.status).send({ error: out.error });

      return { success: true };
    } catch (error: any) {
      if (error.message?.includes('Unauthorized')) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[PublicChat] Operation failed');
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Participants
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * POST /api/public-chat/rooms/:id/join
   * Join room (returns participant info)
   */
  fastify.post('/api/public-chat/rooms/:id/join', async (request, reply) => {
    const { id: roomId } = request.params as { id: string };
    const { username } = request.body as { username?: string };
    const userId = getOptionalUserId(request);

    // Q-14 (CL-07): anonymous visitors only when the owner turned it on.
    if (!userId && !(await anonymousPublicRoomsEnabled())) return reply.code(404).send({ error: 'Room not found' });

    const room = await q.one('SELECT * FROM public_chat_rooms WHERE id = ?', roomId) as PublicChatRoom | undefined;

    if (!room) {
      return reply.code(404).send({ error: 'Room not found' });
    }

    if (!canAccessRoom(room, userId || undefined, request.authUser?.role)) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    // Get display name
    let displayName = username || 'Anonymous';
    if (userId) {
      const user = await q.one('SELECT full_name, username FROM users WHERE id = ?', userId) as any;
      displayName = user?.full_name || user?.username || 'User';
    }

    // One transaction under a per-room lock: the "already joined" check and
    // the insert + count never interleave with another join of this room.
    const participantId = randomUUID();
    const joined = await sql().tx(function* (): Step<{ existing: boolean; participant: unknown }> {
      yield* lockName(`public_chat_participants:${roomId}`);
      // Check if already joined
      const existing = yield* one<any>(`
      SELECT * FROM public_chat_participants
      WHERE room_id = ? AND (user_id = ? OR username = ?)
    `, roomId, userId || null, displayName);

      if (existing) {
        // Update last_seen_at
        yield* run(`
        UPDATE public_chat_participants
        SET last_seen_at = ?
        WHERE id = ?
      `, new Date().toISOString(), existing.id);
        return { existing: true, participant: existing };
      }

      // Create participant
      yield* run(`
      INSERT INTO public_chat_participants (id, room_id, user_id, username)
      VALUES (?, ?, ?, ?)
    `, participantId, roomId, userId || null, displayName);

      // Update participant count
      yield* run('UPDATE public_chat_rooms SET participant_count = participant_count + 1 WHERE id = ?', roomId);

      return { existing: false, participant: yield* one('SELECT * FROM public_chat_participants WHERE id = ?', participantId) };
    });
    const participant = joined.participant;

    return { success: true, participant };
  });

  /**
   * POST /api/public-chat/rooms/:id/leave
   * Leave room
   */
  fastify.post('/api/public-chat/rooms/:id/leave', async (request, reply) => {
    const { id: roomId } = request.params as { id: string };
    const userId = getOptionalUserId(request);

    if (!userId) {
      return reply.code(400).send({ error: 'Cannot leave as anonymous user' });
    }

    await sql().tx(function* () {
      const d = yield* dialect();
      yield* lockName(`public_chat_participants:${roomId}`);
      yield* run(`
      DELETE FROM public_chat_participants
      WHERE room_id = ? AND user_id = ?
    `, roomId, userId);

      // Update participant count (ensure it doesn't go negative)
      yield* run(`
      UPDATE public_chat_rooms
      SET participant_count = ${greatest(d)}(0, participant_count - 1)
      WHERE id = ?
    `, roomId);
    });

    return { success: true };
  });

  /**
   * GET /api/public-chat/rooms/:id/participants
   * Get active participants
   */
  fastify.get('/api/public-chat/rooms/:id/participants', async (request, reply) => {
    const { id: roomId } = request.params as { id: string };
    const userId = getOptionalUserId(request);

    // Q-14 (CL-07): anonymous visitors only when the owner turned it on.
    if (!userId && !(await anonymousPublicRoomsEnabled())) return reply.code(404).send({ error: 'Room not found' });

    const room = await q.one('SELECT * FROM public_chat_rooms WHERE id = ?', roomId) as PublicChatRoom | undefined;

    if (!room) {
      return reply.code(404).send({ error: 'Room not found' });
    }

    if (!canAccessRoom(room, userId || undefined, request.authUser?.role)) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    const participants = await q.all(`
      SELECT * FROM public_chat_participants
      WHERE room_id = ?
      ORDER BY joined_at ASC
    `, roomId);

    return { participants };
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Embed Code
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * GET /api/public-chat/rooms/:id/embed-code
   * Get iframe embed code
   */
  fastify.get('/api/public-chat/rooms/:id/embed-code', async (request, reply) => {
    const { id: roomId } = request.params as { id: string };
    const userId = getOptionalUserId(request);

    const room = await q.one('SELECT * FROM public_chat_rooms WHERE id = ?', roomId) as PublicChatRoom | undefined;

    if (!room) {
      return reply.code(404).send({ error: 'Room not found' });
    }

    if (!canAccessRoom(room, userId || undefined, request.authUser?.role)) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    if (!room.embed_enabled) {
      return reply.code(403).send({ error: 'Embedding is disabled for this room' });
    }

    // Determine dimensions based on size
    const dimensions: Record<string, { width: number; height: number }> = {
      small: { width: 300, height: 400 },
      medium: { width: 500, height: 600 },
      large: { width: 800, height: 800 },
      full: { width: 100, height: 100 } // Percentage
    };

    const size = dimensions[room.embed_size] || dimensions.medium;
    const widthStr = room.embed_size === 'full' ? '100%' : `${size.width}px`;
    const heightStr = room.embed_size === 'full' ? '100%' : `${size.height}px`;

    const embedUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:41521'}/room/embed/${roomId}?size=${room.embed_size}&theme=${room.embed_theme}`;

    const iframeCode = `<!-- Agent Player Public Chat Room -->
<iframe
  src="${embedUrl}"
  width="${widthStr}"
  height="${heightStr}"
  frameborder="0"
  allow="microphone"
  title="${room.name}"
></iframe>`;

    const scriptCode = `<!-- Agent Player Public Chat Room (Dynamic Loading) -->
<script>
  (function() {
    const iframe = document.createElement('iframe');
    iframe.src = '${embedUrl}';
    iframe.width = '${widthStr}';
    iframe.height = '${heightStr}';
    iframe.frameBorder = '0';
    iframe.allow = 'microphone';
    iframe.title = '${room.name}';
    document.getElementById('chat-container').appendChild(iframe);
  })();
</script>
<div id="chat-container"></div>`;

    return {
      iframeCode,
      scriptCode,
      embedUrl
    };
  });
}
