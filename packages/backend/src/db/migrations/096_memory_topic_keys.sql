-- Migration 096: stable topic keys for evolving memories (CORE-MEM-TOPIC)
-- A memory may carry a topic key (e.g. 'favorite-editor'). Within one user
-- and one drawer a key names at most one memory, so saving the same topic
-- again updates that memory as a new version (memory_versions) instead of
-- adding a near-duplicate. NULL = no topic (every existing row).
-- Date: 2026-10-21

ALTER TABLE memories ADD COLUMN topic_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_topic_key
  ON memories(user_id, drawer_kind, drawer_key, topic_key) WHERE topic_key IS NOT NULL;
