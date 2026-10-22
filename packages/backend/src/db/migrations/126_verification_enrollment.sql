-- Pending setup only: this table never enables login MFA.
CREATE TABLE IF NOT EXISTS verification_enrollment (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 session_hash TEXT NOT NULL,
 token_version INTEGER NOT NULL CHECK (token_version > 0),
 sealed_secret TEXT NOT NULL,
 expires_at BIGINT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
 consumed_at BIGINT
);
