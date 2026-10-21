-- Migration 106: pinned facts per scope (MEM-SCALE-01)
--
-- Short facts the owner pins to the company, a department or a project. The
-- context of every reply in that scope loads them first (size-limited).
--   scope_kind  company | department | project
--   scope_id    '' for the company, the department id, or the project slug
--   position    order inside the scope (lower first)
-- Date: 2026-10-21

CREATE TABLE IF NOT EXISTS memory_pinned_facts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('company', 'department', 'project')),
  scope_id TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_pinned_facts_scope ON memory_pinned_facts (owner_id, scope_kind, scope_id, position);
