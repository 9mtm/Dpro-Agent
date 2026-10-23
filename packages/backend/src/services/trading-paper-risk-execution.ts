/** Optional atomic risk gate. Low-level paper fill primitives remain separate and are not wired through this wrapper. */
import type Database from 'better-sqlite3';
import {executePaperBuy} from './trading-paper-execution.js';
import {executePaperSell} from './trading-paper-sells.js';
import {readPaperRisk} from './trading-paper-risk.js';

const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const deny = () => ({ok: false as const, reason: 'unavailable' as const});
const fields = ['side', 'accountId', 'reservationId', 'executionKey'];
type Request = {side: 'buy' | 'sell'; accountId: string; reservationId: string; executionKey: string};
function request(value: unknown): value is Request {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key)
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) return false;
  const input = value as Request;
  return (input.side === 'buy' || input.side === 'sell') && [input.accountId, input.reservationId, input.executionKey].every(id);
}
const rollback = Symbol('risk settlement rollback');
/**
 * Acquires its own IMMEDIATE transaction; caller transactions are refused. Samples the clock once after locking.
 * A historical replay only acknowledges a matching persisted receipt. Every new effect passes current risk before
 * and after settlement; any failure rolls back the entire transaction, including SQLite trigger side effects.
 * No schema initialization, HTTP authorization, broker access or runtime registration occurs here.
 */
export function executeRiskCheckedPaperOrder(
  db: Database.Database,
  ownerId: string,
  input: unknown,
  clock: () => number = Date.now,
) {
  try {
    if (!id(ownerId) || !request(input) || db.inTransaction) return deny();
    return db.transaction(() => {
      const now = clock();
      if (!Number.isSafeInteger(now) || now < 0) throw rollback;
      const {accountId, reservationId, executionKey, side} = input;
      const account = db.prepare('SELECT owner_id FROM paper_accounts WHERE account_id=?').get(accountId) as {owner_id: string} | undefined;
      if (account?.owner_id !== ownerId) throw rollback;
      const ownTable = side === 'buy' ? 'paper_fills' : 'paper_sell_fills';
      const otherTable = side === 'buy' ? 'paper_sell_fills' : 'paper_fills';
      // Table names are fixed server constants; no input is interpolated into SQL identifiers.
      if (db.prepare(`SELECT 1 FROM ${otherTable} WHERE account_id=? AND execution_key=?`).get(accountId, executionKey)) throw rollback;
      const historical = db.prepare(`SELECT reservation_id FROM ${ownTable} WHERE account_id=? AND execution_key=?`).get(accountId, executionKey) as {reservation_id: string} | undefined;
      const execute = side === 'buy' ? executePaperBuy : executePaperSell;
      const identity = {accountId, reservationId, executionKey};
      if (historical) {
        if (historical.reservation_id !== reservationId) throw rollback;
        const result = execute(db, ownerId, identity, () => now);
        if (!result.ok || !result.replayed) throw rollback;
        return result;
      }
      // A different execution key cannot reuse any settled reservation.
      if (db.prepare(`SELECT 1 FROM ${ownTable} WHERE account_id=? AND reservation_id=?`).get(accountId, reservationId)) throw rollback;
      const reservationTable = side === 'buy' ? 'paper_reservations' : 'paper_sell_reservations';
      const reservationColumn = side === 'buy' ? 'reservation_id' : 'id';
      const reservation = db.prepare(`SELECT policy_id FROM ${reservationTable} WHERE account_id=? AND ${reservationColumn}=?`)
        .get(accountId, reservationId) as {policy_id: string} | undefined;
      if (!reservation || !id(reservation.policy_id)) throw rollback;
      const before = readPaperRisk(db, ownerId, accountId, reservation.policy_id, () => now);
      if (!before.ok || !before.allowed) throw rollback;
      const result = execute(db, ownerId, identity, () => now);
      if (!result.ok || result.replayed) throw rollback;
      const after = readPaperRisk(db, ownerId, accountId, reservation.policy_id, () => now);
      if (!after.ok || !after.allowed) throw rollback;
      return result;
    }).immediate();
  } catch {
    return deny();
  }
}
