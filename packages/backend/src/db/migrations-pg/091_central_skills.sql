CREATE TABLE IF NOT EXISTS central_skills (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, version TEXT NOT NULL, revision INTEGER NOT NULL, content_hash TEXT NOT NULL UNIQUE, origin TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS central_skill_assignments (agent_id TEXT PRIMARY KEY REFERENCES agents_config(id) ON DELETE CASCADE, revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS central_agent_skills (agent_id TEXT NOT NULL REFERENCES agents_config(id) ON DELETE CASCADE, skill_id TEXT NOT NULL REFERENCES central_skills(id), PRIMARY KEY(agent_id,skill_id));
