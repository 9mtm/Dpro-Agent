-- Generation for exact approval proof binding, not an enforcement enable switch.
CREATE TABLE IF NOT EXISTS approval_proof_policy (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 version INTEGER NOT NULL CHECK (version > 0)
);
INSERT INTO approval_proof_policy(id,version) VALUES(1,1) ON CONFLICT(id) DO NOTHING;
