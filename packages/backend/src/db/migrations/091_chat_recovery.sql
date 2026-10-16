-- Durable acceptance and write-ahead tool records. Raw model deltas are never stored here.
ALTER TABLE chat_messages ADD COLUMN error_code TEXT;
CREATE TABLE chat_run_journal (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  agent_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('running', 'complete', 'stopped', 'error', 'interrupted')),
  started_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_chat_run_journal_active ON chat_run_journal(session_id) WHERE state = 'running';
CREATE TABLE chat_run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES chat_run_journal(run_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT,
  state TEXT NOT NULL CHECK (state IN ('intent', 'result')),
  is_error INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_chat_run_steps_run ON chat_run_steps(run_id, id);
