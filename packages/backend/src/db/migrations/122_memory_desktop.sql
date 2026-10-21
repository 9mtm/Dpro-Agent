-- Migration 122: Memory as a desktop program (MEM-UX-02 backend)
--
--   memory_versions.snapshot        JSON of the fields a version row does not
--                                   keep (summary, tags, metadata, topic key,
--                                   layer, source agent, created at), written
--                                   with a 'delete' row so Restore from the
--                                   Trash brings the memory back whole. Forget
--                                   removes the history rows and with them the
--                                   snapshot (MEM-TRASH-01).
--   memory_project_scopes.trashed_at
--                                   a project moved to the Trash (its memories
--                                   are deleted, the project is archived);
--                                   Restore brings both back.
--   memory_scope_rules.trash_days   company row: days a memory stays in the
--                                   Trash before it is forgotten (7 | 30 | 90;
--                                   0 = never; NULL = default 30).
--   memory_project_groups / memory_project_group_members
--                                   groups of projects (a client or a team); a
--                                   project is in at most one group.
--                                   share_within = 1: an agent that reads one
--                                   project of the group reads the others.
--   memory_project_design           a project's design found on this computer
--                                   (colours, fonts, logos, rules, sources as
--                                   JSON), the owner's choices (main logo, not
--                                   a logo, main colour), conflicts waiting for
--                                   the owner, the previous state (Undo) and the
--                                   DESIGN.md switch (default on) (DESIGN-FIND-01).
--   memory_project_databases        local databases found for a project
--                                   (metadata and table names only, never rows
--                                   or passwords) (PROJECT-TECH-01).
--   memory_project_db_access        per agent and project: exists | tables |
--                                   data (data asks the owner each time).
-- Date: 2026-10-21

ALTER TABLE memory_versions ADD COLUMN snapshot TEXT;

ALTER TABLE memory_project_scopes ADD COLUMN trashed_at TEXT;

ALTER TABLE memory_scope_rules ADD COLUMN trash_days INTEGER CHECK (trash_days IN (0, 7, 30, 90));

CREATE TABLE IF NOT EXISTS memory_project_groups (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  norm_name TEXT NOT NULL,
  label TEXT,
  share_within INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, norm_name)
);

CREATE TABLE IF NOT EXISTS memory_project_group_members (
  owner_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  group_id TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_memory_project_group_members_group ON memory_project_group_members (owner_id, group_id);

CREATE TABLE IF NOT EXISTS memory_project_design (
  owner_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  found TEXT NOT NULL DEFAULT '{}',
  main_logo TEXT,
  not_logos TEXT NOT NULL DEFAULT '[]',
  main_colour TEXT,
  conflicts TEXT NOT NULL DEFAULT '[]',
  previous TEXT,
  write_file INTEGER NOT NULL DEFAULT 1,
  file_written_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, slug)
);

CREATE TABLE IF NOT EXISTS memory_project_databases (
  owner_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  found TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, slug)
);

CREATE TABLE IF NOT EXISTS memory_project_db_access (
  owner_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('exists', 'tables', 'data')),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, slug, agent_id)
);
