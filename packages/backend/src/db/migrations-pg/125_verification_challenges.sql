-- Purpose-bound, one-use verification challenges. No session or factor is enabled by this table.
CREATE TABLE IF NOT EXISTS verification_challenges (
 token_hash TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 purpose TEXT NOT NULL CHECK (purpose IN ('enroll','login','reverify','recovery','disable','rotate_recovery')),
 session_hash TEXT NOT NULL,
 operation_hash TEXT NOT NULL,
 token_version INTEGER NOT NULL CHECK (token_version > 0),
 factor_version INTEGER NOT NULL CHECK (factor_version >= 0),
 expires_at BIGINT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 5),
 consumed_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_verification_challenges_user ON verification_challenges(user_id, expires_at);
