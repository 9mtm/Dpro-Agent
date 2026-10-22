-- Stable links between company departments and their managed task boards.
CREATE TABLE IF NOT EXISTS board_department_sources (
  board_id TEXT PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  department TEXT NOT NULL,
  auto_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  UNIQUE (owner_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_board_department_sources_owner ON board_department_sources(owner_id, department);
