-- WHO wanted a background item's Stop, as a typed fact (`deliveryPolicy.ts`).
--
-- Delivery used to infer it from the terminal reason, which only the monitor
-- event-rate Stop set distinctly, so a Stop at the frozen deadline read as one
-- the owner had asked for: deferred until some other turn, while the owner sat
-- parked on the work. `requestStop` now records the origin with the
-- reservation, and the Stop that actually terminalizes the row records its own.
--
-- Backfill describes history only. Nothing is replayed: the delivery outbox
-- keeps the decision each owed fact was saved with.
ALTER TABLE background_work_items
  ADD COLUMN stop_origin TEXT CHECK (stop_origin IN ('requester', 'deadline', 'system'));

UPDATE background_work_items
SET stop_origin = CASE
  WHEN terminal_reason = 'stopped-for-event-rate' THEN 'system'
  WHEN stop_source_request_id = 'deadline:' || id || ':' || deadline_at_ms THEN 'deadline'
  ELSE 'requester'
END
WHERE stop_state <> 'none';
