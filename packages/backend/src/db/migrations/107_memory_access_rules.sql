-- Migration 107: memory access by inheritance (MEM-SCALE-01)
--
-- Per drawer kind read/write rules, resolved company -> department -> project,
-- then the agent's own exceptions (same order), then capped by the agent's
-- own permissions (agent_permissions, CORE-PERMS-01) and its role template.
-- No rule anywhere = allow (the behaviour before this migration).
--
--   memory_access_rules     one rule: scope (company '' | department id | project slug),
--                           agent_id '' = everyone at that level, else an exception
--                           for one agent; read_mode / write_mode allow | deny | inherit;
--                           ends_at (ISO time) = temporary exception
--   memory_role_templates   named drawer read/write sets assignable to many agents
--   memory_agent_roles      the one template of an agent (caps its drawer kinds)
--   memory_access_versions  one version per owner: every change bumps it
--                           (optimistic concurrency of preview -> apply)
-- Date: 2026-10-21

CREATE TABLE IF NOT EXISTS memory_access_rules (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('company', 'department', 'project')),
  scope_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '',
  drawer_kind TEXT NOT NULL CHECK (drawer_kind IN ('owner', 'project', 'experience', 'task', 'people')),
  read_mode TEXT NOT NULL DEFAULT 'inherit' CHECK (read_mode IN ('allow', 'deny', 'inherit')),
  write_mode TEXT NOT NULL DEFAULT 'inherit' CHECK (write_mode IN ('allow', 'deny', 'inherit')),
  ends_at TEXT,
  reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, scope_kind, scope_id, agent_id, drawer_kind)
);
CREATE INDEX IF NOT EXISTS idx_memory_access_rules_agent ON memory_access_rules (owner_id, agent_id);

CREATE TABLE IF NOT EXISTS memory_role_templates (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  norm_name TEXT NOT NULL,
  memory_read TEXT NOT NULL,
  memory_write TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, norm_name)
);

CREATE TABLE IF NOT EXISTS memory_agent_roles (
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  template_id TEXT NOT NULL REFERENCES memory_role_templates(id) ON DELETE CASCADE,
  assigned_by TEXT,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_agent_roles_template ON memory_agent_roles (template_id);

CREATE TABLE IF NOT EXISTS memory_access_versions (
  owner_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0
);
