-- While a Recover holds an interrupted outbox row (`reserved` with an
-- interruption, `0081_background_delivery_handling.sql`), the attempt, run and
-- entry it was interrupted under. A Recover that provably never reached the
-- provider puts them back, so the receipt the user was shown, and the
-- transcript entry it points at, stay exactly as they were. Identities only.
-- Null on every existing row: none is held by a Recover across this upgrade.
ALTER TABLE background_delivery_outbox ADD COLUMN prior_attempt_id TEXT;
ALTER TABLE background_delivery_outbox ADD COLUMN prior_run_id TEXT;
ALTER TABLE background_delivery_outbox ADD COLUMN prior_entry_id TEXT;
