-- Migration 115: memory bridge for coding agents (MEM-BRIDGE-01)
-- Dpro memory is the one brain that Claude Code, Codex, Gemini CLI and
-- Antigravity read (dpro-memory MCP server, managed files) and write (review
-- proposals and handoff notes only).
--
--   memory_bridge_clients        kill switch per CLI (client = claude-code | codex | gemini-cli | antigravity)
--   memory_bridge_folders        per known project folder: managed files on/off (owner confirmed),
--                                back-flow on/off, fingerprint of the last written brief
--   memory_bridge_backflow       chunk hashes already proposed from an agent's own memory file
--                                (file_key = opaque hash of the file path; no path, no text)
--   memory_bridge_registrations  each applied MCP registration in a CLI config file: backup file,
--                                hashes before/after, undone or not
--   memory_bridge_handoffs       done / left / next / questions notes written by an outside CLI
--                                through the MCP server (secrets redacted, newest = handed on)
--   memory_bridge_audit          what the bridge did (action + short detail, never memory text or tokens)
-- Date: 2026-10-21

CREATE TABLE IF NOT EXISTS memory_bridge_clients (
  owner_id TEXT NOT NULL,
  client TEXT NOT NULL CHECK (client IN ('claude-code', 'codex', 'gemini-cli', 'antigravity')),
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, client)
);

CREATE TABLE IF NOT EXISTS memory_bridge_folders (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  files_enabled INTEGER NOT NULL DEFAULT 0,
  backflow_enabled INTEGER NOT NULL DEFAULT 0,
  git_exclude INTEGER NOT NULL DEFAULT 1,
  brief_hash TEXT,
  confirmed_at TEXT,
  written_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, project_id)
);

CREATE TABLE IF NOT EXISTS memory_bridge_backflow (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  file_key TEXT NOT NULL,
  chunk_hash TEXT NOT NULL,
  proposal_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, project_id, file_key, chunk_hash)
);

CREATE TABLE IF NOT EXISTS memory_bridge_registrations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  client TEXT NOT NULL,
  config_path TEXT NOT NULL,
  backup_path TEXT,
  existed INTEGER NOT NULL DEFAULT 1,
  before_sha256 TEXT,
  after_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'undone')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  undone_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_bridge_registrations_owner ON memory_bridge_registrations(owner_id, client, status);

CREATE TABLE IF NOT EXISTS memory_bridge_handoffs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  client TEXT NOT NULL,
  done TEXT NOT NULL DEFAULT '[]',
  remaining TEXT NOT NULL DEFAULT '[]',
  next_steps TEXT NOT NULL DEFAULT '[]',
  open_questions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_bridge_handoffs_project ON memory_bridge_handoffs(owner_id, project_id, created_at);

CREATE TABLE IF NOT EXISTS memory_bridge_audit (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  client TEXT,
  project_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_bridge_audit_owner ON memory_bridge_audit(owner_id, created_at);
