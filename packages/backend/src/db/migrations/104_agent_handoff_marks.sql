-- Migration 104: runs already handled by the handoff sweep (CORE-MEM-HANDOFF)
-- An idle conversation or an ended task run gets at most one generated
-- handoff: its run id is marked here whether a note was written or there
-- was nothing to summarize, so the sweep never looks at it again.
-- Date: 2026-10-21

CREATE TABLE IF NOT EXISTS agent_handoff_marks (
  run_id TEXT PRIMARY KEY,
  outcome TEXT NOT NULL CHECK (outcome IN ('written', 'had_note', 'empty')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
