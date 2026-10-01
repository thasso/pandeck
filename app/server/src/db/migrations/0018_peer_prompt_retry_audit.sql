-- Peer-prompt retry/backoff scheduling and a bounded transition audit trail
-- (Task-82 review round 2): retryable_failed rows need a due-time so a sweep can
-- requeue them, and cards/history need the full lifecycle transition sequence.

ALTER TABLE peer_prompts ADD COLUMN next_attempt_at_ms INTEGER;
ALTER TABLE peer_prompts ADD COLUMN transitions_json TEXT NOT NULL DEFAULT '[]';

CREATE INDEX peer_prompts_retry_due_idx ON peer_prompts(status, next_attempt_at_ms);
