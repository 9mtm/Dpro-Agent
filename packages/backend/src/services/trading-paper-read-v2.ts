/** Read-only sell-aware integrity projection. No initialization, policy changes or trading authority. */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { inspectPaperSellHistory } from './trading-paper-sells.js';
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const safe = (v: bigint) => v >= 0n && v <= MAX;
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const uint = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
type BuyFill = {
    id: string;
    reservationId: string;
    symbol: string;
    side: 'buy';
    quantityUnits: number;
    priceMinor: number;
    feeMinor: number;
    totalMinor: number;
    createdAt: number;
};
function buyIntent(r: Record<string, unknown>, saved: Record<string, unknown>, account: string, currency: string) {
    if (typeof saved.canonical_json !== 'string' || saved.canonical_json.length > 8192 || sha(saved.canonical_json) !== r.intent_hash)
        return null;
    let i;
    try {
        i = JSON.parse(saved.canonical_json);
    }
    catch {
        return null;
    }
    if (!object(i) || Object.keys(i).length !== 9 || i.accountId !== account || i.currency !== currency || i.policyId !== r.policy_id || i.symbol === undefined || i.notional !== r.notional || i.idempotencyKey !== r.idempotency_key || !['buy', 'sell'].includes(i.side as string) || !id(i.symbol) || !id(i.policyId) || !id(i.idempotencyKey) || !uint(i.policyRevision, 1) || !uint(i.appRevision, 1) || !uint(i.notional, 1))
        return null;
    const canonical = { accountId: i.accountId, policyId: i.policyId, policyRevision: i.policyRevision, appRevision: i.appRevision, currency: i.currency, symbol: i.symbol, side: i.side, notional: i.notional, idempotencyKey: i.idempotencyKey };
    return JSON.stringify(canonical) === saved.canonical_json ? canonical : null;
}
function buyReceipt(r: Record<string, unknown>, saved: Record<string, unknown>, f: Record<string, unknown>, account: string, currency: string, owner: string): BuyFill | null {
    const i = buyIntent(r, saved, account, currency);
    if (!i || i.side !== 'buy' || f.account_id !== account || f.reservation_id !== r.reservation_id || r.status !== 'pending' || r.cancelled_at !== null || !id(f.fill_id) || !id(f.execution_key) || !uint(f.quantity_units, 1) || !uint(f.price_minor, 1) || !uint(f.fee_minor) || !uint(f.total_minor, 1) || !uint(f.created_at) || !uint(r.created_at) || f.created_at < r.created_at || f.intent_hash !== r.intent_hash)
        return null;
    if (f.request_hash !== sha(JSON.stringify({ accountId: account, reservationId: r.reservation_id, executionKey: f.execution_key })))
        return null;
    let p, q;
    try {
        if (typeof saved.profile_json !== 'string' || typeof saved.quote_json !== 'string' || saved.profile_json.length > 8192 || saved.quote_json.length > 8192 || sha(saved.profile_json) !== saved.profile_hash || sha(saved.quote_json) !== saved.quote_hash)
            return null;
        p = JSON.parse(saved.profile_json);
        q = JSON.parse(saved.quote_json);
    }
    catch {
        return null;
    }
    if (!object(p) || !object(q) || p.account_id !== account || p.owner_id !== owner || p.currency !== currency || p.unit_scale !== 1 || !uint(p.revision, 1) || !uint(p.fee_bps) || p.fee_bps > 10000 || !uint(p.slippage_bps) || p.slippage_bps > 10000 || q.account_id !== account || q.symbol !== i.symbol || q.currency !== currency || q.unit_scale !== 1 || !uint(q.revision, 1) || !uint(q.price_minor, 1) || !uint(q.quoted_at) || q.quoted_at > r.created_at)
        return null;
    const price = ceil(BigInt(q.price_minor) * (10000n + BigInt(p.slippage_bps)), 10000n), units = BigInt(i.notional) * 10000n / (price * (10000n + BigInt(p.fee_bps))), gross = units * price, fee = ceil(gross * BigInt(p.fee_bps), 10000n), total = gross + fee;
    if (![price, units, gross, fee, total].every(safe) || units < 1n || price !== BigInt(f.price_minor) || units !== BigInt(f.quantity_units) || fee !== BigInt(f.fee_minor) || total !== BigInt(f.total_minor))
        return null;
    return { id: f.fill_id, reservationId: r.reservation_id as string, symbol: i.symbol, side: 'buy', quantityUnits: f.quantity_units, priceMinor: f.price_minor, feeMinor: f.fee_minor, totalMinor: f.total_minor, createdAt: f.created_at };
}
/** Called inside the account reader's existing SQLite snapshot. Scans history with constant JS memory. */
export function readPaperExecutionV2(db: Database.Database, owner: string, account: string, currency: string, exposure: number) {
    try {
        return project(db, owner, account, currency, exposure);
    }
    catch {
        return null;
    }
}
function project(db: Database.Database, owner: string, account: string, currency: string, exposure: number) {
    if (!id(owner) || !id(account) || !uint(exposure))
        return null;
    // Side-specific keys still share one account namespace. IDs cannot collide across union projections.
    for (const sql of [
        'SELECT 1 FROM paper_reservations b JOIN paper_sell_reservations s ON b.account_id=s.account_id AND (b.idempotency_key=s.idempotency_key OR b.reservation_id=s.id) WHERE b.account_id=? LIMIT 1',
        'SELECT 1 FROM paper_fills b JOIN paper_sell_fills s ON b.account_id=s.account_id AND (b.execution_key=s.execution_key OR b.fill_id=s.id) WHERE b.account_id=? LIMIT 1'
    ])
        if (db.prepare(sql).get(account))
            return null;
    let buyCount = 0n, sellCount = 0n, buyFees = 0n, sellFees = 0n, buyGross = 0n, sellGross = 0n, removed = 0n, pnl = 0n, marketLoss = 0n, reservations = 0n, pending = 0n, reservedUnits = 0n;
    for (const raw of db.prepare('SELECT * FROM paper_reservations WHERE account_id=?').iterate(account)) {
        const r = raw as Record<string, unknown>;
        if (!id(r.reservation_id) || !id(r.policy_id) || !uint(r.notional, 1) || !uint(r.created_at) || !id(r.idempotency_key) || !['pending', 'cancelled'].includes(r.status as string) || (r.status === 'pending' ? r.cancelled_at !== null : !uint(r.cancelled_at) || r.cancelled_at < r.created_at))
            return null;
        const saved = db.prepare('SELECT * FROM paper_reservation_intents WHERE reservation_id=?').get(r.reservation_id) as Record<string, unknown> | undefined;
        if (!saved || !buyIntent(r, saved, account, currency))
            return null;
        const f = db.prepare('SELECT * FROM paper_fills WHERE reservation_id=?').get(r.reservation_id) as Record<string, unknown> | undefined;
        if (f) {
            const valid = buyReceipt(r, saved, f, account, currency, owner);
            if (!valid)
                return null;
            buyCount++;
            buyFees += BigInt(valid.feeMinor);
            buyGross += BigInt(valid.quantityUnits) * BigInt(valid.priceMinor);
            if (![buyCount, buyFees, buyGross].every(safe))
                return null;
        }
    }
    for (const raw of db.prepare('SELECT * FROM paper_sell_reservations WHERE account_id=?').iterate(account)) {
        const r = raw as Record<string, unknown>, f = db.prepare('SELECT * FROM paper_sell_fills WHERE reservation_id=?').get(r.id) ?? null;
        const valid = inspectPaperSellHistory(r, f, owner);
        if (!valid || valid.intent.accountId !== account || valid.intent.currency !== currency)
            return null;
        reservations++;
        if (r.status === 'pending') {
            pending++;
            reservedUnits += BigInt(valid.intent.quantityUnits);
        }
        if (valid.fill) {
            const fill = valid.fill;
            sellCount++;
            sellFees += BigInt(fill.feeMinor);
            sellGross += BigInt(fill.grossMinor);
            removed += BigInt(fill.removedCostMinor);
            pnl += BigInt(fill.realizedPnLMinor);
            marketLoss += BigInt(fill.marketLossMinor);
        }
        if (![reservations, pending, reservedUnits, sellCount, sellFees, sellGross, removed, marketLoss].every(safe) || pnl < -MAX || pnl > MAX)
            return null;
    }
    // Reject orphan fills and all uniqueness inconsistencies even outside display windows.
    for (const [table, count, pk] of [['paper_fills', buyCount, 'fill_id'], ['paper_sell_fills', sellCount, 'id']] as const) {
        const r = db.prepare(`SELECT count(*) n,count(DISTINCT ${pk}) ids,count(DISTINCT reservation_id) reservations,count(DISTINCT execution_key) keys FROM ${table} WHERE account_id=?`).safeIntegers(true).get(account) as Record<string, bigint>;
        if (Object.values(r).some(n => n !== count))
            return null;
    }
    const fillCount = buyCount + sellCount, feeTotal = buyFees + sellFees, cost = buyGross - removed;
    if (![fillCount, feeTotal, cost].every(safe) || cost > BigInt(exposure) || pnl !== sellGross - sellFees - removed)
        return null;
    const grouped = `WITH changes AS (
 SELECT json_extract(i.canonical_json,'$.symbol') symbol,f.quantity_units units,f.total_minor-f.fee_minor cost FROM paper_fills f JOIN paper_reservation_intents i ON i.reservation_id=f.reservation_id WHERE f.account_id=?
 UNION ALL SELECT r.symbol,-f.quantity_units,-f.removed_cost_minor FROM paper_sell_fills f JOIN paper_sell_reservations r ON r.id=f.reservation_id WHERE f.account_id=?
 ), expected AS (SELECT symbol,sum(units) units,sum(cost) cost FROM changes GROUP BY symbol)`;
    let positionCount = 0n, positionCost = 0n;
    for (const raw of db.prepare(grouped + ' SELECT p.symbol,p.quantity_units,p.cost_minor,e.units,e.cost FROM paper_positions p LEFT JOIN expected e ON e.symbol=p.symbol WHERE p.account_id=?').safeIntegers(true).iterate(account, account, account)) {
        const p = raw as {
            symbol: string;
            quantity_units: bigint;
            cost_minor: bigint;
            units: bigint | null;
            cost: bigint | null;
        };
        if (!id(p.symbol) || typeof p.quantity_units !== 'bigint' || typeof p.cost_minor !== 'bigint' || !safe(p.quantity_units) || !safe(p.cost_minor) || p.quantity_units !== p.units || p.cost_minor !== p.cost || (p.quantity_units === 0n) !== (p.cost_minor === 0n))
            return null;
        if (p.quantity_units > 0n) {
            positionCount++;
            positionCost += p.cost_minor;
        }
        if (![positionCount, positionCost].every(safe))
            return null;
    }
    if (positionCost !== cost || db.prepare(grouped + ' SELECT 1 FROM expected e LEFT JOIN paper_positions p ON p.account_id=? AND p.symbol=e.symbol WHERE p.symbol IS NULL LIMIT 1').get(account, account, account))
        return null;
    const inventory = db.prepare("SELECT s.symbol,sum(s.quantity_units) units,p.quantity_units held FROM paper_sell_reservations s LEFT JOIN paper_positions p ON p.account_id=s.account_id AND p.symbol=s.symbol WHERE s.account_id=? AND s.status='pending' GROUP BY s.symbol").safeIntegers(true);
    for (const raw of inventory.iterate(account)) {
        const row = raw as {
            units: bigint;
            held: bigint | null;
        };
        if (typeof row.units !== 'bigint' || typeof row.held !== 'bigint' || !safe(row.units) || row.units > row.held)
            return null;
    }
    const fills: Array<BuyFill | NonNullable<NonNullable<ReturnType<typeof inspectPaperSellHistory>>['fill']>> = [];
    const recent = db.prepare("SELECT fill_id id,'buy' side,created_at FROM paper_fills WHERE account_id=? UNION ALL SELECT id,'sell',created_at FROM paper_sell_fills WHERE account_id=? ORDER BY created_at DESC,id DESC LIMIT 200").all(account, account) as {
        id: string;
        side: 'buy' | 'sell';
        created_at: number;
    }[];
    for (const f of recent) {
        if (f.side === 'buy') {
            const raw = db.prepare('SELECT * FROM paper_fills WHERE fill_id=? AND account_id=?').get(f.id, account) as Record<string, unknown>, r = db.prepare('SELECT * FROM paper_reservations WHERE reservation_id=?').get(raw.reservation_id) as Record<string, unknown>, saved = db.prepare('SELECT * FROM paper_reservation_intents WHERE reservation_id=?').get(raw.reservation_id) as Record<string, unknown>;
            const valid = buyReceipt(r, saved, raw, account, currency, owner);
            if (!valid)
                return null;
            fills.push(valid);
        }
        else {
            const raw = db.prepare('SELECT * FROM paper_sell_fills WHERE id=? AND account_id=?').get(f.id, account) as Record<string, unknown>, r = db.prepare('SELECT * FROM paper_sell_reservations WHERE id=?').get(raw.reservation_id);
            const valid = inspectPaperSellHistory(r, raw, owner);
            if (!valid?.fill)
                return null;
            fills.push(valid.fill);
        }
    }
    const positions = (db.prepare('SELECT symbol,quantity_units,cost_minor FROM paper_positions WHERE account_id=? AND quantity_units>0 ORDER BY symbol LIMIT 100').all(account) as {
        symbol: string;
        quantity_units: number;
        cost_minor: number;
    }[]).map(p => ({ symbol: p.symbol, quantityUnits: p.quantity_units, costMinor: p.cost_minor }));
    const history = [];
    for (const raw of db.prepare('SELECT * FROM paper_sell_reservations WHERE account_id=? ORDER BY created_at DESC,id DESC LIMIT 200').all(account)) {
        const r = raw as Record<string, unknown>, f = db.prepare('SELECT * FROM paper_sell_fills WHERE reservation_id=?').get(r.id) as Record<string, unknown> | undefined;
        history.push({ id: r.id as string, policyId: r.policy_id as string, symbol: r.symbol as string, quantityUnits: r.quantity_units as number, createdAt: r.created_at as number, status: r.status as 'pending' | 'cancelled' | 'filled', cancelledAt: r.cancelled_at as number | null, ...(f ? { fillId: f.id as string, filledAt: f.created_at as number } : {}) });
    }
    return { execution: { version: 2 as const, mode: 'paper' as const, fillCount: Number(fillCount), feeTotal: Number(feeTotal), positionCount: Number(positionCount), positionCost: Number(positionCost), untrackedExposure: exposure - Number(positionCost), fills: fills.reverse(), positions, buyFillCount: Number(buyCount), sellFillCount: Number(sellCount), buyFeeTotal: Number(buyFees), sellFeeTotal: Number(sellFees), buyGrossTotal: Number(buyGross), sellGrossTotal: Number(sellGross), removedCostTotal: Number(removed), realizedPnLTotal: Number(pnl), marketLossTotal: Number(marketLoss) }, sellHistory: { reservationCount: Number(reservations), pendingCount: Number(pending), reservedUnits: Number(reservedUnits), reservations: history.reverse() } };
}
