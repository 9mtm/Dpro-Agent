-- Migration 103: agent handoffs (CORE-MEM-HANDOFF)
-- A short "done / left / next / open questions" note an agent leaves for its
-- next session. One row per version; the newest version of a scope is the
-- one handed on. Scope = owner + agent + (conversation | board task).
--   owner_id       the user whose conversation / board it is (never shared across owners)
--   agent_id       the agent (agents_config.id, '_main' when there is no agent row)
--   scope_kind     conversation | task
--   scope_id       chat_sessions.id or the orchestrator task id
--   project_id     the conversation's project (a new conversation in the same project continues from it)
--   done, remaining, next_steps, open_questions  JSON lists of short text items (secrets redacted)
--   source         agent (handoff_save) | model (local model summary) | fallback (no model answered) | owner (edited)
--   run_id         the chat run / task run the note covers
-- Date: 2026-10-21

CREATE TABLE IF NOT EXISTS agent_handoffs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('conversation', 'task')),
  scope_id TEXT NOT NULL,
  project_id TEXT,
  version INTEGER NOT NULL,
  done TEXT NOT NULL DEFAULT '[]',
  remaining TEXT NOT NULL DEFAULT '[]',
  next_steps TEXT NOT NULL DEFAULT '[]',
  open_questions TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL CHECK (source IN ('agent', 'model', 'fallback', 'owner')),
  run_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, agent_id, scope_kind, scope_id, version)
);

CREATE INDEX IF NOT EXISTS idx_agent_handoffs_project ON agent_handoffs(owner_id, agent_id, project_id);
CREATE INDEX IF NOT EXISTS idx_agent_handoffs_run ON agent_handoffs(run_id);
