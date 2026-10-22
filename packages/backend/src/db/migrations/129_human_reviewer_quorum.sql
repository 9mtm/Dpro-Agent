-- Runtime records remain empty until reviewed activation and vote producers are implemented.
CREATE TABLE IF NOT EXISTS human_reviewer_policies (
 id TEXT PRIMARY KEY,
 version INTEGER NOT NULL CHECK (version > 0 AND version <= 2147483647),
 status TEXT NOT NULL CHECK (status IN ('active','revoked')),
 policy_json TEXT NOT NULL,
 approved_by TEXT NOT NULL,
 approved_at BIGINT NOT NULL CHECK (approved_at >= 0)
);
CREATE TABLE IF NOT EXISTS human_reviewer_votes (
 policy_id TEXT NOT NULL REFERENCES human_reviewer_policies(id) ON DELETE CASCADE,
 policy_version INTEGER NOT NULL CHECK (policy_version > 0),
 approval_id TEXT NOT NULL REFERENCES tool_approvals(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 actor_kind TEXT NOT NULL CHECK (actor_kind = 'user'),
 decision TEXT NOT NULL CHECK (decision IN ('approve','deny')),
 request_hash TEXT NOT NULL,
 policy_hash TEXT NOT NULL,
 token_version INTEGER NOT NULL CHECK (token_version > 0),
 factor_version INTEGER NOT NULL CHECK (factor_version > 0),
 created_at BIGINT NOT NULL CHECK (created_at >= 0),
 expires_at BIGINT NOT NULL CHECK (expires_at > created_at),
 PRIMARY KEY (policy_id,policy_version,approval_id,user_id)
);
