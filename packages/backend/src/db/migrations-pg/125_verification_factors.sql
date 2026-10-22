-- Internal factor storage; login enforcement must be integrated before enrollment is exposed.
CREATE TABLE IF NOT EXISTS verification_factors (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 version INTEGER NOT NULL CHECK (version > 0),
 enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
 sealed_secret TEXT NOT NULL,
 last_counter BIGINT NOT NULL CHECK (last_counter >= -1),
 failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
 locked_until BIGINT NOT NULL DEFAULT 0,
 activated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS verification_recovery_codes (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 factor_version INTEGER NOT NULL CHECK (factor_version > 0),
 code_hash TEXT NOT NULL,
 consumed_at BIGINT,
 PRIMARY KEY (user_id, factor_version, code_hash)
);
