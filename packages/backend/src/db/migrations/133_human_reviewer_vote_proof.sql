-- Existing unproved positive rows do not count; writers store only one-way receipt/session fingerprints.
ALTER TABLE human_reviewer_votes ADD COLUMN receipt_hash TEXT;
ALTER TABLE human_reviewer_votes ADD COLUMN proof_session_hash TEXT;
ALTER TABLE human_reviewer_votes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0 AND revision <= 2147483647);
CREATE TABLE IF NOT EXISTS human_reviewer_vote_events (
 policy_id TEXT NOT NULL REFERENCES human_reviewer_policies(id),
 policy_version INTEGER NOT NULL CHECK (policy_version > 0),
 approval_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK (revision > 0 AND revision <= 2147483647),
 decision TEXT NOT NULL CHECK (decision IN ('approve','deny')),
 request_hash TEXT NOT NULL,
 policy_hash TEXT NOT NULL,
 token_version INTEGER NOT NULL CHECK (token_version > 0),
 factor_version INTEGER NOT NULL CHECK (factor_version > 0),
 receipt_hash TEXT NOT NULL,
 proof_session_hash TEXT NOT NULL,
 created_at BIGINT NOT NULL,
 expires_at BIGINT NOT NULL,
 PRIMARY KEY (policy_id,policy_version,approval_id,user_id,revision)
);
