-- Task-1485 sub-PR 4: the earlier binding whose native session a binding
-- continues, written by the cross-harness switch's commit from what the open
-- actually did. NULL for a fresh native session and for every first binding.
-- The switch handoff reads it: a resumed native session is sent only what it
-- missed, a fresh one the whole log (docs/session-runtime-switching.md
-- "Handoff"). A pi return shares its earlier binding's native id even when its
-- transcript was gone and pi started over, so the id alone cannot say.
ALTER TABLE session_engine_binding ADD COLUMN resumed_seq INTEGER
  CHECK (resumed_seq IS NULL OR resumed_seq >= 1);
