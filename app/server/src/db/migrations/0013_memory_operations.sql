-- Durable operation-result ledger (Task 91, Tasks 94/97 idempotency). Keyed by a
-- trusted operation identity (tool: session+tool-call+batch-index; processor:
-- observation-id+operation-content), it lets an EXACT retry of the same mutation
-- return the prior result without re-applying — so a retried create does not
-- reinforce again, a retried reinforce does not increment again, and a processor
-- crash-after-apply-before-mark cannot double-apply on stale-claim recovery. A
-- genuinely different operation (new identity) still applies normally.
CREATE TABLE memory_operations (
  op_key TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX memory_operations_created_idx ON memory_operations(created_at_ms);
