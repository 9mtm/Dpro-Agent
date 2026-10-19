import { safeConsole } from './safe-error-log.js';
/**
 * Notification Service
 *
 * Central dispatcher for all in-app notifications.
 * Stores every notification in the DB, then forwards to each
 * enabled channel (email, push, whatsapp, sound) based on user settings.
 *
 * Architecture:
 *  notify() → DB insert (always) → channel dispatchers (optional)
 *
 * Extending for new channels:
 *  1. Add column to notification_settings (migration)
 *  2. Add dispatcher function here
 *  3. Call it in notify() when enabled
 *
 * B2.2c: notifications, notification_settings and notification_schedules are
 * on the process driver (SQL steps). A notification is inserted with
 * RETURNING (one statement: the row returned is the row written, also with
 * concurrent writers). A due schedule is claimed with a conditional UPDATE
 * on its next_fire_at, in the same transaction as the notifications it
 * creates, so several processes never fire the same schedule twice and a
 * failed insert leaves the schedule due. External channels are dispatched
 * after the commit.
 */

import type { Dialect } from '../db/pg/dialect.js';
import { all, dialect, one, run, sql, type Step } from '../repositories/sql-steps.js';
import { forUpdate } from '../db/pg/dialect.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type NotificationType =
  | 'info'
  | 'success'
  | 'warning'
  | 'error'
  | 'agent'
  | 'system'
  | 'reminder';

export type NotificationChannel =
  | 'in_app'
  | 'email'
  | 'push'
  | 'whatsapp'
  | 'sound';

export interface CreateNotificationInput {
  userId: string;
  title: string;
  body?: string;
  type?: NotificationType;
  channel?: NotificationChannel;
  actionUrl?: string;
  meta?: Record<string, unknown>;
  source?: string; // extensionId or 'system'
}

export interface Notification {
  id: string;
  userId: string;
  title: string;
  body: string;
  type: NotificationType;
  channel: NotificationChannel;
  isRead: boolean;
  actionUrl: string | null;
  meta: string | null;
  source: string;
  createdAt: string;
}

export interface NotificationSettings {
  userId: string;
  channelInApp: boolean;
  channelEmail: boolean;
  channelPush: boolean;
  channelWhatsapp: boolean;
  channelSound: boolean;
  emailAddress: string | null;
  emailDigest: string;
  whatsappPhone: string | null;
  dndEnabled: boolean;
  dndStart: string;
  dndEnd: string;
  notifyTaskComplete: boolean;
  notifyAgentError: boolean;
  notifySkillExec: boolean;
  notifyWorkflow: boolean;
  notifySecurity: boolean;
  notifySystem: boolean;
  pushSubscription: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rowToSettings(row: any): NotificationSettings {
  return {
    userId: row.user_id,
    channelInApp: !!row.channel_in_app,
    channelEmail: !!row.channel_email,
    channelPush: !!row.channel_push,
    channelWhatsapp: !!row.channel_whatsapp,
    channelSound: !!row.channel_sound,
    emailAddress: row.email_address,
    emailDigest: row.email_digest,
    whatsappPhone: row.whatsapp_phone,
    dndEnabled: !!row.dnd_enabled,
    dndStart: row.dnd_start,
    dndEnd: row.dnd_end,
    notifyTaskComplete: !!row.notify_task_complete,
    notifyAgentError: !!row.notify_agent_error,
    notifySkillExec: !!row.notify_skill_exec,
    notifyWorkflow: !!row.notify_workflow,
    notifySecurity: !!row.notify_security,
    notifySystem: !!row.notify_system,
    pushSubscription: row.push_subscription,
  };
}

/** Returns true if current time is within the DND window */
function isDndActive(settings: NotificationSettings): boolean {
  if (!settings.dndEnabled) return false;
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const current = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const start = settings.dndStart;
  const end = settings.dndEnd;
  if (start <= end) {
    return current >= start && current < end;
  } else {
    // Overnight window e.g. 22:00 – 08:00
    return current >= start || current < end;
  }
}

// ── Settings CRUD ─────────────────────────────────────────────────────────────

/** A bound ISO time compared with a DATETIME (SQLite text) / timestamptz column. */
function tsArg(d: Dialect): string {
  return d === 'postgres' ? '(?)::timestamptz' : '?';
}

function* settingsStep(userId: string): Step<NotificationSettings> {
  let row = yield* one('SELECT * FROM notification_settings WHERE user_id = ?', userId);
  if (!row) {
    // Auto-create defaults (a concurrent creator wins the unique user_id; read again).
    yield* run('INSERT INTO notification_settings (user_id) VALUES (?) ON CONFLICT (user_id) DO NOTHING', userId);
    row = yield* one('SELECT * FROM notification_settings WHERE user_id = ?', userId);
  }
  return rowToSettings(row);
}

export function getNotificationSettings(userId: string): Promise<NotificationSettings> {
  return sql().tx(() => settingsStep(userId));
}

function* saveSettingsStep(userId: string, updates: Partial<Omit<NotificationSettings, 'userId'>>): Step<NotificationSettings> {
  // Ensure row exists
  yield* settingsStep(userId);

  const fields: string[] = [];
  const vals: Array<string | number | null> = [];

  const col = (key: string, val: any) => { fields.push(`${key} = ?`); vals.push(val ?? null); };

  if (updates.channelInApp !== undefined)    col('channel_in_app',      updates.channelInApp ? 1 : 0);
  if (updates.channelEmail !== undefined)    col('channel_email',       updates.channelEmail ? 1 : 0);
  if (updates.channelPush !== undefined)     col('channel_push',        updates.channelPush ? 1 : 0);
  if (updates.channelWhatsapp !== undefined) col('channel_whatsapp',    updates.channelWhatsapp ? 1 : 0);
  if (updates.channelSound !== undefined)    col('channel_sound',       updates.channelSound ? 1 : 0);
  if (updates.emailAddress !== undefined)    col('email_address',       updates.emailAddress);
  if (updates.emailDigest !== undefined)     col('email_digest',        updates.emailDigest);
  if (updates.whatsappPhone !== undefined)   col('whatsapp_phone',      updates.whatsappPhone);
  if (updates.dndEnabled !== undefined)      col('dnd_enabled',         updates.dndEnabled ? 1 : 0);
  if (updates.dndStart !== undefined)        col('dnd_start',           updates.dndStart);
  if (updates.dndEnd !== undefined)          col('dnd_end',             updates.dndEnd);
  if (updates.notifyTaskComplete !== undefined) col('notify_task_complete', updates.notifyTaskComplete ? 1 : 0);
  if (updates.notifyAgentError !== undefined)   col('notify_agent_error',   updates.notifyAgentError ? 1 : 0);
  if (updates.notifySkillExec !== undefined)    col('notify_skill_exec',    updates.notifySkillExec ? 1 : 0);
  if (updates.notifyWorkflow !== undefined)     col('notify_workflow',       updates.notifyWorkflow ? 1 : 0);
  if (updates.notifySecurity !== undefined)     col('notify_security',       updates.notifySecurity ? 1 : 0);
  if (updates.notifySystem !== undefined)       col('notify_system',         updates.notifySystem ? 1 : 0);
  if (updates.pushSubscription !== undefined)   col('push_subscription',     updates.pushSubscription);

  if (fields.length > 0) {
    fields.push('updated_at = CURRENT_TIMESTAMP');
    vals.push(userId);
    yield* run(`UPDATE notification_settings SET ${fields.join(', ')} WHERE user_id = ?`, ...vals);
  }

  return yield* settingsStep(userId);
}

export function saveNotificationSettings(
  userId: string,
  updates: Partial<Omit<NotificationSettings, 'userId'>>
): Promise<NotificationSettings> {
  return sql().tx(() => saveSettingsStep(userId, updates));
}

// ── Core notify() ─────────────────────────────────────────────────────────────

function rowToNotification(created: any): Notification {
  return {
    id: created.id,
    userId: created.user_id,
    title: created.title,
    body: created.body,
    type: created.type,
    channel: created.channel,
    isRead: !!created.is_read,
    actionUrl: created.action_url,
    meta: created.meta,
    source: created.source || 'system',
    createdAt: created.created_at,
  };
}

/** Insert one notification and return its row (SQL step). */
function* insertNotificationStep(input: CreateNotificationInput): Step<any> {
  const {
    userId,
    title,
    body = '',
    type = 'info',
    channel = 'in_app',
    actionUrl,
    meta,
    source = 'system',
  } = input;
  return yield* one(`
    INSERT INTO notifications (user_id, title, body, type, channel, action_url, meta, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `, userId, title, body, type, channel, actionUrl ?? null, meta ? JSON.stringify(meta) : null, source);
}

/** Forward to the user's external channels (after the notification is stored). */
async function dispatchExternal(userId: string, title: string, body: string): Promise<void> {
  try {
    const settings = await getNotificationSettings(userId);
    const dnd = isDndActive(settings);

    if (!dnd) {
      if (settings.channelEmail && settings.emailAddress) {
        dispatchEmail(settings.emailAddress, title, body).catch(() => {});
      }
      if (settings.channelPush && settings.pushSubscription) {
        dispatchPush(settings.pushSubscription, title, body).catch(() => {});
      }
      if (settings.channelWhatsapp && settings.whatsappPhone) {
        dispatchWhatsApp(settings.whatsappPhone, title, body).catch(() => {});
      }
    }
  } catch {
    // Non-fatal — in-app notification already saved
  }
}

/**
 * Create a notification and dispatch to all enabled channels.
 * Always stores in DB (in_app). Respects DND for external channels.
 */
export async function notify(input: CreateNotificationInput): Promise<Notification> {
  const created = await sql().read(insertNotificationStep(input));
  await dispatchExternal(input.userId, input.title, input.body ?? '');
  return rowToNotification(created);
}

// ── Notifications list / read / delete (routes) ──────────────────────────────

export interface ListNotificationsOptions { unread?: boolean; source?: string; limit: number; offset: number }

export function listNotifications(userId: string, opts: ListNotificationsOptions): Promise<{ rows: any[]; unreadCount: number }> {
  return sql().read((function* () {
    let q = 'SELECT * FROM notifications WHERE user_id = ?';
    const params: Array<string | number> = [userId];
    if (opts.unread) { q += ' AND is_read = 0'; }
    if (opts.source) { q += ' AND source = ?'; params.push(opts.source); }
    q += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(opts.limit, opts.offset);
    const rows = yield* all(q, ...params);
    const unread = yield* one<{ c: number }>('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0', userId);
    return { rows, unreadCount: unread?.c ?? 0 };
  })());
}

export async function markNotificationRead(userId: string, id: string): Promise<void> {
  await sql().read(run('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', id, userId));
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  await sql().read(run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', userId));
}

export async function deleteNotification(userId: string, id: string): Promise<void> {
  await sql().read(run('DELETE FROM notifications WHERE id = ? AND user_id = ?', id, userId));
}

export async function deleteReadNotifications(userId: string): Promise<void> {
  await sql().read(run('DELETE FROM notifications WHERE user_id = ? AND is_read = 1', userId));
}

/** Counts per type of the notifications an extension (source) created (extension SDK). */
export async function notificationStatsBySource(source: string): Promise<{ total: number; unread: number; byType: Record<string, number> }> {
  const stats = await sql().read(all<{ type: string; count: number; unread_count: number | null }>(`
    SELECT
      type,
      COUNT(*) as count,
      SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) as unread_count
    FROM notifications
    WHERE source = ?
    GROUP BY type
  `, source));
  const byType: Record<string, number> = {};
  let total = 0;
  let unread = 0;
  for (const row of stats) {
    byType[row.type] = row.count;
    total += row.count;
    unread += Number(row.unread_count || 0);
  }
  return { total, unread, byType };
}

// ── Schedules (routes, create_reminder tool) ─────────────────────────────────

export interface ScheduleInput {
  id?: string;
  userId: string;
  title: string;
  body: string;
  type: string;
  scheduleType: string;
  scheduleTime: string;
  scheduleDays: string | null;
  scheduleDate: string | null;
  channels: string;
  nextFireAt: string | null;
}

/** Insert a schedule and return its row (RETURNING: the row just written). */
export function createSchedule(input: ScheduleInput): Promise<any> {
  const cols = ['user_id', 'title', 'body', 'type', 'schedule_type', 'schedule_time', 'schedule_days', 'schedule_date', 'channels', 'next_fire_at'];
  const vals: Array<string | null> = [input.userId, input.title, input.body, input.type, input.scheduleType, input.scheduleTime,
    input.scheduleDays, input.scheduleDate, input.channels, input.nextFireAt];
  if (input.id) { cols.unshift('id'); vals.unshift(input.id); }
  return sql().read(one(`
    INSERT INTO notification_schedules (${cols.join(', ')})
    VALUES (${cols.map(() => '?').join(', ')})
    RETURNING *
  `, ...vals));
}

export function listSchedules(userId: string): Promise<any[]> {
  return sql().read(all('SELECT * FROM notification_schedules WHERE user_id = ? ORDER BY created_at DESC', userId));
}

/**
 * Change a schedule (one transaction: the row is locked, `change` computes
 * the SET list from it). null when the user has no such schedule.
 */
export function updateSchedule(
  userId: string,
  id: string,
  change: (existing: any) => { fields: string[]; vals: Array<string | number | null> },
): Promise<any | null> {
  return sql().tx(() => (function* () {
    const d = yield* dialect();
    const existing = yield* one(`SELECT * FROM notification_schedules WHERE id = ? AND user_id = ?${forUpdate(d)}`, id, userId);
    if (!existing) return null;
    const { fields, vals } = change(existing);
    if (fields.length > 0) {
      yield* run(`UPDATE notification_schedules SET ${fields.join(', ')} WHERE id = ?`, ...vals, id);
    }
    return yield* one('SELECT * FROM notification_schedules WHERE id = ?', id);
  })());
}

export async function deleteSchedule(userId: string, id: string): Promise<void> {
  await sql().read(run('DELETE FROM notification_schedules WHERE id = ? AND user_id = ?', id, userId));
}

// ── Channel Dispatchers ────────────────────────────────────────────────────────
// Each returns a Promise so they can be awaited or fire-and-forget.
// Replace stub implementations with real integrations as needed.

async function dispatchEmail(
  to: string,
  title: string,
  body: string
): Promise<void> {
  // TODO: integrate nodemailer / SendGrid / SES
  // Example with nodemailer:
  // const transporter = nodemailer.createTransport({ ... });
  // await transporter.sendMail({ from, to, subject: title, text: body });
  safeConsole.log(`[Notification] Email → ${to}: ${title}`);
}

async function dispatchPush(
  subscriptionJson: string,
  title: string,
  body: string
): Promise<void> {
  // TODO: integrate web-push library
  // const subscription = JSON.parse(subscriptionJson);
  // await webpush.sendNotification(subscription, JSON.stringify({ title, body }));
  safeConsole.log(`[Notification] Push → ${subscriptionJson.slice(0, 30)}: ${title}`);
}

async function dispatchWhatsApp(
  phone: string,
  title: string,
  body: string
): Promise<void> {
  // TODO: integrate Twilio / WhatsApp Business API / wwebjs
  // await twilioClient.messages.create({ body: `${title}: ${body}`, from: 'whatsapp:+...', to: `whatsapp:${phone}` });
  safeConsole.log(`[Notification] WhatsApp → ${phone}: ${title}`);
}

// ── Schedule Engine ───────────────────────────────────────────────────────────

/** Compute the next Date a schedule should fire, from a given "after" point */
export function computeNextFire(
  scheduleType: string,
  scheduleTime: string,
  scheduleDays: string | null,
  scheduleDate: string | null,
  after: Date = new Date()
): Date | null {
  const [hStr, mStr] = scheduleTime.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);

  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setHours(h, m);

  // Advance past "after" if needed
  if (candidate <= after) {
    candidate.setDate(candidate.getDate() + 1);
  }

  if (scheduleType === 'once') {
    if (!scheduleDate) return null;
    const target = new Date(`${scheduleDate}T${scheduleTime}:00`);
    return target > after ? target : null;
  }

  if (scheduleType === 'daily') {
    return candidate;
  }

  if (scheduleType === 'weekdays') {
    while (candidate.getDay() === 0 || candidate.getDay() === 6) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate;
  }

  if (scheduleType === 'weekends') {
    while (candidate.getDay() !== 0 && candidate.getDay() !== 6) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate;
  }

  if (scheduleType === 'weekly' || scheduleType === 'custom') {
    const days: number[] = scheduleDays ? JSON.parse(scheduleDays) : [1];
    let tries = 0;
    while (!days.includes(candidate.getDay()) && tries < 8) {
      candidate.setDate(candidate.getDate() + 1);
      tries++;
    }
    return tries < 8 ? candidate : null;
  }

  return candidate;
}

/**
 * Fire one due schedule (one transaction): claim it with a conditional
 * UPDATE on the next_fire_at that was read (another process that already
 * fired it moved next_fire_at, so this claim changes nothing), then insert
 * its notifications. Returns the notifications created (none when another
 * process had it).
 */
function* fireScheduleStep(sched: any, now: Date): Step<any[]> {
  const d = yield* dialect();
  const next = computeNextFire(sched.schedule_type, sched.schedule_time, sched.schedule_days, sched.schedule_date, now);
  const done = sched.schedule_type === 'once' || !next;
  const claimed = done
    // One-time or exhausted — deactivate
    ? yield* run(`UPDATE notification_schedules SET is_active = 0, last_fired_at = CURRENT_TIMESTAMP
                  WHERE id = ? AND is_active = 1 AND next_fire_at = ${tsArg(d)}`, sched.id, sched.next_fire_at)
    : yield* run(`UPDATE notification_schedules SET last_fired_at = CURRENT_TIMESTAMP, next_fire_at = ?
                  WHERE id = ? AND is_active = 1 AND next_fire_at = ${tsArg(d)}`, next!.toISOString(), sched.id, sched.next_fire_at);
  if (claimed.changes !== 1) return [];
  // Create the in-app notification
  const channels: string[] = JSON.parse(sched.channels || '["in_app"]');
  const created: any[] = [];
  for (const ch of channels) {
    created.push(yield* insertNotificationStep({
      userId: sched.user_id,
      title: sched.title,
      body: sched.body,
      type: sched.type,
      channel: ch as NotificationChannel,
    }));
  }
  return created;
}

/** Called by the cron runner — fires any overdue schedules */
export async function processScheduledNotifications(): Promise<void> {
  const runner = sql();
  const now = new Date();
  const due = await runner.read((function* () {
    const d = yield* dialect();
    return yield* all(`
      SELECT * FROM notification_schedules
      WHERE is_active = 1
        AND next_fire_at IS NOT NULL
        AND next_fire_at <= ${tsArg(d)}
    `, now.toISOString());
  })());

  for (const sched of due) {
    const created = await runner.tx(() => fireScheduleStep(sched, new Date()));
    for (const n of created) await dispatchExternal(n.user_id, n.title, n.body ?? '');
  }
}
