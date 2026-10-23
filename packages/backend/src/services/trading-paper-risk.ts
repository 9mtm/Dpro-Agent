/** Read-only conservative paper valuation. This is an advisory risk verdict, never execution authority. */
import type Database from 'better-sqlite3';
import {hasPaperTable, paperFillFeeLoss, readPaperAccount} from './trading-paper-ledger.js';
import {readPaperExecutionV2} from './trading-paper-read-v2.js';

const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const uint = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
const safe = (value: bigint) => value >= 0n && value <= MAX;
const deny = () => ({ok: false as const, reason: 'unavailable' as const});
const requiredTables = Object.freeze([
  'paper_reservation_intents', 'paper_execution_profiles', 'paper_execution_quotes',
  'paper_fills', 'paper_positions', 'paper_sell_reservations', 'paper_sell_fills',
]);

/**
 * Explicit SQLite ledger/execution/sell initialization is a caller prerequisite; this reader creates nothing.
 * All history is validated and all holdings are valued within one deferred snapshot. CPU grows with history;
 * retained output is bounded. Daily booked losses are UTC-day costs, not a drawdown or equity-reset baseline.
 */
export function readPaperRisk(
  db: Database.Database,
  ownerId: string,
  accountId: string,
  policyId: string,
  clock: () => number = Date.now,
) {
  if (![ownerId, accountId, policyId].every(id)) return deny();
  try {
    return db.transaction(() => {
      const assessedAt = clock();
      if (!uint(assessedAt) || requiredTables.some(table => !hasPaperTable(db, table))) return deny();
      const view = readPaperAccount(db, ownerId, accountId);
      if (!view.ok || view.mode !== 'paper' || !view.appEnabled || view.stopped) return deny();
      // v2's full receipt recomputation is required even when the account has never sold.
      const verified = readPaperExecutionV2(db, ownerId, accountId, view.currency, view.exposure);
      if (!verified || verified.execution.untrackedExposure !== 0) return deny();
      // An assessment cannot rely on accepted or settled events from a future clock epoch.
      for (const table of ['paper_reservations', 'paper_fills', 'paper_sell_reservations', 'paper_sell_fills']) {
        const event = db.prepare(`SELECT max(created_at) latest FROM ${table} WHERE account_id=?`).get(accountId) as {latest: number | null};
        if (event.latest !== null && (!uint(event.latest) || event.latest > assessedAt)) return deny();
      }
      for (const table of ['paper_reservations', 'paper_sell_reservations']) {
        const event = db.prepare(`SELECT max(cancelled_at) latest FROM ${table} WHERE account_id=?`).get(accountId) as {latest: number | null};
        if (event.latest !== null && (!uint(event.latest) || event.latest > assessedAt)) return deny();
      }
      const saved = db.prepare('SELECT revision,policy_json FROM paper_policies WHERE account_id=? AND policy_id=?')
        .get(accountId, policyId) as {revision: number; policy_json: string} | undefined;
      if (!saved || !uint(saved.revision, 1) || typeof saved.policy_json !== 'string' || saved.policy_json.length > 65536) return deny();
      const policy = JSON.parse(saved.policy_json);
      if (!policy || policy.id !== policyId || policy.ownerId !== ownerId || policy.accountId !== accountId
        || policy.mode !== 'paper' || policy.enabled !== true || policy.currency !== view.currency
        || policy.revision !== saved.revision || policy.appRevision !== view.appRevision
        || !uint(policy.expiresAt, 1) || policy.expiresAt <= assessedAt
        || !uint(policy.maxExposure, 1) || !uint(policy.maxDailyLoss, 1) || !uint(policy.maxQuoteAgeMs, 1)
        || !Array.isArray(policy.symbols) || !policy.symbols.every(id)) return deny();
      const profile = db.prepare('SELECT * FROM paper_execution_profiles WHERE account_id=?').get(accountId) as {
        account_id: string; owner_id: string; currency: string; unit_scale: number;
        revision: number; fee_bps: number; slippage_bps: number;
      } | undefined;
      if (!profile || profile.account_id !== accountId || profile.owner_id !== ownerId || profile.currency !== view.currency
        || profile.unit_scale !== 1 || !uint(profile.revision, 1) || !uint(profile.fee_bps) || profile.fee_bps > 10000
        || !uint(profile.slippage_bps) || profile.slippage_bps > 10000) return deny();
      let positionCount = 0n, bookExposure = 0n, markedExposure = 0n, netLiquidationValue = 0n;
      let estimatedLiquidationFee = 0n, unrealizedPnL = 0n, positiveLiquidationLoss = 0n;
      let minQuoteAt: number | null = null, maxQuoteAt: number | null = null;
      for (const raw of db.prepare('SELECT symbol,quantity_units,cost_minor FROM paper_positions WHERE account_id=? ORDER BY symbol').iterate(accountId)) {
        const position = raw as {symbol: string; quantity_units: number; cost_minor: number};
        if (!id(position.symbol) || !uint(position.quantity_units) || !uint(position.cost_minor)
          || (position.quantity_units === 0) !== (position.cost_minor === 0)) return deny();
        if (position.quantity_units === 0) continue;
        const quote = db.prepare('SELECT q.*,f.quote_at FROM paper_execution_quotes q LEFT JOIN paper_quotes f ON f.account_id=q.account_id AND f.symbol=q.symbol WHERE q.account_id=? AND q.symbol=?')
          .get(accountId, position.symbol) as {account_id: string; symbol: string; currency: string; unit_scale: number; revision: number; price_minor: number; quoted_at: number; quote_at: number} | undefined;
        if (!quote || quote.account_id !== accountId || quote.symbol !== position.symbol || quote.currency !== view.currency
          || quote.unit_scale !== 1 || !uint(quote.revision, 1) || !uint(quote.price_minor, 1) || !uint(quote.quoted_at)
          || quote.quote_at !== quote.quoted_at || quote.quoted_at > assessedAt || assessedAt - quote.quoted_at > policy.maxQuoteAgeMs) return deny();
        const bid = BigInt(quote.price_minor) * (10000n - BigInt(profile.slippage_bps)) / 10000n;
        const gross = BigInt(position.quantity_units) * bid;
        const fee = (gross * BigInt(profile.fee_bps) + 9999n) / 10000n;
        const net = gross - fee, cost = BigInt(position.cost_minor), difference = net - cost;
        if (bid < 1n || ![bid, gross, fee, net].every(safe) || difference < -MAX || difference > MAX) return deny();
        positionCount++; bookExposure += cost; markedExposure += gross; netLiquidationValue += net;
        estimatedLiquidationFee += fee; unrealizedPnL += difference;
        positiveLiquidationLoss += difference < 0n ? -difference : 0n;
        if (![positionCount, bookExposure, markedExposure, netLiquidationValue, estimatedLiquidationFee, positiveLiquidationLoss].every(safe)
          || unrealizedPnL < -MAX || unrealizedPnL > MAX) return deny();
        minQuoteAt = minQuoteAt === null ? quote.quoted_at : Math.min(minQuoteAt, quote.quoted_at);
        maxQuoteAt = maxQuoteAt === null ? quote.quoted_at : Math.max(maxQuoteAt, quote.quoted_at);
      }
      const bookedDailyLoss = paperFillFeeLoss(db, accountId, assessedAt);
      if (!uint(bookedDailyLoss) || bookExposure !== BigInt(view.exposure)) return deny();
      const pendingBuyExposure = BigInt(view.pendingExposure);
      const conservativeLoss = BigInt(bookedDailyLoss) + positiveLiquidationLoss;
      const equity = BigInt(view.cash) + netLiquidationValue;
      const bookAndPending = bookExposure + pendingBuyExposure, markedAndPending = markedExposure + pendingBuyExposure;
      if (![pendingBuyExposure, conservativeLoss, equity, bookAndPending, markedAndPending].every(safe)) return deny();
      return {
        ok: true as const, mode: 'paper' as const, accountId, policyId, policyRevision: saved.revision,
        appRevision: view.appRevision, currency: view.currency, assessedAt, positionCount: Number(positionCount),
        bookExposure: Number(bookExposure), markedExposure: Number(markedExposure), pendingBuyExposure: Number(pendingBuyExposure),
        netLiquidationValue: Number(netLiquidationValue), estimatedLiquidationFee: Number(estimatedLiquidationFee),
        unrealizedPnL: Number(unrealizedPnL), positiveLiquidationLoss: Number(positiveLiquidationLoss), bookedDailyLoss,
        conservativeLoss: Number(conservativeLoss), equity: Number(equity), minQuoteAt, maxQuoteAt,
        allowed: conservativeLoss < BigInt(policy.maxDailyLoss)
          && bookAndPending <= BigInt(policy.maxExposure) && markedAndPending <= BigInt(policy.maxExposure),
      };
    }).deferred();
  } catch {
    return deny();
  }
}
