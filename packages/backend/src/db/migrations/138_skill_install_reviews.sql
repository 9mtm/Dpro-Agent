-- Sanitized immutable document reviews only; no install permission or execution state.
CREATE TABLE IF NOT EXISTS skill_install_reviews (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_hash TEXT NOT NULL,
 token_version INTEGER NOT NULL CHECK(token_version > 0),
 factor_version INTEGER NOT NULL CHECK(factor_version > 0),
 policy_version INTEGER NOT NULL CHECK(policy_version > 0),
 created_at BIGINT NOT NULL,
 expires_at BIGINT NOT NULL CHECK(expires_at > created_at),
 target_id TEXT,
 review_json TEXT NOT NULL,
 review_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_install_reviews_owner ON skill_install_reviews(owner_id,expires_at);
