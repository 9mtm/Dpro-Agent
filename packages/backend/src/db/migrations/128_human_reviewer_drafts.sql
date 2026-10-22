-- Drafts grant no reviewer authority and cannot enable approval enforcement.
CREATE TABLE IF NOT EXISTS human_reviewer_drafts (
 id TEXT PRIMARY KEY,
 revision INTEGER NOT NULL CHECK (revision > 0 AND revision <= 2147483647),
 status TEXT NOT NULL DEFAULT 'draft' CHECK (status = 'draft'),
 policy_json TEXT NOT NULL,
 updated_by TEXT NOT NULL,
 updated_at BIGINT NOT NULL CHECK (updated_at >= 0)
);
