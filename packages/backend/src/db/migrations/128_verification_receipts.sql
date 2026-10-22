-- Internal action proof only; consumption must join the action's own transaction.
CREATE TABLE IF NOT EXISTS verification_receipts (
 token_hash TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_hash TEXT NOT NULL,
 operation_hash TEXT NOT NULL,
 token_version INTEGER NOT NULL CHECK (token_version > 0),
 factor_version INTEGER NOT NULL CHECK (factor_version > 0),
 expires_at BIGINT NOT NULL,
 consumed_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_verification_receipts_user ON verification_receipts(user_id,expires_at);
