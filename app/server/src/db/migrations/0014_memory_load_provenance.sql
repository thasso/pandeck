-- Append-only addition to the per-turn effective-load audit (Task 91/101/102,
-- review follow-up): a provenance snapshot per item so the inspector/manager can
-- show a resolvable source link (e.g. the originating session) for each loaded
-- memory, without recomputing it from the (possibly since-changed) live card.
ALTER TABLE memory_load_items ADD COLUMN source_kind TEXT;
ALTER TABLE memory_load_items ADD COLUMN source_session_id TEXT;
ALTER TABLE memory_load_items ADD COLUMN source_message_id TEXT;
