-- Migration 101: memory knowledge graph, typed links (CORE-MEM-GRAPH)
--
--   memory_graph_links        src --type--> dst between two entities of one user
--     type      works_on | prefers | decided | part_of | depends_on | replaces | contradicts
--     status    active (used by recall) | pending (an important new link, waits
--               for the owner) | rejected (the owner said no; never re-proposed)
--   memory_graph_link_sources the memories a link was learned from. A link with
--                             no source memory left is an orphan and is removed.
-- Date: 2026-10-21

CREATE TABLE IF NOT EXISTS memory_graph_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  src_id TEXT NOT NULL REFERENCES memory_graph_entities(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('works_on', 'prefers', 'decided', 'part_of', 'depends_on', 'replaces', 'contradicts')),
  dst_id TEXT NOT NULL REFERENCES memory_graph_entities(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by TEXT,
  decided_at TEXT,
  UNIQUE (user_id, src_id, type, dst_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_graph_links_src ON memory_graph_links (src_id, status);
CREATE INDEX IF NOT EXISTS idx_memory_graph_links_dst ON memory_graph_links (dst_id, status);
CREATE INDEX IF NOT EXISTS idx_memory_graph_links_status ON memory_graph_links (user_id, status);

CREATE TABLE IF NOT EXISTS memory_graph_link_sources (
  link_id TEXT NOT NULL REFERENCES memory_graph_links(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (link_id, memory_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_graph_link_sources_memory ON memory_graph_link_sources (memory_id);
