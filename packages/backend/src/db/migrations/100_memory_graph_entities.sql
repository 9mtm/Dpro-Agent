-- Migration 100: memory knowledge graph, entities (CORE-MEM-GRAPH)
--
--   memory_graph_entities   things named in a user's memories, one row per
--                           normalized name per user (memory stays per user)
--     kind        person | project | place | topic | agent | task | decision
--     name        display name (first spelling seen)
--     norm_name   normalized name (memory/graph/normalize.ts), the match key
--     aliases     JSON array of normalized aliases (other spellings, short names)
-- Date: 2026-10-21

CREATE TABLE IF NOT EXISTS memory_graph_entities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'project', 'place', 'topic', 'agent', 'task', 'decision')),
  name TEXT NOT NULL,
  norm_name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, norm_name)
);
CREATE INDEX IF NOT EXISTS idx_memory_graph_entities_user ON memory_graph_entities (user_id, kind);
