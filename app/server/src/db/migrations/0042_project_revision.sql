-- Per-Project revision for the state-change event sync model. Projects remain in
-- the canonical projection when archived; only a tombstone removes membership.
ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
