-- Migration 097: conflict surfacing (CORE-MEM-CONFLICT)
-- A learned memory that contradicts an existing one of the same drawer is
-- never written over it: it becomes a pending proposal (reason 'conflict')
-- that updates the existing memory only if the owner decides so.
--   conflict_with  id of the existing memory the new one contradicts
--   decision       'keep_new' (the existing memory gets the new text as a new
--                  version), 'keep_old' (nothing changes) or 'keep_both'
--                  (the new text is added as its own memory); NULL until a
--                  conflict proposal is decided, and for other proposals
-- Date: 2026-10-21

ALTER TABLE memory_file_proposals ADD COLUMN conflict_with TEXT;
ALTER TABLE memory_file_proposals ADD COLUMN decision TEXT;

CREATE INDEX IF NOT EXISTS idx_memory_file_proposals_conflict
  ON memory_file_proposals(user_id, conflict_with) WHERE conflict_with IS NOT NULL;
