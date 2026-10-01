-- Contacts: a first-class, general contacts database (people directory).
-- Reused broadly across the assistant (time-logging routing is one consumer):
-- who someone is (name/roles/ids) plus an optional responsibility `area` used to
-- route work. Self-enriching — agents add/merge as they encounter people.
CREATE TABLE contacts (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  roles_json    TEXT NOT NULL DEFAULT '[]',
  email         TEXT,
  jira_id       TEXT,
  slack_id      TEXT,
  -- Extensible id map (e.g. { "github": "octocat" }) for ids we do not yet model.
  ids_json      TEXT NOT NULL DEFAULT '{}',
  -- Responsibility area tags used by routing (e.g. ["people", "resources"]).
  areas_json    TEXT NOT NULL DEFAULT '[]',
  notes         TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

-- Identity indexes for dedup/merge lookups (case-normalized values written by the store).
CREATE INDEX contacts_email_idx ON contacts (email);
CREATE INDEX contacts_jira_id_idx ON contacts (jira_id);
CREATE INDEX contacts_slack_id_idx ON contacts (slack_id);
