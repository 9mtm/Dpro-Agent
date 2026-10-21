-- Migration 105: memory scope tree (MEM-SCALE-01)
--
-- company -> department -> project. The company is the owner; projects are
-- the owner's project drawers (memory drawer key = slug, also the slug of a
-- chat project). A project without a department row is in "General" (the
-- built-in department, id 'general', never stored).
--
--   memory_departments      a department of one owner (name unique per owner)
--   memory_project_scopes   state of one project drawer: display name, department,
--                           pinned, archived (kept, never loaded into a reply or
--                           recall), merged_into (archived because it was merged).
--                           No row = General, not pinned, not archived.
-- Date: 2026-10-21

CREATE TABLE IF NOT EXISTS memory_departments (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  norm_name TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, norm_name)
);

CREATE TABLE IF NOT EXISTS memory_project_scopes (
  owner_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT,
  department_id TEXT,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived_at TEXT,
  merged_into TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_memory_project_scopes_department ON memory_project_scopes (owner_id, department_id);
CREATE INDEX IF NOT EXISTS idx_memory_project_scopes_archived ON memory_project_scopes (owner_id, archived_at);
