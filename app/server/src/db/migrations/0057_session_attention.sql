-- Durable attention state for direct-session outcomes (Task-674).
--
-- Settle stops being a visibility flag that any activity resets and becomes an
-- ACKNOWLEDGEMENT: `attention_revision` moves only when a directly owned
-- session completes or fails, and `attention_settled_revision` records how far
-- the user has acknowledged. A session is settled exactly while it has a
-- `settled_at_ms` AND no revision beyond the acknowledged one, so a new turn
-- starting or streaming cannot wake it while its outcome can.
--
-- Existing settlement is preserved without a data pass: every row starts at
-- revision 0 acknowledged through 0, so a row that carries `settled_at_ms`
-- stays settled and a row that does not stays in the working set. The first
-- outcome after deployment is revision 1, which is the first thing that can
-- wake a settled row.
--
-- `attention_kind`/`attention_at_ms` describe the CURRENT revision (they are
-- NULL only while it is 0); the run-failure columns from 0028 stay independent,
-- since they carry the message a card shows and are cleared by the next run.
ALTER TABLE session_index ADD COLUMN attention_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_index ADD COLUMN attention_settled_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_index ADD COLUMN attention_kind TEXT;
ALTER TABLE session_index ADD COLUMN attention_at_ms INTEGER;
