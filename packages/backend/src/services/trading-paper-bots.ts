/** Durable bounded paper ticks only. No strategy, timer, provider or human-authorization implementation. */
import type Database from 'better-sqlite3';
import {createHash, randomUUID} from 'node:crypto';
import {readPaperRisk} from './trading-paper-risk.js';
import {settlePaperRiskInTransaction} from './trading-paper-risk-execution.js';

const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const uint = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const deny = () => ({ok: false as const, reason: 'unavailable' as const});
const rollback = Symbol('paper bot rollback');
function plain(value: unknown, fields: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && keys.every(key => typeof key === 'string' && fields.includes(key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'));
}
type Bot = {
  bot_id: string; owner_id: string; account_id: string; policy_id: string; policy_revision: number;
  app_revision: number; expires_at: number; max_successful_ticks: number; cooldown_ms: number;
  status: 'active' | 'stopped' | 'revoked'; successful_ticks: number; last_success_at: number | null; created_at: number;
};
type TickInput = {botId: string; tickKey: string; side: 'buy' | 'sell'; reservationId: string};
type Tick = {
  id: string; bot_id: string; account_id: string; policy_id: string; policy_revision: number; app_revision: number;
  tick_key: string; side: 'buy' | 'sell'; reservation_id: string; execution_key: string;
  request_json: string; request_hash: string; receipt_json: string; receipt_hash: string; created_at: number;
};
const configFields = ['botId', 'ownerId', 'accountId', 'policyId', 'policyRevision', 'appRevision', 'expiresAt', 'maxSuccessfulTicks', 'cooldownMs'];
function validBot(bot: Bot, now: number) {
  return [bot.bot_id, bot.owner_id, bot.account_id, bot.policy_id].every(id)
    && uint(bot.policy_revision, 1) && uint(bot.app_revision, 1) && uint(bot.expires_at, 1)
    && uint(bot.max_successful_ticks, 1) && bot.max_successful_ticks <= 1000 && uint(bot.cooldown_ms)
    && ['active', 'stopped', 'revoked'].includes(bot.status) && uint(bot.successful_ticks)
    && bot.successful_ticks <= bot.max_successful_ticks && uint(bot.created_at) && bot.created_at <= now
    && bot.expires_at > bot.created_at && (bot.last_success_at === null || uint(bot.last_success_at) && bot.last_success_at >= bot.created_at && bot.last_success_at <= now);
}
/** Explicit caller-owned SQLite initialization; never called by tick execution or a GET. */
export function initializePaperBots(db: Database.Database) {
  db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS paper_bots(
      bot_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,account_id TEXT NOT NULL,policy_id TEXT NOT NULL,
      policy_revision INTEGER NOT NULL,app_revision INTEGER NOT NULL,expires_at INTEGER NOT NULL,
      max_successful_ticks INTEGER NOT NULL,cooldown_ms INTEGER NOT NULL,status TEXT NOT NULL,
      successful_ticks INTEGER NOT NULL,last_success_at INTEGER,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS paper_bot_ticks(
      id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,account_id TEXT NOT NULL,policy_id TEXT NOT NULL,
      policy_revision INTEGER NOT NULL,app_revision INTEGER NOT NULL,tick_key TEXT NOT NULL,side TEXT NOT NULL,
      reservation_id TEXT NOT NULL,execution_key TEXT NOT NULL,request_json TEXT NOT NULL,request_hash TEXT NOT NULL,
      receipt_json TEXT NOT NULL,receipt_hash TEXT NOT NULL,created_at INTEGER NOT NULL,
      UNIQUE(bot_id,tick_key),UNIQUE(account_id,execution_key));
  `)).immediate();
}
/** Trusted one-time reviewed configuration only. This does not implement owner approval or allow definition updates. */
export function provisionPaperBot(db: Database.Database, input: unknown, clock: () => number = Date.now) {
  try {
    if (db.inTransaction || !plain(input, configFields)
      || !['botId', 'ownerId', 'accountId', 'policyId'].every(key => id(input[key]))
      || !['policyRevision', 'appRevision', 'expiresAt', 'maxSuccessfulTicks'].every(key => uint(input[key], 1))
      || Number(input.maxSuccessfulTicks) > 1000 || !uint(input.cooldownMs)) return deny();
    const config = {...input};
    return db.transaction(() => {
      const now = clock();
      if (!uint(now) || Number(config.expiresAt) <= now) throw rollback;
      const risk = readPaperRisk(db, config.ownerId as string, config.accountId as string, config.policyId as string, () => now);
      const p = db.prepare('SELECT policy_json FROM paper_policies WHERE account_id=? AND policy_id=?').get(config.accountId, config.policyId) as {policy_json: string} | undefined;
      if (!risk.ok || risk.policyRevision !== config.policyRevision || risk.appRevision !== config.appRevision || !p) throw rollback;
      const policy = JSON.parse(p.policy_json);
      if (!uint(policy.expiresAt, 1) || Number(config.expiresAt) > policy.expiresAt) throw rollback;
      db.prepare('INSERT INTO paper_bots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(config.botId, config.ownerId, config.accountId, config.policyId,
        config.policyRevision, config.appRevision, config.expiresAt, config.maxSuccessfulTicks, config.cooldownMs, 'active', 0, null, now);
      return {ok: true as const, botId: config.botId as string};
    }).immediate();
  } catch { return deny(); }
}
function transition(db: Database.Database, owner: string, botId: string, target: 'stopped' | 'revoked') {
  try {
    if (db.inTransaction || !id(owner) || !id(botId)) return deny();
    return db.transaction(() => {
      const bot = db.prepare('SELECT owner_id,status FROM paper_bots WHERE bot_id=?').get(botId) as {owner_id: string; status: string} | undefined;
      if (bot?.owner_id !== owner || !['active', 'stopped', 'revoked'].includes(bot.status)
        || target === 'stopped' && bot.status === 'revoked') throw rollback;
      if (bot.status !== target) db.prepare('UPDATE paper_bots SET status=? WHERE bot_id=? AND owner_id=?').run(target, botId, owner);
      return {ok: true as const, botId, status: target};
    }).immediate();
  } catch { return deny(); }
}
export function stopPaperBot(db: Database.Database, owner: string, botId: string) { return transition(db, owner, botId, 'stopped'); }
export function revokePaperBot(db: Database.Database, owner: string, botId: string) { return transition(db, owner, botId, 'revoked'); }
function canonical(bot: Bot, input: TickInput) {
  return JSON.stringify({domain: 'paper_bot_tick_v1', botId: bot.bot_id, tickKey: input.tickKey, side: input.side,
    reservationId: input.reservationId, accountId: bot.account_id, policyId: bot.policy_id,
    policyRevision: bot.policy_revision, appRevision: bot.app_revision});
}
function reservationMatches(db: Database.Database, bot: Bot, side: 'buy' | 'sell', reservationId: string) {
  const table = side === 'buy' ? 'paper_reservations' : 'paper_sell_reservations';
  const column = side === 'buy' ? 'reservation_id' : 'id';
  const reservation = db.prepare(`SELECT * FROM ${table} WHERE account_id=? AND ${column}=?`).get(bot.account_id, reservationId) as Record<string, unknown> | undefined;
  if (!reservation || reservation.policy_id !== bot.policy_id) throw rollback;
  const saved = side === 'buy'
    ? db.prepare('SELECT canonical_json FROM paper_reservation_intents WHERE reservation_id=?').get(reservationId) as {canonical_json: string} | undefined
    : {canonical_json: reservation.intent_json};
  if (!saved || typeof saved.canonical_json !== 'string' || saved.canonical_json.length > 8192) throw rollback;
  const original = JSON.parse(saved.canonical_json);
  if (!original || original.accountId !== bot.account_id || original.policyId !== bot.policy_id
    || original.policyRevision !== bot.policy_revision || original.appRevision !== bot.app_revision
    || (side === 'buy' && original.side !== 'buy')) throw rollback;
}
/** Validate the entire bounded success journal and recheck every original receipt, without refreshing trading authority. */
function history(db: Database.Database, owner: string, bot: Bot, now: number) {
  const summary = db.prepare('SELECT count(*) count,max(created_at) latest FROM paper_bot_ticks WHERE bot_id=?').get(bot.bot_id) as {count: number; latest: number | null};
  if (!uint(summary.count) || summary.count > 1000 || summary.count !== bot.successful_ticks || summary.latest !== bot.last_success_at) throw rollback;
  const receipts = new Map<string, {tick: Tick; receipt: Record<string, unknown>}>();
  let previousAt: number | null = null;
  for (const raw of db.prepare('SELECT * FROM paper_bot_ticks WHERE bot_id=? ORDER BY created_at,id LIMIT 1001').all(bot.bot_id)) {
    const tick = raw as Tick;
    if (![tick.id, tick.tick_key, tick.reservation_id, tick.execution_key].every(id) || tick.bot_id !== bot.bot_id
      || tick.account_id !== bot.account_id || tick.policy_id !== bot.policy_id || tick.policy_revision !== bot.policy_revision
      || tick.app_revision !== bot.app_revision || !['buy', 'sell'].includes(tick.side)
      || !uint(tick.created_at) || tick.created_at < bot.created_at || tick.created_at > now
      || tick.created_at >= bot.expires_at || previousAt !== null && tick.created_at - previousAt < bot.cooldown_ms
      || typeof tick.request_json !== 'string' || tick.request_json.length > 8192
      || typeof tick.receipt_json !== 'string' || tick.receipt_json.length > 8192) throw rollback;
    const request = canonical(bot, {botId: bot.bot_id, tickKey: tick.tick_key, side: tick.side, reservationId: tick.reservation_id});
    if (tick.request_json !== request || tick.request_hash !== sha(request) || tick.execution_key !== 'bot:' + sha(request)
      || tick.receipt_hash !== sha(tick.receipt_json) || receipts.has(tick.tick_key)) throw rollback;
    reservationMatches(db, bot, tick.side, tick.reservation_id);
    const fillTable = tick.side === 'buy' ? 'paper_fills' : 'paper_sell_fills';
    const fill = db.prepare(`SELECT created_at FROM ${fillTable} WHERE account_id=? AND reservation_id=? AND execution_key=?`)
      .get(bot.account_id, tick.reservation_id, tick.execution_key) as {created_at: number} | undefined;
    if (!fill || fill.created_at !== tick.created_at) throw rollback;
    const result = settlePaperRiskInTransaction(db, owner, {side: tick.side, accountId: bot.account_id,
      reservationId: tick.reservation_id, executionKey: tick.execution_key}, now, 'historical_only');
    if (!result.ok || result.replayed !== true) throw rollback;
    const receipt = {...result, replayed: false};
    if (JSON.stringify(receipt) !== tick.receipt_json) throw rollback;
    receipts.set(tick.tick_key, {tick, receipt});
    previousAt = tick.created_at;
  }
  return receipts;
}
/**
 * One caller-supplied reservation per durable tick. Successful fills alone consume the finite cap; failed attempts
 * are not journaled or counted. No scheduler, strategy generation, provider calls, attempt budget or live trading.
 */
export function runPaperBotTick(db: Database.Database, owner: string, input: unknown, clock: () => number = Date.now) {
  try {
    if (db.inTransaction || !id(owner) || !plain(input, ['botId', 'tickKey', 'side', 'reservationId'])
      || !['botId', 'tickKey', 'reservationId'].every(key => id(input[key])) || !['buy', 'sell'].includes(input.side as string)) return deny();
    // Normalize before invoking the caller's clock; later reads cannot change the requested intent.
    const intent: TickInput = {botId: input.botId as string, tickKey: input.tickKey as string, side: input.side as 'buy' | 'sell', reservationId: input.reservationId as string};
    return db.transaction(() => {
      const now = clock();
      if (!uint(now)) throw rollback;
      const bot = db.prepare('SELECT * FROM paper_bots WHERE bot_id=?').get(intent.botId) as Bot | undefined;
      if (!bot || bot.owner_id !== owner || !validBot(bot, now)) throw rollback;
      const account = db.prepare('SELECT owner_id FROM paper_accounts WHERE account_id=?').get(bot.account_id) as {owner_id: string} | undefined;
      if (account?.owner_id !== owner) throw rollback;
      const receipts = history(db, owner, bot, now), existing = receipts.get(intent.tickKey);
      const request = canonical(bot, intent), requestHash = sha(request), executionKey = 'bot:' + requestHash;
      if (existing) {
        if (existing.tick.request_json !== request) throw rollback;
        return {...existing.receipt, replayed: true, botId: bot.bot_id, tickKey: intent.tickKey};
      }
      if (bot.status !== 'active' || bot.expires_at <= now || bot.successful_ticks >= bot.max_successful_ticks
        || bot.last_success_at !== null && now - bot.last_success_at < bot.cooldown_ms) throw rollback;
      const risk = readPaperRisk(db, owner, bot.account_id, bot.policy_id, () => now);
      if (!risk.ok || !risk.allowed || risk.policyRevision !== bot.policy_revision || risk.appRevision !== bot.app_revision) throw rollback;
      reservationMatches(db, bot, intent.side, intent.reservationId);
      const result = settlePaperRiskInTransaction(db, owner, {side: intent.side, accountId: bot.account_id,
        reservationId: intent.reservationId, executionKey}, now, 'new_only');
      if (!result.ok || result.replayed !== false) throw rollback;
      const receipt = JSON.stringify(result);
      if (receipt.length > 8192 || request.length > 8192) throw rollback;
      db.prepare('INSERT INTO paper_bot_ticks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), bot.bot_id, bot.account_id,
        bot.policy_id, bot.policy_revision, bot.app_revision, intent.tickKey, intent.side, intent.reservationId, executionKey,
        request, requestHash, receipt, sha(receipt), now);
      db.prepare('UPDATE paper_bots SET successful_ticks=successful_ticks+1,last_success_at=? WHERE bot_id=?').run(now, bot.bot_id);
      return {...result, botId: bot.bot_id, tickKey: intent.tickKey};
    }).immediate();
  } catch { return deny(); }
}
