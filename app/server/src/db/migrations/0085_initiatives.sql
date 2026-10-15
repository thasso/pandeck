-- Initiatives (docs/initiatives.md): the user's grouping of Tasks across
-- Projects. The row holds the Initiative's own columns; membership is an
-- `initiative —member→ task` edge in `links`, with `position` for the user's
-- order and `{ "milestone": true }` in `metadata_json` on a milestone.
--
-- `state` is set explicitly and never derived from the member Tasks.
-- `revision` is the state-event revision, stamped from
-- sequences('initiative_revision') by the notify seam (docs/state-sync.md).
--
-- The attention cursor has the shape and rules of a Workflow Run's
-- (0058_workflow_run_attention.sql): `attention_revision` moves only when the
-- Initiative becomes paused or done, `attention_settled_revision` records how
-- far the user acknowledged, and `attention_kind`/`attention_at_ms` describe
-- the current revision (NULL only while it is 0).
--
-- A new table: no existing row changes.
CREATE TABLE initiatives (
  id                         INTEGER PRIMARY KEY,   -- allocated from sequences('initiative')
  title                      TEXT NOT NULL,
  description                TEXT NOT NULL DEFAULT '',
  state                      TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','done')),
  revision                   INTEGER NOT NULL DEFAULT 0,
  attention_revision         INTEGER NOT NULL DEFAULT 0,
  attention_settled_revision INTEGER NOT NULL DEFAULT 0,
  attention_kind             TEXT CHECK (attention_kind IN ('paused','done')),
  attention_at_ms            INTEGER,
  created_at_ms              INTEGER NOT NULL,
  updated_at_ms              INTEGER NOT NULL,
  archived_at_ms             INTEGER,
  deleted_at_ms              INTEGER
);
