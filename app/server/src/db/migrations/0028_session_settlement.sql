ALTER TABLE session_index ADD COLUMN settled_at_ms INTEGER;
ALTER TABLE session_index ADD COLUMN last_error_at_ms INTEGER;
ALTER TABLE session_index ADD COLUMN last_error_text TEXT;
