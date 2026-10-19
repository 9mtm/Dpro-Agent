import { safeConsole } from './safe-error-log.js';
/**
 * Calendar Sync Service
 * Handles syncing with Google Calendar and importing from iCal/WebCal URLs
 */

import { nowText } from '../db/pg/dialect.js';
import { isoUtc } from '../api/timestamps.js';
import { dialect, one, q, run, sql, type Step } from '../repositories/sql-steps.js';
import { randomUUID } from 'crypto';
import { checkUrl, safeDownload, SafeFetchError, type LookupFn, type TransportFn } from './net/safe-fetch.js';

interface CalendarSource {
  id: string;
  user_id: string;
  type: string;
  url: string | null;
  google_calendar_id: string | null;
  google_access_token: string | null;
  google_refresh_token: string | null;
  google_token_expiry: string | null;
}

/**
 * Sync a calendar source (Google, iCal, WebCal)
 */
export async function syncCalendarSource(sourceId: string): Promise<void> {
  try {
    const source = await q.one<CalendarSource>('SELECT * FROM calendar_sources WHERE id = ?', sourceId);
    if (!source) {
      throw new Error('Calendar source not found');
    }

    // Create sync log entry
    const logId = randomUUID();
    await q.run(`
      INSERT INTO calendar_sync_log (id, calendar_source_id, status)
      VALUES (?, ?, 'running')`,
      logId, sourceId);

    let eventsAdded = 0;
    let eventsUpdated = 0;
    let eventsDeleted = 0;

    try {
      if (source.type === 'google') {
        const result = await syncGoogleCalendar(source);
        eventsAdded = result.added;
        eventsUpdated = result.updated;
        eventsDeleted = result.deleted;
      } else if (source.type === 'ical' || source.type === 'webcal') {
        const result = await syncICalCalendar(source);
        eventsAdded = result.added;
        eventsUpdated = result.updated;
        eventsDeleted = result.deleted;
      } else {
        throw new Error(`Unsupported calendar type: ${source.type}`);
      }

      // Update sync log and source (TEXT timestamps on both drivers)
      await sql().tx(function* () {
        const now = nowText(yield* dialect());
        yield* run(`
          UPDATE calendar_sync_log
          SET
            status = 'success',
            completed_at = ${now},
            events_added = ?,
            events_updated = ?,
            events_deleted = ?
          WHERE id = ?`,
          eventsAdded, eventsUpdated, eventsDeleted, logId);
        yield* run(`
          UPDATE calendar_sources
          SET
            sync_status = 'success',
            last_synced_at = ${now},
            sync_error = NULL,
            updated_at = ${now}
          WHERE id = ?`,
          sourceId);
      });

    } catch (error: any) {
      // Update sync log and source with the error
      await sql().tx(function* () {
        const now = nowText(yield* dialect());
        yield* run(`
          UPDATE calendar_sync_log
          SET
            status = 'error',
            completed_at = ${now},
            error_message = ?
          WHERE id = ?`,
          error.message, logId);
        yield* run(`
          UPDATE calendar_sources
          SET
            sync_status = 'error',
            sync_error = ?,
            updated_at = ${now}
          WHERE id = ?`,
          error.message, sourceId);
      });

      throw error;
    }
  } catch (error) {
    safeConsole.error(`[CalendarSync] Failed to sync source ${sourceId}:`, error);
    throw error;
  }
}

/**
 * Sync Google Calendar
 */
async function syncGoogleCalendar(source: CalendarSource): Promise<{ added: number; updated: number; deleted: number }> {

  // Check if access token is expired
  if (source.google_token_expiry && new Date(source.google_token_expiry) < new Date()) {
    // TODO: Refresh token using google_refresh_token
    console.warn('[CalendarSync] Google access token expired, refresh not implemented yet');
  }

  if (!source.google_access_token || !source.google_calendar_id) {
    throw new Error('Google Calendar not authenticated');
  }

  // Fetch events from Google Calendar API
  const now = new Date();
  const timeMin = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
  const timeMax = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString(); // 1 year ahead

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(source.google_calendar_id)}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime`;

  let data: any;
  try {
    data = await fetchGoogleJson(url, source.google_access_token);
  } catch (error) {
    throw fetchFailure(error);
  }

  if (!data.items) {
    return { added: 0, updated: 0, deleted: 0 };
  }

  return applyGoogleEvents(source, data.items);
}

/**
 * Upsert fetched Google events of a source (by external_id), in one
 * transaction (B2.2d-12: on the process driver; exported for tests).
 */
export function applyGoogleEvents(source: Pick<CalendarSource, 'id' | 'user_id'>, items: any[]): Promise<{ added: number; updated: number; deleted: number }> {
  return sql().tx(function* (): Step<{ added: number; updated: number; deleted: number }> {
    const now = nowText(yield* dialect());
    let added = 0;
    let updated = 0;

    for (const googleEvent of items) {
      // Check if event already exists
      const existing = yield* one<{ id: string }>('SELECT id FROM calendar_events WHERE external_id = ? AND calendar_source_id = ?', googleEvent.id, source.id);

      const eventData = {
        title: googleEvent.summary || 'Untitled Event',
        description: googleEvent.description || null,
        location: googleEvent.location || null,
        start_time: googleEvent.start.dateTime || googleEvent.start.date,
        end_time: googleEvent.end.dateTime || googleEvent.end.date,
        is_all_day: googleEvent.start.date ? 1 : 0,
        timezone: googleEvent.start.timeZone || 'UTC',
        external_id: googleEvent.id,
        external_url: googleEvent.htmlLink ?? null,
        external_etag: googleEvent.etag ?? null,
        status: googleEvent.status || 'confirmed',
        organizer: googleEvent.organizer?.email || null,
        attendees: googleEvent.attendees ? JSON.stringify(googleEvent.attendees.map((a: any) => ({
          email: a.email,
          name: a.displayName,
          status: a.responseStatus,
        }))) : null,
      };

      if (existing) {
        // Update existing event
        yield* run(`
          UPDATE calendar_events
          SET
            title = ?,
            description = ?,
            location = ?,
            start_time = ?,
            end_time = ?,
            is_all_day = ?,
            timezone = ?,
            external_url = ?,
            external_etag = ?,
            status = ?,
            organizer = ?,
            attendees = ?,
            updated_at = ${now}
          WHERE id = ?`,
          eventData.title,
          eventData.description,
          eventData.location,
          eventData.start_time,
          eventData.end_time,
          eventData.is_all_day,
          eventData.timezone,
          eventData.external_url,
          eventData.external_etag,
          eventData.status,
          eventData.organizer,
          eventData.attendees,
          existing.id);
        updated++;
      } else {
        // Insert new event
        yield* run(`
          INSERT INTO calendar_events (
            id, user_id, calendar_source_id, title, description, location,
            start_time, end_time, is_all_day, timezone, external_id, external_url,
            external_etag, status, organizer, attendees
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          randomUUID(),
          source.user_id,
          source.id,
          eventData.title,
          eventData.description,
          eventData.location,
          eventData.start_time,
          eventData.end_time,
          eventData.is_all_day,
          eventData.timezone,
          eventData.external_id,
          eventData.external_url,
          eventData.external_etag,
          eventData.status,
          eventData.organizer,
          eventData.attendees);
        added++;
      }
    }

    return { added, updated, deleted: 0 };
  });
}

/**
 * Sync iCal/WebCal calendar
 */
async function syncICalCalendar(source: CalendarSource): Promise<{ added: number; updated: number; deleted: number }> {

  if (!source.url) {
    throw new Error('Calendar URL is required for iCal sync');
  }

  // Fetch iCal data (SEC-CAL-01: through safe-fetch)
  let icalData: string;
  try {
    icalData = await fetchICalText(source.url);
  } catch (error) {
    throw fetchFailure(error);
  }

  // Parse iCal (basic parsing - you can use a library like 'ical' for production)
  const events = parseICalBasic(icalData);

  return applyICalEvents(source, events);
}

/**
 * Upsert parsed iCal events of a source (by UID), in one transaction
 * (B2.2d-12: on the process driver; exported for tests).
 */
export function applyICalEvents(
  source: Pick<CalendarSource, 'id' | 'user_id'>,
  events: Array<{ uid: string; summary?: string; description?: string; location?: string; dtstart: string; dtend: string; isAllDay?: boolean }>
): Promise<{ added: number; updated: number; deleted: number }> {
  return sql().tx(function* (): Step<{ added: number; updated: number; deleted: number }> {
    const now = nowText(yield* dialect());
    let added = 0;
    let updated = 0;

    for (const event of events) {
      // Check if event already exists
      const existing = yield* one<{ id: string }>('SELECT id FROM calendar_events WHERE external_id = ? AND calendar_source_id = ?', event.uid, source.id);

      const eventData = {
        title: event.summary || 'Untitled Event',
        description: event.description || null,
        location: event.location || null,
        start_time: event.dtstart,
        end_time: event.dtend,
        is_all_day: event.isAllDay ? 1 : 0,
        timezone: 'UTC',
        external_id: event.uid,
      };

      if (existing) {
        // Update existing event
        yield* run(`
          UPDATE calendar_events
          SET
            title = ?,
            description = ?,
            location = ?,
            start_time = ?,
            end_time = ?,
            is_all_day = ?,
            updated_at = ${now}
          WHERE id = ?`,
          eventData.title,
          eventData.description,
          eventData.location,
          eventData.start_time,
          eventData.end_time,
          eventData.is_all_day,
          existing.id);
        updated++;
      } else {
        // Insert new event
        yield* run(`
          INSERT INTO calendar_events (
            id, user_id, calendar_source_id, title, description, location,
            start_time, end_time, is_all_day, timezone, external_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          randomUUID(),
          source.user_id,
          source.id,
          eventData.title,
          eventData.description,
          eventData.location,
          eventData.start_time,
          eventData.end_time,
          eventData.is_all_day,
          eventData.timezone,
          eventData.external_id);
        added++;
      }
    }

    return { added, updated, deleted: 0 };
  });
}

/**
 * SEC-CAL-01: outbound calendar requests go through safe-fetch (https only,
 * default port, no IP literal, every DNS answer public, connection pinned
 * to the checked address, redirects only to the same host, size and
 * content-type limits). The iCal host is the one the user saved, so the
 * allow-list is that single name; Google is only www.googleapis.com.
 * `net` is injectable so tests need no network.
 */
export interface CalendarNet {
  lookup?: LookupFn;
  transport?: TransportFn;
}

const ICAL_TYPES = ['text/calendar', 'text/plain', 'application/octet-stream', 'application/ics'] as const;
const ICAL_MAX_BYTES = 5 * 1024 * 1024;
const GOOGLE_HOST = 'www.googleapis.com';

/** The https URL an iCal/WebCal source is fetched from (webcal:// → https://), or a SafeFetchError. */
export function icalFetchUrl(raw: string): URL {
  const url = raw.trim().replace(/^webcals?:\/\//i, 'https://');
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* checkUrl reports it */ }
  return checkUrl(url, host ? [host] : []);
}

export async function fetchICalText(raw: string, net: CalendarNet = {}): Promise<string> {
  const url = icalFetchUrl(raw);
  const { body } = await safeDownload(url.toString(), {
    allowedHosts: [url.hostname.toLowerCase()],
    allowedContentTypes: ICAL_TYPES,
    maxBytes: ICAL_MAX_BYTES,
    ...net,
  });
  return body.toString('utf-8');
}

export async function fetchGoogleJson(url: string, accessToken: string, net: CalendarNet = {}): Promise<any> {
  const { body } = await safeDownload(url, {
    allowedHosts: [GOOGLE_HOST],
    allowedContentTypes: ['application/json'],
    maxBytes: 10 * 1024 * 1024,
    headers: { Authorization: `Bearer ${accessToken}` },
    ...net,
  });
  return JSON.parse(body.toString('utf-8'));
}

/** A sync error message that never carries an upstream body. */
function fetchFailure(error: unknown): Error {
  return error instanceof SafeFetchError
    ? new Error(`Calendar fetch refused or failed (${error.code})`)
    : new Error('Calendar fetch failed');
}

/**
 * Basic iCal parser (minimal implementation)
 * For production, use a proper library like 'ical.js' or 'node-ical'
 */
function parseICalBasic(icalData: string): Array<{
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  dtstart: string;
  dtend: string;
  isAllDay: boolean;
}> {
  const events: Array<any> = [];
  const lines = icalData.split(/\r?\n/);

  let currentEvent: any = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();

    // Handle line folding (lines starting with space or tab)
    while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1])) {
      line += lines[i + 1].trim();
      i++;
    }

    if (line === 'BEGIN:VEVENT') {
      currentEvent = {};
    } else if (line === 'END:VEVENT' && currentEvent) {
      if (currentEvent.uid && currentEvent.dtstart && currentEvent.dtend) {
        events.push(currentEvent);
      }
      currentEvent = null;
    } else if (currentEvent) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const key = line.substring(0, colonIndex);
      const value = line.substring(colonIndex + 1);

      if (key === 'UID') {
        currentEvent.uid = value;
      } else if (key === 'SUMMARY') {
        currentEvent.summary = value;
      } else if (key === 'DESCRIPTION') {
        currentEvent.description = value.replace(/\\n/g, '\n').replace(/\\,/g, ',');
      } else if (key === 'LOCATION') {
        currentEvent.location = value;
      } else if (key.startsWith('DTSTART')) {
        const isAllDay = key.includes('VALUE=DATE');
        currentEvent.dtstart = parseICalDate(value);
        currentEvent.isAllDay = isAllDay;
      } else if (key.startsWith('DTEND')) {
        currentEvent.dtend = parseICalDate(value);
      }
    }
  }

  return events;
}

/**
 * Parse iCal date format to ISO 8601
 */
function parseICalDate(dateStr: string): string {
  // Format: 20240315T100000Z or 20240315
  if (dateStr.length === 8) {
    // All-day event: YYYYMMDD
    return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
  } else if (dateStr.includes('T')) {
    // DateTime: YYYYMMDDTHHmmssZ
    const date = dateStr.substring(0, 8);
    const time = dateStr.substring(9, 15);
    return `${date.substring(0, 4)}-${date.substring(4, 6)}-${date.substring(6, 8)}T${time.substring(0, 2)}:${time.substring(2, 4)}:${time.substring(4, 6)}Z`;
  }
  return dateStr;
}

/**
 * Start automatic sync scheduler (runs every X minutes)
 */
export function startCalendarSyncScheduler() {
  setInterval(async () => {
    try {
      // Get all sources that need syncing
      const sources = await q.all<{ id: string; sync_interval: number; last_synced_at: string | null }>(`
        SELECT id, sync_interval, last_synced_at
        FROM calendar_sources
        WHERE sync_enabled = 1 AND is_enabled = 1`);

      for (const source of sources) {
        const now = new Date();
        // last_synced_at is 'YYYY-MM-DD HH:MM:SS' UTC; isoUtc reads it as UTC
        // (new Date() of that text is local time and shifted the due time).
        const synced = isoUtc(source.last_synced_at);
        const lastSynced = synced ? new Date(synced) : null;

        // Check if sync is due
        if (!lastSynced || (now.getTime() - lastSynced.getTime()) >= source.sync_interval * 1000) {
          console.log(`[CalendarSync] Auto-syncing source ${source.id}`);
          syncCalendarSource(source.id).catch((error) => {
            console.error(`[CalendarSync] Auto-sync failed for source ${source.id}:`, error);
          });
        }
      }
    } catch (error) {
      console.error('[CalendarSync] Scheduler error:', error);
    }
  }, 60000); // Check every minute

  console.log('[CalendarSync] Scheduler started');
}
