-- Migration 120: knowledge-graph clusters the owner said are "not a topic" (CORE-MEM-GRAPH, MEM-GRAPH-CLUSTER)
--
-- A cluster = entities the graph keeps seeing together in one drawer (linked
-- or named in the same memories). It is suggested as a topic; the owner can
-- make it a topic (after a preview and confirm) or dismiss it. A dismissed
-- cluster is not suggested again until its members change (a new id).
--   cluster_id  hash of the drawer and the sorted entity ids
--   drawer_id   'owner', 'project:alpha', ...
-- Date: 2026-10-21

CREATE TABLE IF NOT EXISTS memory_graph_cluster_dismissals (
  user_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  drawer_id TEXT NOT NULL,
  dismissed_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, cluster_id)
);
