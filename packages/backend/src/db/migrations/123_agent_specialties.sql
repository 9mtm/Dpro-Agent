CREATE TABLE IF NOT EXISTS agent_specialties (
  agent_id TEXT NOT NULL REFERENCES agents_config(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES specialty_templates(id) ON DELETE CASCADE,
  linked_by TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (agent_id, template_id)
);
