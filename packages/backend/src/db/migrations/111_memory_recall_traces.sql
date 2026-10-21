-- MEM-CACHE-01 / reply recall trace: which memories, handoff note and graph
-- facts were put into the context of one chat turn, and how that context was
-- built (turns kept in full / summarised, cache hit, size, time to first word).
--
-- One row per turn (run). Ids, drawers and reasons only: never memory text
-- (a forgotten memory leaves nothing readable here). Turns that answer an
-- outside sender (channel turns) store no row.

CREATE TABLE IF NOT EXISTS memory_recall_traces (
  run_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent_id TEXT,
  items TEXT NOT NULL DEFAULT '[]',
  context TEXT NOT NULL DEFAULT '{}',
  pack_hit INTEGER NOT NULL DEFAULT 0,
  pack_chars INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  ttft_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_recall_traces_session ON memory_recall_traces(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_recall_traces_user ON memory_recall_traces(user_id, created_at);
