-- Immutable policy history; receipt values and authenticator answers are never stored here.
CREATE TABLE IF NOT EXISTS human_reviewer_policy_events (
 policy_id TEXT NOT NULL REFERENCES human_reviewer_policies(id),
 version INTEGER NOT NULL CHECK (version > 0 AND version <= 2147483647),
 action TEXT NOT NULL CHECK (action IN ('activate','revoke')),
 policy_json TEXT NOT NULL,
 draft_revision INTEGER,
 owner_id TEXT NOT NULL,
 owner_token_version INTEGER NOT NULL CHECK (owner_token_version > 0),
 owner_factor_version INTEGER NOT NULL CHECK (owner_factor_version > 0),
 operation_hash TEXT NOT NULL,
 created_at BIGINT NOT NULL CHECK (created_at >= 0),
 PRIMARY KEY (policy_id,version)
);
