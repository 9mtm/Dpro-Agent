import { safeConsole } from '../../services/safe-error-log.js';
/**
 * Calendar API Routes
 * Manages calendar events, sources, and external calendar sync (Google Calendar, iCal)
 */

import type { FastifyInstance } from 'fastify';
import { handleError, handleSmartError } from '../error-handler.js';
import { nowText } from '../../db/pg/dialect.js';
import { dialect, one, q, run, sql, type SqlParam } from '../../repositories/sql-steps.js';
import { getUserIdFromRequest } from '../../auth/jwt.js';
import { randomUUID } from 'crypto';
import { icalFetchUrl } from '../../services/calendar-sync.js';

/**
 * Source columns the API returns. Never `*`: calendar_sources holds the
 * Google access/refresh tokens (B2.2d-12: create and update answered them).
 */
const SOURCE_COLUMNS = `id, name, type, url, color, description, permission, allow_agent_access, is_enabled, is_primary,
          sync_enabled, sync_interval, last_synced_at, sync_status, sync_error,
          created_at, updated_at`;

/**
 * SEC-CAL-01: a remote calendar URL must be one the sync may fetch (https or
 * webcal, default port, a host name — no IP literal). The DNS answers are
 * checked again on every sync.
 */
function remoteUrlRefusal(url: unknown): string | null {
  if (typeof url !== 'string' || url.trim() === '') return 'url is required for this calendar type';
  try {
    icalFetchUrl(url);
    return null;
  } catch {
    return 'url must be an https:// or webcal:// address with a host name';
  }
}

/** undefined → null, so an absent field binds as NULL (COALESCE keeps the column). */
const opt = (v: unknown): SqlParam => (v === undefined ? null : (v as SqlParam));

export async function registerCalendarRoutes(fastify: FastifyInstance) {

  // ── Calendar Sources ──

  /**
   * GET /api/calendar/sources
   * Get all calendar sources for the current user
   */
  fastify.get('/api/calendar/sources', async (request, reply) => {
    try {
      const userId = getUserIdFromRequest(request);

      const sources = await q.all(`
        SELECT
          id, name, type, url, color, is_enabled, is_primary,
          sync_enabled, sync_interval, last_synced_at, sync_status,
          created_at, updated_at
        FROM calendar_sources
        WHERE user_id = ?
        ORDER BY is_primary DESC, name ASC`,
        userId);

      return { sources };
    } catch (error: any) {
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleSmartError(reply, error, '[Calendar]');
    }
  });

  /**
   * POST /api/calendar/sources
   * Create a new calendar source
   */
  fastify.post('/api/calendar/sources', async (request, reply) => {
    try {
      const userId = getUserIdFromRequest(request);
      const { name, type, url, color, description, permission, allow_agent_access } = request.body as {
        name: string;
        type: string;
        url?: string;
        color?: string;
        description?: string;
        permission?: string;
        allow_agent_access?: boolean;
      };

      if (!name || !type) {
        return reply.code(400).send({ error: 'name and type are required' });
      }

      const validTypes = ['manual', 'google', 'ical', 'caldav', 'webcal'];
      if (!validTypes.includes(type)) {
        return reply.code(400).send({ error: 'Invalid calendar type' });
      }

      if (type === 'ical' || type === 'webcal' || type === 'caldav') {
        const refusal = remoteUrlRefusal(url);
        if (refusal) return reply.code(400).send({ error: refusal });
      }

      const id = randomUUID();
      await q.run(`
        INSERT INTO calendar_sources (
          id, user_id, name, type, url, color, description, permission, allow_agent_access
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        userId,
        name,
        type,
        url || null,
        color || '#3b82f6',
        description || null,
        permission || 'read_write',
        allow_agent_access !== false ? 1 : 0
      );

      const source = await q.one(`SELECT ${SOURCE_COLUMNS} FROM calendar_sources WHERE id = ?`, id);
      return { source };
    } catch (error: any) {
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleSmartError(reply, error, '[Calendar]');
    }
  });

  /**
   * PUT /api/calendar/sources/:id
   * Update calendar source
   */
  fastify.put('/api/calendar/sources/:id', async (request, reply) => {
    try {
      const userId = getUserIdFromRequest(request);
      const { id } = request.params as { id: string };
      const { name, url, color, is_enabled, is_primary, sync_enabled, description, permission, allow_agent_access } = request.body as {
        name?: string;
        url?: string;
        color?: string;
        is_enabled?: boolean;
        is_primary?: boolean;
        sync_enabled?: boolean;
        description?: string;
        permission?: string;
        allow_agent_access?: boolean;
      };

      if (url !== undefined && url !== null) {
        const refusal = remoteUrlRefusal(url);
        if (refusal) return reply.code(400).send({ error: refusal });
      }

      const updated = await sql().tx(function* () {
      // Verify ownership
      const source = yield* one('SELECT id FROM calendar_sources WHERE id = ? AND user_id = ?', id, userId);
      if (!source) return null;

      // If setting as primary, unset other primary calendars (same transaction)
      if (is_primary) {
        yield* run('UPDATE calendar_sources SET is_primary = 0 WHERE user_id = ?', userId);
      }

      yield* run(`
        UPDATE calendar_sources
        SET
          name = COALESCE(?, name),
          url = COALESCE(?, url),
          color = COALESCE(?, color),
          is_enabled = COALESCE(?, is_enabled),
          is_primary = COALESCE(?, is_primary),
          sync_enabled = COALESCE(?, sync_enabled),
          description = COALESCE(?, description),
          permission = COALESCE(?, permission),
          allow_agent_access = COALESCE(?, allow_agent_access),
          updated_at = ${nowText(yield* dialect())}
        WHERE id = ? AND user_id = ?`,
        opt(name),
        opt(url),
        opt(color),
        is_enabled !== undefined ? (is_enabled ? 1 : 0) : null,
        is_primary !== undefined ? (is_primary ? 1 : 0) : null,
        sync_enabled !== undefined ? (sync_enabled ? 1 : 0) : null,
        opt(description),
        opt(permission),
        allow_agent_access !== undefined ? (allow_agent_access ? 1 : 0) : null,
        id,
        userId);

      return (yield* one(`SELECT ${SOURCE_COLUMNS} FROM calendar_sources WHERE id = ?`, id)) ?? null;
      });
      if (!updated) {
        return reply.code(404).send({ error: 'Calendar source not found' });
      }
      return { source: updated };
    } catch (error: any) {
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleSmartError(reply, error, '[Calendar]');
    }
  });

  /**
   * DELETE /api/calendar/sources/:id
   * Delete calendar source (and all its events)
   */
  fastify.delete('/api/calendar/sources/:id', async (request, reply) => {
    try {
      const userId = getUserIdFromRequest(request);
      const { id } = request.params as { id: string };

      // Ownership in the DELETE itself (events go with it: ON DELETE CASCADE)
      const result = await q.run('DELETE FROM calendar_sources WHERE id = ? AND user_id = ?', id, userId);
      if (result.changes === 0) {
        return reply.code(404).send({ error: 'Calendar source not found' });
      }
      return { success: true };
    } catch (error: any) {
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleSmartError(reply, error, '[Calendar]');
    }
  });

  // ── Calendar Events ──

  /**
   * GET /api/calendar/events
   * Get calendar events (with filters)
   */
  fastify.get('/api/calendar/events', async (request, reply) => {
    try {
      const userId = getUserIdFromRequest(request);
      const { start, end, source_id } = request.query as {
        start?: string;
        end?: string;
        source_id?: string;
      };

      let query = `
        SELECT
          e.*,
          s.name as calendar_name,
          s.color as calendar_color
        FROM calendar_events e
        LEFT JOIN calendar_sources s ON s.id = e.calendar_source_id
        WHERE e.user_id = ?
      `;

      const params: SqlParam[] = [userId];

      if (start) {
        query += ' AND e.start_time >= ?';
        params.push(start);
      }

      if (end) {
        query += ' AND e.start_time <= ?';
        params.push(end);
      }

      if (source_id) {
        query += ' AND e.calendar_source_id = ?';
        params.push(source_id);
      }

      query += ' ORDER BY e.start_time ASC, e.id ASC';

      const events = await q.all(query, ...params);

      // Parse JSON fields
      const parsedEvents = events.map((event: any) => ({
        ...event,
        attendees: event.attendees ? JSON.parse(event.attendees) : [],
        reminders: event.reminders ? JSON.parse(event.reminders) : [],
        recurrence_exception: event.recurrence_exception ? JSON.parse(event.recurrence_exception) : [],
      }));

      return { events: parsedEvents };
    } catch (error: any) {
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleSmartError(reply, error, '[Calendar]');
    }
  });

  /**
   * GET /api/calendar/events/:id
   * Get single event
   */
  fastify.get('/api/calendar/events/:id', async (request, reply) => {
    try {
      const userId = getUserIdFromRequest(request);
      const { id } = request.params as { id: string };

      const event = await q.one<any>(`
        SELECT
          e.*,
          s.name as calendar_name,
          s.color as calendar_color
        FROM calendar_events e
        LEFT JOIN calendar_sources s ON s.id = e.calendar_source_id
        WHERE e.id = ? AND e.user_id = ?`,
        id, userId);

      if (!event) {
        return reply.code(404).send({ error: 'Event not found' });
      }

      // Parse JSON fields
      event.attendees = event.attendees ? JSON.parse(event.attendees) : [];
      event.reminders = event.reminders ? JSON.parse(event.reminders) : [];
      event.recurrence_exception = event.recurrence_exception ? JSON.parse(event.recurrence_exception) : [];

      return { event };
    } catch (error: any) {
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleSmartError(reply, error, '[Calendar]');
    }
  });

  /**
   * POST /api/calendar/events
   * Create new calendar event
   */
  fastify.post('/api/calendar/events', async (request, reply) => {
    try {
      const userId = getUserIdFromRequest(request);
      const {
        calendar_source_id,
        title,
        description,
        location,
        start_time,
        end_time,
        is_all_day,
        timezone,
        event_type,
        attendees,
        reminders,
      } = request.body as {
        calendar_source_id?: string;
        title: string;
        description?: string;
        location?: string;
        start_time: string;
        end_time: string;
        is_all_day?: boolean;
        timezone?: string;
        event_type?: string;
        attendees?: any[];
        reminders?: any[];
      };

      if (!title || !start_time || !end_time) {
        return reply.code(400).send({ error: 'title, start_time, and end_time are required' });
      }

      // If no calendar_source_id provided, use primary calendar. A given id
      // must be one of the caller's own sources (B2.2d-12: any id was accepted).
      let sourceId = calendar_source_id;
      if (sourceId) {
        const own = await q.one('SELECT id FROM calendar_sources WHERE id = ? AND user_id = ?', sourceId, userId);
        if (!own) {
          return reply.code(404).send({ error: 'Calendar source not found' });
        }
      } else {
        const primary = await q.one<{ id: string }>(`
          SELECT id FROM calendar_sources
          WHERE user_id = ? AND is_primary = 1
          LIMIT 1`,
          userId);

        if (primary) {
          sourceId = primary.id;
        }
      }

      const id = randomUUID();
      await q.run(`
        INSERT INTO calendar_events (
          id, user_id, calendar_source_id, title, description, location,
          start_time, end_time, is_all_day, timezone, event_type,
          attendees, reminders
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        userId,
        sourceId || null,
        title,
        description || null,
        location || null,
        start_time,
        end_time,
        is_all_day ? 1 : 0,
        timezone || 'UTC',
        event_type || 'event',
        attendees ? JSON.stringify(attendees) : null,
        reminders ? JSON.stringify(reminders) : null
      );

      const event = await q.one('SELECT * FROM calendar_events WHERE id = ?', id);
      return { event };
    } catch (error: any) {
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleSmartError(reply, error, '[Calendar]');
    }
  });

  /**
   * PUT /api/calendar/events/:id
   * Update calendar event
   */
  fastify.put('/api/calendar/events/:id', async (request, reply) => {
    try {
      const userId = getUserIdFromRequest(request);
      const { id } = request.params as { id: string };
      const {
        title,
        description,
        location,
        start_time,
        end_time,
        is_all_day,
        timezone,
        event_type,
        status,
        attendees,
        reminders,
      } = request.body as any;

      const now = nowText(q.dialect);
      const changed = await q.run(`
        UPDATE calendar_events
        SET
          title = COALESCE(?, title),
          description = COALESCE(?, description),
          location = COALESCE(?, location),
          start_time = COALESCE(?, start_time),
          end_time = COALESCE(?, end_time),
          is_all_day = COALESCE(?, is_all_day),
          timezone = COALESCE(?, timezone),
          event_type = COALESCE(?, event_type),
          status = COALESCE(?, status),
          attendees = COALESCE(?, attendees),
          reminders = COALESCE(?, reminders),
          updated_at = ${now}
        WHERE id = ? AND user_id = ?`,
        opt(title),
        opt(description),
        opt(location),
        opt(start_time),
        opt(end_time),
        is_all_day !== undefined ? (is_all_day ? 1 : 0) : null,
        opt(timezone),
        opt(event_type),
        opt(status),
        attendees ? JSON.stringify(attendees) : null,
        reminders ? JSON.stringify(reminders) : null,
        id,
        userId);
      if (changed.changes === 0) {
        return reply.code(404).send({ error: 'Event not found' });
      }

      const updated = await q.one('SELECT * FROM calendar_events WHERE id = ?', id);
      return { event: updated };
    } catch (error: any) {
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleSmartError(reply, error, '[Calendar]');
    }
  });

  /**
   * DELETE /api/calendar/events/:id
   * Delete calendar event
   */
  fastify.delete('/api/calendar/events/:id', async (request, reply) => {
    try {
      const userId = getUserIdFromRequest(request);
      const { id } = request.params as { id: string };

      const result = await q.run('DELETE FROM calendar_events WHERE id = ? AND user_id = ?', id, userId);
      if (result.changes === 0) {
        return reply.code(404).send({ error: 'Event not found' });
      }
      return { success: true };
    } catch (error: any) {
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleSmartError(reply, error, '[Calendar]');
    }
  });

  // ── Calendar Sync ──

  /**
   * POST /api/calendar/sources/:id/sync
   * Manually trigger sync for a calendar source
   */
  fastify.post('/api/calendar/sources/:id/sync', async (request, reply) => {
    try {
      const userId = getUserIdFromRequest(request);
      const { id } = request.params as { id: string };

      const source = await q.one<{ sync_enabled: number }>('SELECT sync_enabled FROM calendar_sources WHERE id = ? AND user_id = ?', id, userId);
      if (!source) {
        return reply.code(404).send({ error: 'Calendar source not found' });
      }

      if (!source.sync_enabled) {
        return reply.code(400).send({ error: 'Sync is not enabled for this calendar' });
      }

      // Update sync status
      await q.run(`
        UPDATE calendar_sources
        SET sync_status = 'syncing', updated_at = ${nowText(q.dialect)}
        WHERE id = ?`,
        id);

      // Start sync (import from the calendar sync service)
      const { syncCalendarSource } = await import('../../services/calendar-sync.js');

      // Run sync in background
      syncCalendarSource(id).catch((error) => {
        safeConsole.error(`[Calendar] Sync failed for source ${id}:`, error);
      });

      return { success: true, message: 'Sync started' };
    } catch (error: any) {
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleSmartError(reply, error, '[Calendar]');
    }
  });

  /**
   * GET /api/calendar/sources/:id/sync-log
   * Get sync history for a calendar source
   */
  fastify.get('/api/calendar/sources/:id/sync-log', async (request, reply) => {
    try {
      const userId = getUserIdFromRequest(request);
      const { id } = request.params as { id: string };

      // Verify ownership
      const source = await q.one('SELECT id FROM calendar_sources WHERE id = ? AND user_id = ?', id, userId);
      if (!source) {
        return reply.code(404).send({ error: 'Calendar source not found' });
      }

      const logs = await q.all(`
        SELECT * FROM calendar_sync_log
        WHERE calendar_source_id = ?
        ORDER BY started_at DESC, id DESC
        LIMIT 20`,
        id);

      return { logs };
    } catch (error: any) {
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleSmartError(reply, error, '[Calendar]');
    }
  });
}
