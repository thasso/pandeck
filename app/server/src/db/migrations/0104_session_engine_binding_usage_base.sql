-- Task-1485 sub-PR 4b: the session usage a binding's engine counts on top of.
-- A session's usage totals are the sum over all its bindings. pi adds each
-- run's own usage; Claude reports its record's running native total, which a
-- return's record already carries from its earlier binding. So the switch's
-- commit stores, as JSON counters, the session's totals at the commit less
-- what the target's native counter already holds, and that engine's totals
-- are written over this base (docs/session-runtime-switching.md "Usage").
-- NULL for every first binding and every pi binding: their engine's totals
-- are the session's own.
ALTER TABLE session_engine_binding ADD COLUMN usage_base TEXT;
