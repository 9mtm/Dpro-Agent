-- MEM-CACHE-01: rolling summaries of the older turns of a long conversation.
--
-- Older turns are summarised in fixed blocks of messages (level 0: messages
-- first_index..last_index, counted from the start of the conversation), so a
-- block is summarised once and the prompt prefix stays the same from turn to
-- turn. When the block summaries no longer fit the budget, the oldest are
-- merged into one level-1 summary (and so on). `source_hash` is a hash of the
-- covered message ids and contents: an edited or deleted message makes the
-- row stale and it is rebuilt. Rows go with their conversation.

CREATE TABLE IF NOT EXISTS chat_turn_summaries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 0,
  first_index INTEGER NOT NULL,
  last_index INTEGER NOT NULL,
  turns INTEGER NOT NULL,
  summary TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('model', 'fallback')),
  source_hash TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, level, first_index, last_index)
);

CREATE INDEX IF NOT EXISTS idx_chat_turn_summaries_session ON chat_turn_summaries(session_id, level, first_index);
