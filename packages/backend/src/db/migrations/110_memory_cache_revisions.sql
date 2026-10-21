-- MEM-CACHE-01: change counters for the context-pack cache.
--
-- One row per (user, scope). Scope is a drawer id ('owner', 'experience',
-- 'project:alpha', 'task:run-1', 'people:p-42'), 'graph' (the user's
-- knowledge-graph links), 'handoff' (handoff notes) or '*' (any other change
-- that can alter what a turn may load: access, archive, settings).
-- The triggers below bump the counters on every write to memories, graph
-- links and handoffs, so a cached pack keyed by these revisions can never
-- outlive the memory it was built from, whichever code path wrote it.
-- Reads (access counts, last-accessed times) and embedding refreshes do not
-- count as changes.

CREATE TABLE IF NOT EXISTS memory_cache_revisions (
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, scope)
);

CREATE TRIGGER IF NOT EXISTS trg_memories_cache_rev_insert
AFTER INSERT ON memories
BEGIN
  INSERT INTO memory_cache_revisions (user_id, scope, revision)
    VALUES (NEW.user_id, CASE WHEN NEW.drawer_kind IS NULL THEN (CASE WHEN NEW.type IN ('skill', 'insight') THEN 'experience' ELSE 'owner' END) WHEN COALESCE(NEW.drawer_key, '') = '' THEN NEW.drawer_kind ELSE NEW.drawer_kind || ':' || NEW.drawer_key END, 1)
    ON CONFLICT (user_id, scope) DO UPDATE SET revision = memory_cache_revisions.revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_memories_cache_rev_update
AFTER UPDATE OF user_id, type, content, status, metadata, importance_score, tags, memory_layer, expiry_timestamp, drawer_kind, drawer_key, topic_key ON memories
BEGIN
  INSERT INTO memory_cache_revisions (user_id, scope, revision)
    VALUES (OLD.user_id, CASE WHEN OLD.drawer_kind IS NULL THEN (CASE WHEN OLD.type IN ('skill', 'insight') THEN 'experience' ELSE 'owner' END) WHEN COALESCE(OLD.drawer_key, '') = '' THEN OLD.drawer_kind ELSE OLD.drawer_kind || ':' || OLD.drawer_key END, 1)
    ON CONFLICT (user_id, scope) DO UPDATE SET revision = memory_cache_revisions.revision + 1;
  INSERT INTO memory_cache_revisions (user_id, scope, revision)
    VALUES (NEW.user_id, CASE WHEN NEW.drawer_kind IS NULL THEN (CASE WHEN NEW.type IN ('skill', 'insight') THEN 'experience' ELSE 'owner' END) WHEN COALESCE(NEW.drawer_key, '') = '' THEN NEW.drawer_kind ELSE NEW.drawer_kind || ':' || NEW.drawer_key END, 1)
    ON CONFLICT (user_id, scope) DO UPDATE SET revision = memory_cache_revisions.revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_memories_cache_rev_delete
AFTER DELETE ON memories
BEGIN
  INSERT INTO memory_cache_revisions (user_id, scope, revision)
    VALUES (OLD.user_id, CASE WHEN OLD.drawer_kind IS NULL THEN (CASE WHEN OLD.type IN ('skill', 'insight') THEN 'experience' ELSE 'owner' END) WHEN COALESCE(OLD.drawer_key, '') = '' THEN OLD.drawer_kind ELSE OLD.drawer_kind || ':' || OLD.drawer_key END, 1)
    ON CONFLICT (user_id, scope) DO UPDATE SET revision = memory_cache_revisions.revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_graph_links_cache_rev_insert
AFTER INSERT ON memory_graph_links
BEGIN
  INSERT INTO memory_cache_revisions (user_id, scope, revision) VALUES (NEW.user_id, 'graph', 1)
    ON CONFLICT (user_id, scope) DO UPDATE SET revision = memory_cache_revisions.revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_graph_links_cache_rev_update
AFTER UPDATE ON memory_graph_links
BEGIN
  INSERT INTO memory_cache_revisions (user_id, scope, revision) VALUES (NEW.user_id, 'graph', 1)
    ON CONFLICT (user_id, scope) DO UPDATE SET revision = memory_cache_revisions.revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_graph_links_cache_rev_delete
AFTER DELETE ON memory_graph_links
BEGIN
  INSERT INTO memory_cache_revisions (user_id, scope, revision) VALUES (OLD.user_id, 'graph', 1)
    ON CONFLICT (user_id, scope) DO UPDATE SET revision = memory_cache_revisions.revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_handoffs_cache_rev_insert
AFTER INSERT ON agent_handoffs
BEGIN
  INSERT INTO memory_cache_revisions (user_id, scope, revision) VALUES (NEW.owner_id, 'handoff', 1)
    ON CONFLICT (user_id, scope) DO UPDATE SET revision = memory_cache_revisions.revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_handoffs_cache_rev_delete
AFTER DELETE ON agent_handoffs
BEGIN
  INSERT INTO memory_cache_revisions (user_id, scope, revision) VALUES (OLD.owner_id, 'handoff', 1)
    ON CONFLICT (user_id, scope) DO UPDATE SET revision = memory_cache_revisions.revision + 1;
END;
