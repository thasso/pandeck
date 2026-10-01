-- Telling a sender that the turn it was waiting on never finished.
--
-- `interrupted` currently answers "the delivered turn did not complete" and
-- nothing else, so two opposite situations share one status. A row interrupted
-- because the OS process died under a healthy turn is recoverable: the
-- recipient's context survives and re-asking is reasonable. A row interrupted
-- because the PROVIDER refused (usage limit, 529, a harness exit) is not: the
-- next attempt fails the same way, so waking a sender to retry it is worse than
-- silence. `interruption_kind` records which one happened at the moment it is
-- known, rather than leaving later code to pattern-match `failure_reason`,
-- which is free text assembled from provider errors.
--
-- `sender_notified_at_ms` makes the notice EXACTLY-ONCE across restarts. The
-- sender is an agent that asked for a reply and will otherwise wait forever;
-- the notice that releases it is itself delivered by a turn that can be
-- interrupted, so "already told them" has to be a durable fact and not an
-- in-memory set. It is null for every row that never needs one.
ALTER TABLE peer_prompts ADD COLUMN interruption_kind TEXT;
ALTER TABLE peer_prompts ADD COLUMN sender_notified_at_ms INTEGER;

-- Every historical `interrupted` row predates the split. They are terminal and
-- long past being actionable, so they are marked notified rather than
-- classified: the alternative is waking eighteen sessions about prompts that
-- were interrupted weeks ago the first time this ships.
UPDATE peer_prompts
SET sender_notified_at_ms = updated_at_ms
WHERE status = 'interrupted' AND sender_notified_at_ms IS NULL;
