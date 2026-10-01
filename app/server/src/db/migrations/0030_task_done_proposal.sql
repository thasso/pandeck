-- An AGENT claiming a Task is finished, pending the user's confirmation.
-- Recorded instead of completing the Task, because an agent's "done" is a
-- report and not evidence: eagerly-completed Tasks used to vanish from every
-- open list while the work was still unfinished. `done_proposed_by` is the
-- session that made the claim, so the claim can be traced back to its run.
ALTER TABLE tasks ADD COLUMN done_proposed_at_ms INTEGER;
ALTER TABLE tasks ADD COLUMN done_proposed_by TEXT;
