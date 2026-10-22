-- Explicit revocation preserves consent history and advances the shared consent revision.
ALTER TABLE scheduled_job_authorizations ADD COLUMN status TEXT NOT NULL DEFAULT 'authorized' CHECK (status IN ('authorized','revoked'));
CREATE TABLE IF NOT EXISTS scheduled_job_authorization_revocations (
 job_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK (version > 0 AND version <= 2147483647),
 prior_version INTEGER NOT NULL CHECK (prior_version > 0),
 revoked_by TEXT NOT NULL,
 revoked_at BIGINT NOT NULL,
 token_version INTEGER NOT NULL CHECK (token_version > 0),
 factor_version INTEGER NOT NULL CHECK (factor_version > 0),
 policy_version INTEGER NOT NULL CHECK (policy_version > 0),
 receipt_hash TEXT NOT NULL,
 session_hash TEXT NOT NULL,
 PRIMARY KEY (job_id,version)
);
