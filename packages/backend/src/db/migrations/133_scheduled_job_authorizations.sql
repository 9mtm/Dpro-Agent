-- Consent stores only exact definition and proof fingerprints, never action payloads or raw receipts.
CREATE TABLE IF NOT EXISTS scheduled_job_authorizations (
 job_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK (version > 0 AND version <= 2147483647),
 job_revision INTEGER NOT NULL CHECK (job_revision > 0),
 definition_hash TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 token_version INTEGER NOT NULL CHECK (token_version > 0),
 factor_version INTEGER NOT NULL CHECK (factor_version > 0),
 policy_version INTEGER NOT NULL CHECK (policy_version > 0),
 authorized_at BIGINT NOT NULL,
 expires_at BIGINT NOT NULL,
 receipt_hash TEXT NOT NULL,
 session_hash TEXT NOT NULL,
 PRIMARY KEY (job_id)
);
CREATE TABLE IF NOT EXISTS scheduled_job_authorization_events (
 job_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK (version > 0 AND version <= 2147483647),
 job_revision INTEGER NOT NULL CHECK (job_revision > 0),
 definition_hash TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 token_version INTEGER NOT NULL CHECK (token_version > 0),
 factor_version INTEGER NOT NULL CHECK (factor_version > 0),
 policy_version INTEGER NOT NULL CHECK (policy_version > 0),
 authorized_at BIGINT NOT NULL,
 expires_at BIGINT NOT NULL,
 receipt_hash TEXT NOT NULL,
 session_hash TEXT NOT NULL,
 PRIMARY KEY (job_id,version)
);
