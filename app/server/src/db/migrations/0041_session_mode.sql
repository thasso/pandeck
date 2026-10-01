ALTER TABLE session_index
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'build'
    CHECK (mode IN ('build', 'plan'));
