-- Append-only addition to the per-turn effective-load audit (Task 91, review
-- follow-up). `cumulative_injected_chars` is the inspector diagnostic: cumulative
-- injected characters since the last detected compaction/rotation, as of this
-- turn. The `memory_load_items` text/kind/scope snapshot columns already ship in
-- 0011, so only this one column is added here.
ALTER TABLE memory_load_batches ADD COLUMN cumulative_injected_chars INTEGER NOT NULL DEFAULT 0;
