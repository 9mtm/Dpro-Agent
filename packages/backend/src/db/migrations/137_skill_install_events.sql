-- Once-only installation outcome; no raw document, factor secret or receipt is retained.
CREATE TABLE IF NOT EXISTS skill_install_events (
 review_id TEXT PRIMARY KEY REFERENCES skill_install_reviews(id),
 owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_hash TEXT NOT NULL,
 token_version INTEGER NOT NULL,
 factor_version INTEGER NOT NULL,
 policy_version INTEGER NOT NULL,
 receipt_hash TEXT NOT NULL UNIQUE,
 skill_id TEXT NOT NULL,
 name TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0),
 content_hash TEXT NOT NULL,
 installed_at BIGINT NOT NULL
);
