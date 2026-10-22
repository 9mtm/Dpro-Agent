-- Definition edits are attributed without storing a second copy of action payloads or credentials.
CREATE TABLE IF NOT EXISTS scheduled_job_definition_events (
 job_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK (revision > 0 AND revision <= 2147483647),
 edited_by TEXT NOT NULL,
 edited_at BIGINT NOT NULL,
 token_version INTEGER NOT NULL CHECK (token_version > 0),
 definition_hash TEXT NOT NULL,
 PRIMARY KEY (job_id,revision)
);
