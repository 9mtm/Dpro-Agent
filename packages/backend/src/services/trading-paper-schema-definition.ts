/** Fixed bundled schema definitions shared by explicit initializers and atomic provisioning. No startup invocation. */
import type Database from 'better-sqlite3';
export function applyPaperLedgerSchema(db:Database.Database):void {
 db.exec(`CREATE TABLE IF NOT EXISTS paper_accounts(account_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode='paper'), currency TEXT NOT NULL, cash INTEGER NOT NULL CHECK(cash>=0), exposure INTEGER NOT NULL CHECK(exposure>=0), app_enabled INTEGER NOT NULL, app_revision INTEGER NOT NULL, stopped INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS paper_policies(policy_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, revision INTEGER NOT NULL, policy_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS paper_quotes(account_id TEXT NOT NULL,symbol TEXT NOT NULL,quote_at INTEGER NOT NULL,PRIMARY KEY(account_id,symbol));
 CREATE TABLE IF NOT EXISTS paper_reservations(reservation_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,policy_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,intent_hash TEXT NOT NULL,notional INTEGER NOT NULL CHECK(notional>0),created_at INTEGER NOT NULL,UNIQUE(account_id,idempotency_key));`);
 db.exec('CREATE TABLE IF NOT EXISTS paper_reservation_intents(reservation_id TEXT PRIMARY KEY,canonical_json TEXT NOT NULL,profile_json TEXT,profile_hash TEXT,quote_json TEXT,quote_hash TEXT)');
 // Explicit caller-owned initialization upgrades the preceding reservation-only schema.
 const columns=(db.prepare('PRAGMA table_info(paper_reservations)').all() as {name:string}[]).map(c=>c.name);
 if(!columns.includes('status'))db.exec("ALTER TABLE paper_reservations ADD COLUMN status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','cancelled'))");
 if(!columns.includes('cancelled_at'))db.exec('ALTER TABLE paper_reservations ADD COLUMN cancelled_at INTEGER');
 db.exec('CREATE INDEX IF NOT EXISTS paper_reservations_account_history ON paper_reservations(account_id,created_at,reservation_id)');

}

export const PAPER_EXECUTION_SCHEMA_SQL = `
 CREATE TABLE IF NOT EXISTS paper_execution_profiles(account_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,revision INTEGER NOT NULL,fee_bps INTEGER NOT NULL,slippage_bps INTEGER NOT NULL,unit_scale INTEGER NOT NULL,currency TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS paper_execution_quotes(account_id TEXT NOT NULL,symbol TEXT NOT NULL,price_minor INTEGER NOT NULL,quoted_at INTEGER NOT NULL,revision INTEGER NOT NULL,currency TEXT NOT NULL,unit_scale INTEGER NOT NULL,PRIMARY KEY(account_id,symbol));
 CREATE TABLE IF NOT EXISTS paper_fills(fill_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,reservation_id TEXT NOT NULL UNIQUE,execution_key TEXT NOT NULL,request_hash TEXT NOT NULL,intent_hash TEXT NOT NULL,quantity_units INTEGER NOT NULL,price_minor INTEGER NOT NULL,fee_minor INTEGER NOT NULL,total_minor INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(account_id,execution_key));
 CREATE TABLE IF NOT EXISTS paper_positions(account_id TEXT NOT NULL,symbol TEXT NOT NULL,quantity_units INTEGER NOT NULL,cost_minor INTEGER NOT NULL,PRIMARY KEY(account_id,symbol));
 `;

export const PAPER_SELL_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS paper_sell_reservations(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,policy_id TEXT NOT NULL,symbol TEXT NOT NULL,quantity_units INTEGER NOT NULL,idempotency_key TEXT NOT NULL,intent_hash TEXT NOT NULL,intent_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','cancelled','filled')),created_at INTEGER NOT NULL,cancelled_at INTEGER,profile_json TEXT NOT NULL,profile_hash TEXT NOT NULL,quote_json TEXT NOT NULL,quote_hash TEXT NOT NULL,position_json TEXT NOT NULL,position_hash TEXT NOT NULL,UNIQUE(account_id,idempotency_key));
 CREATE TABLE IF NOT EXISTS paper_sell_fills(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,reservation_id TEXT NOT NULL UNIQUE,execution_key TEXT NOT NULL,request_hash TEXT NOT NULL,quantity_units INTEGER NOT NULL,price_minor INTEGER NOT NULL,gross_minor INTEGER NOT NULL,fee_minor INTEGER NOT NULL,net_minor INTEGER NOT NULL,removed_cost_minor INTEGER NOT NULL,realized_pnl_minor INTEGER NOT NULL,market_loss_minor INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(account_id,execution_key));`;

export const PAPER_BOT_SCHEMA_SQL = `
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
  `;

export const PAPER_BOT_ACTIVATION_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS paper_bot_activation_reviews(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL,session_hash TEXT NOT NULL,token_version INTEGER NOT NULL,factor_version INTEGER NOT NULL,policy_version INTEGER NOT NULL,definition_json TEXT NOT NULL,definition_hash TEXT NOT NULL,review_hash TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS paper_bot_activation_events(id TEXT PRIMARY KEY,review_id TEXT NOT NULL UNIQUE,bot_id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL,session_hash TEXT NOT NULL,token_version INTEGER NOT NULL,factor_version INTEGER NOT NULL,policy_version INTEGER NOT NULL,definition_hash TEXT NOT NULL,review_hash TEXT NOT NULL,receipt_hash TEXT NOT NULL,created_at INTEGER NOT NULL,event_hash TEXT NOT NULL);
  `;

/** Trusted composition only. The caller owns its transaction and any rollback. */
export function applyPaperBundleSchema(db:Database.Database):void {
 applyPaperLedgerSchema(db);
 for(const sql of [PAPER_EXECUTION_SCHEMA_SQL,PAPER_SELL_SCHEMA_SQL,PAPER_BOT_SCHEMA_SQL,PAPER_BOT_ACTIVATION_SCHEMA_SQL])db.exec(sql);
}
