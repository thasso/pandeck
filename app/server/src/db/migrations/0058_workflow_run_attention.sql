-- Durable attention state for formal Workflow Run outcomes (Task-677).
--
-- A run's ENDING becomes the thing the user acknowledges, instead of the run
-- vanishing from the Sessions inbox at exactly the moment its outcome matters
-- and each of its role sessions demanding a Settle of its own. Same shape and
-- rules as the session cursor from 0057: `attention_revision` moves only on a
-- MEANINGFUL event — the run reaching a pause or gate, completing, or being
-- cancelled — never on a run or step starting, on agent progress, or on the
-- run being viewed; `attention_settled_revision` records how far the user has
-- acknowledged. A run is awake exactly while the revision is beyond the
-- acknowledged one.
--
-- Existing runs start with no attention: revision 0 acknowledged through 0.
-- A terminal run from before this cursor existed is therefore NOT resurrected
-- into the inbox. A run that is PAUSED right now is the one exception, and a
-- deliberate one: it is already an inbox item (Task-676) waiting on the user,
-- so it starts at revision 1 with its pause as the current event — otherwise
-- it would be the one item the inbox shows that Settle could never take away.
--
-- `attention_kind`/`attention_at_ms` describe the CURRENT revision (they are
-- NULL only while it is 0).
ALTER TABLE workflow_runs ADD COLUMN attention_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_runs ADD COLUMN attention_settled_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_runs ADD COLUMN attention_kind TEXT;
ALTER TABLE workflow_runs ADD COLUMN attention_at_ms INTEGER;
UPDATE workflow_runs
   SET attention_revision = 1,
       attention_kind = 'paused',
       attention_at_ms = updated_at_ms
 WHERE lifecycle = 'paused';
