-- A delivered background fact is not a handled one (`completionDelivery.ts`).
--
-- Until now a row left the outbox once the turn that carried it resolved, and a
-- Stop or a failed turn resolves or throws just like a finished one: a fact
-- whose handling turn never completed was retired all the same. A row now moves
-- through phases until the run it was exposed to ends cleanly:
--
--   owed         not exposed to the model yet; the existing queue policy
--   reserved     claimed by one delivery attempt right before append or
--                provider exposure (`attempt_id`)
--   handling     appended into run `run_id` (entry `entry_id`), waiting for
--                that run's outcome
--   interrupted  that attempt ended without a clean end (`interruption`), or
--                the process died while it was reserved or handling; only the
--                user's explicit Recover or Dismiss moves it again
--
-- Only identities and categories: no prompt, output, command or path.
-- Every existing row is `owed`, as it was decided before this migration.
ALTER TABLE background_delivery_outbox
  ADD COLUMN phase TEXT NOT NULL DEFAULT 'owed'
  CHECK (phase IN ('owed', 'reserved', 'handling', 'interrupted'));
ALTER TABLE background_delivery_outbox ADD COLUMN attempt_id TEXT;
ALTER TABLE background_delivery_outbox ADD COLUMN run_id TEXT;
ALTER TABLE background_delivery_outbox ADD COLUMN entry_id TEXT;
ALTER TABLE background_delivery_outbox
  ADD COLUMN interruption TEXT
  CHECK (interruption IS NULL OR interruption IN ('failed', 'stopped', 'restart', 'unknown'));
ALTER TABLE background_delivery_outbox ADD COLUMN phase_at_ms INTEGER;

CREATE INDEX background_delivery_outbox_attempt
  ON background_delivery_outbox(attempt_id) WHERE attempt_id IS NOT NULL;
