-- Tombstones remain after deletion so recreating an identifier cannot revive old consent.
CREATE TABLE IF NOT EXISTS scheduled_job_security_versions (
 job_id TEXT PRIMARY KEY,
 revision INTEGER NOT NULL CHECK (revision > 0 AND revision <= 2147483647)
);
