/** Whole-unit inventory sale simulation. Explicit private SQLite initializer; no live/API wiring. */
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { admitPaperOrder } from './trading-paper-policy.js';
import { paperLedgerTotals, paperFillFeeLoss } from './trading-paper-ledger.js';
const id = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x);
const uint = (x: unknown, min = 0): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= min;
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x) && [Object.prototype, null].includes(Object.getPrototypeOf(x)) && Reflect.ownKeys(x).every(k => typeof k === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(x, k)!, 'value'));
const sha = (s: string) => createHash('sha256').update(s).digest('hex'), MAX = BigInt(Number.MAX_SAFE_INTEGER), safe = (n: bigint) => n >= 0n && n <= MAX, ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
const no = (reason: string) => ({ ok: false as const, reason });
type Intent = {
    accountId: string;
    policyId: string;
    policyRevision: number;
    appRevision: number;
    currency: string;
    symbol: string;
    quantityUnits: number;
    idempotencyKey: string;
};
function intentOf(input: unknown): Intent | null {
    if (!object(input)
        || Object.keys(input).length !== 8
        || !['accountId', 'policyId', 'symbol', 'idempotencyKey'].every(k => id(input[k]))
        || !uint(input.policyRevision, 1)
        || !uint(input.appRevision, 1)
        || !uint(input.quantityUnits, 1)
        || typeof input.currency !== 'string'
        || !/^[A-Z]{3}$/.test(input.currency))
        return null;
    return {
        accountId: input.accountId as string, policyId: input.policyId as string, policyRevision: input.policyRevision, appRevision: input.appRevision, currency: input.currency, symbol: input.symbol as string, quantityUnits: input.quantityUnits, idempotencyKey: input.idempotencyKey as string
    };
}
type Reservation = {
    id: string;
    account_id: string;
    policy_id: string;
    symbol: string;
    quantity_units: number;
    idempotency_key: string;
    intent_hash: string;
    intent_json: string;
    status: 'pending' | 'cancelled' | 'filled';
    created_at: number;
    cancelled_at: number | null;
    profile_json: string;
    profile_hash: string;
    quote_json: string;
    quote_hash: string;
    position_json: string;
    position_hash: string;
};
function savedIntent(r: Reservation, now: number): Intent | null {
    if (!id(r.id) || !uint(r.created_at) || r.created_at > now
        || !['pending', 'cancelled', 'filled'].includes(r.status)
        || typeof r.intent_json !== 'string' || r.intent_json.length > 8192
        || sha(r.intent_json) !== r.intent_hash
        || (r.status === 'cancelled'
            ? !uint(r.cancelled_at) || r.cancelled_at < r.created_at || r.cancelled_at > now
            : r.cancelled_at !== null))
        return null;
    try {
        const intent = intentOf(JSON.parse(r.intent_json));
        return intent && JSON.stringify(intent) === r.intent_json
            && intent.accountId === r.account_id && intent.policyId === r.policy_id
            && intent.symbol === r.symbol && intent.quantityUnits === r.quantity_units
            && intent.idempotencyKey === r.idempotency_key ? intent : null;
    }
    catch {
        return null;
    }
}
export function initializePaperSells(db: Database.Database) {
    db.transaction(() => db.exec(`CREATE TABLE IF NOT EXISTS paper_sell_reservations(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,policy_id TEXT NOT NULL,symbol TEXT NOT NULL,quantity_units INTEGER NOT NULL,idempotency_key TEXT NOT NULL,intent_hash TEXT NOT NULL,intent_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','cancelled','filled')),created_at INTEGER NOT NULL,cancelled_at INTEGER,profile_json TEXT NOT NULL,profile_hash TEXT NOT NULL,quote_json TEXT NOT NULL,quote_hash TEXT NOT NULL,position_json TEXT NOT NULL,position_hash TEXT NOT NULL,UNIQUE(account_id,idempotency_key));
 CREATE TABLE IF NOT EXISTS paper_sell_fills(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,reservation_id TEXT NOT NULL UNIQUE,execution_key TEXT NOT NULL,request_hash TEXT NOT NULL,quantity_units INTEGER NOT NULL,price_minor INTEGER NOT NULL,gross_minor INTEGER NOT NULL,fee_minor INTEGER NOT NULL,net_minor INTEGER NOT NULL,removed_cost_minor INTEGER NOT NULL,realized_pnl_minor INTEGER NOT NULL,market_loss_minor INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(account_id,execution_key));`)).immediate();
}
type Context = NonNullable<ReturnType<typeof context>>;
function context(db: Database.Database, owner: string, intent: Intent) {
    const a = db.prepare('SELECT * FROM paper_accounts WHERE account_id=?').get(intent.accountId) as {
        owner_id: string;
        mode: string;
        currency: string;
        cash: number;
        exposure: number;
        app_enabled: number;
        app_revision: number;
        stopped: number;
    } | undefined;
    if (!a
        || a.owner_id !== owner
        || a.mode !== 'paper'
        || !uint(a.cash)
        || !uint(a.exposure)
        || !uint(a.app_revision, 1)
        || ![0, 1].includes(a.app_enabled)
        || ![0, 1].includes(a.stopped)
        || a.currency !== intent.currency)
        return null;
    const policy = db.prepare('SELECT policy_json,revision FROM paper_policies WHERE policy_id=? AND account_id=?').get(intent.policyId, intent.accountId) as {
        policy_json: string;
        revision: number;
    } | undefined;
    if (!policy || policy.policy_json.length > 65536)
        return null;
    let p: Record<string, unknown>;
    try {
        p = JSON.parse(policy.policy_json);
    }
    catch {
        return null;
    }
    if (!object(p) || p.revision !== policy.revision)
        return null;
    const profile = db.prepare('SELECT account_id,owner_id,revision,fee_bps,slippage_bps,unit_scale,currency FROM paper_execution_profiles WHERE account_id=?').get(intent.accountId) as {
        account_id: string;
        owner_id: string;
        revision: number;
        fee_bps: number;
        slippage_bps: number;
        unit_scale: number;
        currency: string;
    } | undefined;
    const quote = db.prepare('SELECT account_id,symbol,price_minor,quoted_at,revision,currency,unit_scale FROM paper_execution_quotes WHERE account_id=? AND symbol=?').get(intent.accountId, intent.symbol) as {
        account_id: string;
        symbol: string;
        price_minor: number;
        quoted_at: number;
        revision: number;
        currency: string;
        unit_scale: number;
    } | undefined;
    const position = db.prepare('SELECT quantity_units,cost_minor FROM paper_positions WHERE account_id=? AND symbol=?').get(intent.accountId, intent.symbol) as {
        quantity_units: number;
        cost_minor: number;
    } | undefined;
    const fresh = db.prepare('SELECT quote_at FROM paper_quotes WHERE account_id=? AND symbol=?').get(intent.accountId, intent.symbol) as {
        quote_at: number;
    } | undefined;
    if (!profile
        || !quote
        || !position
        || profile.owner_id !== owner
        || profile.currency !== a.currency
        || quote.currency !== a.currency
        || profile.unit_scale !== 1
        || quote.unit_scale !== 1
        || !uint(profile.revision, 1)
        || !uint(quote.revision, 1)
        || !uint(profile.fee_bps)
        || profile.fee_bps > 10000
        || !uint(profile.slippage_bps)
        || profile.slippage_bps > 10000
        || !uint(quote.price_minor, 1)
        || !uint(quote.quoted_at)
        || fresh?.quote_at !== quote.quoted_at
        || !uint(position.quantity_units, 1)
        || !uint(position.cost_minor, 1)
        || position.cost_minor > a.exposure)
        return null;
    // Initial untracked exposure does not establish sellable inventory. Reconcile only simulated fills.
    try {
        const buys = db.prepare(`SELECT COALESCE(sum(f.quantity_units),0) units,COALESCE(sum(f.total_minor-f.fee_minor),0) cost FROM paper_fills f JOIN paper_reservation_intents i ON i.reservation_id=f.reservation_id WHERE f.account_id=? AND json_extract(i.canonical_json,'$.symbol')=?`).safeIntegers(true).get(intent.accountId, intent.symbol) as {
            units: bigint;
            cost: bigint;
        };
        const sells = db.prepare('SELECT COALESCE(sum(f.quantity_units),0) units,COALESCE(sum(f.removed_cost_minor),0) cost FROM paper_sell_fills f JOIN paper_sell_reservations r ON r.id=f.reservation_id WHERE f.account_id=? AND r.symbol=?').safeIntegers(true).get(intent.accountId, intent.symbol) as {
            units: bigint;
            cost: bigint;
        };
        if (typeof buys.units !== 'bigint'
        || typeof buys.cost !== 'bigint'
        || typeof sells.units !== 'bigint'
        || typeof sells.cost !== 'bigint'
        || ![buys.units, buys.cost, sells.units, sells.cost].every(safe)
        || buys.units - sells.units !== BigInt(position.quantity_units)
        || buys.cost - sells.cost !== BigInt(position.cost_minor))
            return null;
    }
    catch {
        return null;
    }
    return {
        a, p, profile, quote, position
    };
}
function inventory(db: Database.Database, intent: Intent, exclude = ''): bigint | null {
    let amount = 0n;
    for (const raw of db.prepare("SELECT * FROM paper_sell_reservations WHERE account_id=? AND symbol=? AND status='pending' AND id<>?").iterate(intent.accountId, intent.symbol, exclude)) {
        const r = raw as Reservation;
        if (!uint(r.quantity_units, 1) || typeof r.intent_json !== 'string' || r.intent_json.length > 8192 || sha(r.intent_json) !== r.intent_hash)
            return null;
        let i;
        try {
            i = intentOf(JSON.parse(r.intent_json));
        }
        catch {
            return null;
        }
        if (!i || i.accountId !== intent.accountId || i.symbol !== intent.symbol || i.quantityUnits !== r.quantity_units || i.idempotencyKey !== r.idempotency_key)
            return null;
        amount += BigInt(r.quantity_units);
        if (!safe(amount))
            return null;
    }
    return amount;
}
function figures(c: Pick<Context, 'profile' | 'quote' | 'position'>, quantity: number) {
    const units = BigInt(quantity), held = BigInt(c.position.quantity_units);
    if (units > held)
        return null;
    const price = BigInt(c.quote.price_minor) * (10000n - BigInt(c.profile.slippage_bps)) / 10000n, gross = units * price, fee = ceil(gross * BigInt(c.profile.fee_bps), 10000n), net = gross - fee, removed = units === held ? BigInt(c.position.cost_minor) : BigInt(c.position.cost_minor) * units / held, marketLoss = removed > gross ? removed - gross : 0n, pnl = net - removed;
    if (price < 1n || ![price, gross, fee, net, removed, marketLoss].every(safe) || pnl < -MAX || pnl > MAX)
        return null;
    return {
        units, price, gross, fee, net, removed, marketLoss, pnl
    };
}
function admission(db: Database.Database, owner: string, intent: Intent, c: Context, now: number, exclude = '') {
    const f = figures(c, intent.quantityUnits), summary = paperLedgerTotals(db, intent.accountId, intent.policyId, now, exclude), loss = paperFillFeeLoss(db, intent.accountId, now), pending = inventory(db, intent, exclude);
    if (!f || !summary || loss === null || pending === null || pending + f.units > BigInt(c.position.quantity_units))
        return null;
    const verdict = admitPaperOrder(c.p, {
        ...intent, side: 'sell', notional: Number(f.gross)
    }, {
        accountId: intent.accountId, policyId: intent.policyId, policyRevision: c.p.revision, appRevision: c.a.app_revision, currency: c.a.currency, quoteSymbol: intent.symbol, accountMode: c.a.mode, ownerId: owner, appEnabled: c.a.app_enabled === 1, stopped: c.a.stopped !== 0, now, quoteAt: c.quote.quoted_at, exposure: c.a.exposure, reserved: summary.reserved, dailyLoss: loss, orders: summary.orders, lastOrderAt: summary.last, verifiedReduction: true, exposureReductionMinor: Number(f.removed)
    });
    return verdict.allowed ? { f, loss } : null;
}
export function reservePaperSell(db: Database.Database, owner: string, input: unknown, clock: () => number = Date.now) {
    const intent = intentOf(input);
    if (!id(owner) || !intent)
        return no('invalid');
    const json = JSON.stringify(intent), hash = sha(json);
    return db.transaction(() => {
        const now = clock();
        if (!uint(now))
            return no('invalid_clock');
        const ownerRow = db.prepare('SELECT owner_id FROM paper_accounts WHERE account_id=?').get(intent.accountId) as {
            owner_id: string;
        } | undefined;
        if (ownerRow?.owner_id !== owner)
            return no('unavailable');
        if (db.prepare('SELECT 1 FROM paper_reservations WHERE account_id=? AND idempotency_key=?').get(intent.accountId, intent.idempotencyKey))
            return no('idempotency_conflict');
        const old = db.prepare('SELECT * FROM paper_sell_reservations WHERE account_id=? AND idempotency_key=?').get(intent.accountId, intent.idempotencyKey) as Reservation | undefined;
        if (old) {
            const restored = savedIntent(old, now);
            const filled = db.prepare('SELECT * FROM paper_sell_fills WHERE account_id=? AND reservation_id=?').get(intent.accountId, old.id) as SellFill | undefined;
            if (!restored
        || old.intent_hash !== hash
        || JSON.stringify(restored) !== json
        || (old.status === 'filled') !== !!filled
        || filled && !validHistoricalReceipt(filled, old, owner, now))
                return no('idempotency_conflict');
            return {
                ok: true as const, reservationId: old.id, status: old.status, quantityUnits: old.quantity_units, replayed: true
            };
        }
        const c = context(db, owner, intent);
        if (!c || !admission(db, owner, intent, c, now))
            return no('unavailable');
        const profile = JSON.stringify(c.profile), quote = JSON.stringify(c.quote), position = JSON.stringify(c.position), rid = randomUUID();
        db.prepare("INSERT INTO paper_sell_reservations VALUES(?,?,?,?,?,?,?,?, 'pending',?,NULL,?,?,?,?,?,?)").run(rid, intent.accountId, intent.policyId, intent.symbol, intent.quantityUnits, intent.idempotencyKey, hash, json, now, profile, sha(profile), quote, sha(quote), position, sha(position));
        return {
            ok: true as const, reservationId: rid, status: 'pending' as const, quantityUnits: intent.quantityUnits, replayed: false
        };
    }).immediate();
}
export function cancelPaperSell(db: Database.Database, owner: string, account: string, reservationId: string, clock: () => number = Date.now) {
    if (![owner, account, reservationId].every(id))
        return no('invalid');
    return db.transaction(() => {
        const now = clock();
        if (!uint(now))
            return no('invalid_clock');
        const a = db.prepare('SELECT owner_id FROM paper_accounts WHERE account_id=?').get(account) as {
            owner_id: string;
        } | undefined;
        if (a?.owner_id !== owner)
            return no('unavailable');
        const r = db.prepare('SELECT * FROM paper_sell_reservations WHERE id=? AND account_id=?').get(reservationId, account) as Reservation | undefined;
        if (db.prepare('SELECT 1 FROM paper_sell_fills WHERE account_id=? AND reservation_id=?').get(account, reservationId)) return no('filled');
        if (!r || !uint(r.created_at) || r.created_at > now || !['pending', 'cancelled'].includes(r.status))
            return no('unavailable');
        if (r.status === 'cancelled')
            return {
                ok: true as const, replayed: true, status: 'cancelled' as const
            };
        db.prepare("UPDATE paper_sell_reservations SET status='cancelled',cancelled_at=? WHERE id=? AND status='pending'").run(now, reservationId);
        return {
            ok: true as const, replayed: false, status: 'cancelled' as const
        };
    }).immediate();
}
type SellFill = {
    id: string;
    account_id: string;
    reservation_id: string;
    execution_key: string;
    request_hash: string;
    quantity_units: number;
    price_minor: number;
    gross_minor: number;
    fee_minor: number;
    net_minor: number;
    removed_cost_minor: number;
    realized_pnl_minor: number;
    market_loss_minor: number;
    created_at: number;
};
const receipt = (f: SellFill, replayed: boolean) => ({
    ok: true as const, fillId: f.id, status: 'filled' as const, replayed, quantityUnits: f.quantity_units, priceMinor: f.price_minor, grossMinor: f.gross_minor, feeMinor: f.fee_minor, netMinor: f.net_minor, removedCostMinor: f.removed_cost_minor, realizedPnLMinor: f.realized_pnl_minor, marketLossMinor: f.market_loss_minor
});
function historicalFigures(r: Reservation, intent: Intent, owner: string) {
    try {
        for (const [json, hash] of [[r.profile_json, r.profile_hash], [r.quote_json, r.quote_hash], [r.position_json, r.position_hash]])
            if (typeof json !== 'string' || json.length > 8192 || sha(json) !== hash)
                return null;
        const profile: Context['profile'] = JSON.parse(r.profile_json), quote: Context['quote'] = JSON.parse(r.quote_json), position: Context['position'] = JSON.parse(r.position_json);
        if (!object(profile)
        || !object(quote)
        || !object(position)
        || profile.account_id !== intent.accountId
        || profile.owner_id !== owner
        || profile.currency !== intent.currency
        || profile.unit_scale !== 1
        || !uint(profile.revision, 1)
        || !uint(profile.fee_bps)
        || profile.fee_bps > 10000
        || !uint(profile.slippage_bps)
        || profile.slippage_bps > 10000
        || quote.account_id !== intent.accountId
        || quote.symbol !== intent.symbol
        || quote.currency !== intent.currency
        || quote.unit_scale !== 1
        || !uint(quote.revision, 1)
        || !uint(quote.quoted_at)
        || !uint(quote.price_minor, 1)
        || !uint(position.quantity_units, 1)
        || !uint(position.cost_minor, 1))
            return null;
        return figures({
            profile, quote, position
        }, intent.quantityUnits);
    }
    catch {
        return null;
    }
}
function validHistoricalReceipt(fill: SellFill, reservation: Reservation, owner: string, now: number): boolean {
    const intent = savedIntent(reservation, now);
    if (!intent || reservation.status !== 'filled' || reservation.cancelled_at !== null
        || !id(fill.id) || !id(fill.execution_key) || fill.account_id !== reservation.account_id
        || fill.reservation_id !== reservation.id || !uint(fill.created_at)
        || fill.created_at < reservation.created_at || fill.created_at > now
        || ![fill.quantity_units, fill.price_minor, fill.gross_minor].every(v => uint(v, 1))
        || ![fill.fee_minor, fill.net_minor, fill.removed_cost_minor, fill.market_loss_minor].every(v => uint(v))
        || !Number.isSafeInteger(fill.realized_pnl_minor)) return false;
    const requestHash = sha(JSON.stringify({accountId: fill.account_id, reservationId: fill.reservation_id, executionKey: fill.execution_key}));
    const f = historicalFigures(reservation, intent, owner);
    return fill.request_hash === requestHash && !!f
        && f.units === BigInt(fill.quantity_units) && f.price === BigInt(fill.price_minor)
        && f.gross === BigInt(fill.gross_minor) && f.fee === BigInt(fill.fee_minor)
        && f.net === BigInt(fill.net_minor) && f.removed === BigInt(fill.removed_cost_minor)
        && f.pnl === BigInt(fill.realized_pnl_minor) && f.marketLoss === BigInt(fill.market_loss_minor);
}
export function executePaperSell(db: Database.Database, owner: string, input: unknown, clock: () => number = Date.now) {
    if (!id(owner) || !object(input) || Object.keys(input).length !== 3 || !['accountId', 'reservationId', 'executionKey'].every(k => id(input[k])))
        return no('invalid');
    const account = input.accountId as string, rid = input.reservationId as string, key = input.executionKey as string, requestHash = sha(JSON.stringify({
        accountId: account, reservationId: rid, executionKey: key
    }));
    return db.transaction(() => {
        const now = clock();
        if (!uint(now))
            return no('invalid_clock');
        const a = db.prepare('SELECT owner_id FROM paper_accounts WHERE account_id=?').get(account) as {
            owner_id: string;
        } | undefined;
        if (a?.owner_id !== owner)
            return no('unavailable');
        if (db.prepare('SELECT 1 FROM paper_fills WHERE account_id=? AND execution_key=?').get(account, key))
            return no('idempotency_conflict');
        const r = db.prepare('SELECT * FROM paper_sell_reservations WHERE id=? AND account_id=?').get(rid, account) as Reservation | undefined;
        if (!r) return no('unavailable');
        const intent = savedIntent(r, now);
        if (!intent || intent.accountId !== account) return no('unavailable');
        const old = db.prepare('SELECT * FROM paper_sell_fills WHERE account_id=? AND execution_key=?').get(account, key) as SellFill | undefined;
        if (old) {
            if (old.request_hash !== requestHash || old.reservation_id !== rid || !validHistoricalReceipt(old, r, owner, now)) return no('idempotency_conflict');
            return receipt(old, true);
        }
        if (r.status !== 'pending'
        || r.cancelled_at !== null
        || !uint(r.created_at)
        || r.created_at > now
        || db.prepare('SELECT 1 FROM paper_sell_fills WHERE reservation_id=?').get(rid))
            return no('unavailable');
        const c = context(db, owner, intent);
        if (!c)
            return no('unavailable');
        for (const [json, value, hash] of [[r.profile_json, JSON.stringify(c.profile), r.profile_hash], [r.quote_json, JSON.stringify(c.quote), r.quote_hash], [r.position_json, JSON.stringify(c.position), r.position_hash]])
            if (json !== value || sha(value) !== hash)
                return no('snapshot_changed');
        const admitted = admission(db, owner, intent, c, now, rid);
        if (!admitted || !uint(c.p.maxDailyLoss, 1) || BigInt(admitted.loss) + admitted.f.fee + admitted.f.marketLoss > BigInt(c.p.maxDailyLoss))
            return no('limit');
        const f = admitted.f, cash = BigInt(c.a.cash) + f.net, exposure = BigInt(c.a.exposure) - f.removed, units = BigInt(c.position.quantity_units) - f.units, cost = BigInt(c.position.cost_minor) - f.removed;
        if (![cash, exposure, units, cost].every(safe))
            return no('limit');
        const result: SellFill = {
            id: randomUUID(), account_id: account, reservation_id: rid, execution_key: key, request_hash: requestHash, quantity_units: Number(f.units), price_minor: Number(f.price), gross_minor: Number(f.gross), fee_minor: Number(f.fee), net_minor: Number(f.net), removed_cost_minor: Number(f.removed), realized_pnl_minor: Number(f.pnl), market_loss_minor: Number(f.marketLoss), created_at: now
        };
        db.prepare('UPDATE paper_accounts SET cash=?,exposure=? WHERE account_id=?').run(Number(cash), Number(exposure), account);
        db.prepare('UPDATE paper_positions SET quantity_units=?,cost_minor=? WHERE account_id=? AND symbol=?').run(Number(units), Number(cost), account, intent.symbol);
        db.prepare("UPDATE paper_sell_reservations SET status='filled' WHERE id=? AND status='pending'").run(rid);
        db.prepare('INSERT INTO paper_sell_fills VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(result.id, account, rid, key, requestHash, result.quantity_units, result.price_minor, result.gross_minor, result.fee_minor, result.net_minor, result.removed_cost_minor, result.realized_pnl_minor, result.market_loss_minor, now);
        return receipt(result, false);
    }).immediate();
}
