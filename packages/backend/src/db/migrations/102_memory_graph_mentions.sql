-- Migration 102: memory knowledge graph, memory <-> entity attachments (CORE-MEM-GRAPH)
--
--   memory_graph_mentions  a memory names an entity (recall pulls an entity's
--                          memories through these rows, drawers still applied)
--   memory_graph_state     which text of a memory the graph was built from
--     content_hash  sha256 of the memory text at extraction time
--     method        model (local model answered) | fallback (deterministic rules)
-- Forgetting a memory (CORE-07) removes its rows here and the orphans it leaves.
-- Date: 2026-10-21

CREATE TABLE IF NOT EXISTS memory_graph_mentions (
  memory_id TEXT NOT NULL,
  entity_id TEXT NOT NULL REFERENCES memory_graph_entities(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  PRIMARY KEY (memory_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_graph_mentions_entity ON memory_graph_mentions (entity_id);
CREATE INDEX IF NOT EXISTS idx_memory_graph_mentions_user ON memory_graph_mentions (user_id);

CREATE TABLE IF NOT EXISTS memory_graph_state (
  memory_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('model', 'fallback')),
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_graph_state_user ON memory_graph_state (user_id);
