-- Migration 121: memory gaps from the memory boards (MEM-GAPS-02)
--
--   memory_recall_uses          one row per memory a reply used (from the reply
--                               trace): "used in N replies" per memory without
--                               reading trace JSON. Ids only, never text.
--   memory_recall_traces.uses_indexed
--                               1 when the trace's memory items are in
--                               memory_recall_uses (older traces are indexed
--                               on first read).
--   memory_access_scope_rules   access rules for the two scope columns of the
--                               access grid: 'company' (company pinned facts)
--                               and 'department' (department pinned facts).
--                               Same shape and order as memory_access_rules
--                               (migration 107), which keeps the drawer kinds.
--   memory_role_templates.scope_read / scope_write
--                               the template's company/department columns as a
--                               JSON list; NULL = the template does not limit
--                               them (templates saved before this migration).
--   memory_scope_rules          review rules per scope (company '' |
--                               department id | project slug), inherited
--                               company -> department -> project; NULL = inherit:
--                               routine (save | ask), important (ask | save),
--                               contradiction (ask | keep_new | keep_both),
--                               reviewer_agent_id (department: the agent that
--                               reviews its proposals), weekly summary day/hour
--                               (company row only).
-- Date: 2026-10-21

CREATE TABLE IF NOT EXISTS memory_recall_uses (
  run_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, memory_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_recall_uses_memory ON memory_recall_uses (user_id, memory_id, created_at);

ALTER TABLE memory_recall_traces ADD COLUMN uses_indexed INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS memory_access_scope_rules (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('company', 'department', 'project')),
  scope_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '',
  drawer_kind TEXT NOT NULL CHECK (drawer_kind IN ('company', 'department')),
  read_mode TEXT NOT NULL DEFAULT 'inherit' CHECK (read_mode IN ('allow', 'deny', 'inherit')),
  write_mode TEXT NOT NULL DEFAULT 'inherit' CHECK (write_mode IN ('allow', 'deny', 'inherit')),
  ends_at TEXT,
  reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, scope_kind, scope_id, agent_id, drawer_kind)
);
CREATE INDEX IF NOT EXISTS idx_memory_access_scope_rules_agent ON memory_access_scope_rules (owner_id, agent_id);

ALTER TABLE memory_role_templates ADD COLUMN scope_read TEXT;
ALTER TABLE memory_role_templates ADD COLUMN scope_write TEXT;

CREATE TABLE IF NOT EXISTS memory_scope_rules (
  owner_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('company', 'department', 'project')),
  scope_id TEXT NOT NULL DEFAULT '',
  routine TEXT CHECK (routine IN ('save', 'ask')),
  important TEXT CHECK (important IN ('ask', 'save')),
  contradiction TEXT CHECK (contradiction IN ('ask', 'keep_new', 'keep_both')),
  reviewer_agent_id TEXT,
  weekly_day INTEGER CHECK (weekly_day BETWEEN 0 AND 6),
  weekly_hour INTEGER CHECK (weekly_hour BETWEEN 0 AND 23),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, scope_kind, scope_id)
);
