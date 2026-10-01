ALTER TABLE session_index ADD COLUMN credential_profile_id TEXT;
CREATE INDEX IF NOT EXISTS session_index_credential_profile_id_idx ON session_index(credential_profile_id);
