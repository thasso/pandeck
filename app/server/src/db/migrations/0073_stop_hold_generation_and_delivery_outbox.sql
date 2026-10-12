-- Stop stays stopped, durably (`automaticTurnHold.ts`).
--
-- Every Stop gets its own GENERATION, so a resume the user authorized before a
-- newer Stop can never lift that newer one. Generations come from an
-- AUTOINCREMENT sequence, which never reuses a value even after its rows are
-- deleted; the sequence table keeps no rows, only `sqlite_sequence` does.
ALTER TABLE session_automatic_turn_hold
  ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;

CREATE TABLE automatic_turn_hold_generation (
  generation INTEGER PRIMARY KEY AUTOINCREMENT
);

-- Background completions owed to a session but not yet delivered
-- (`completionDelivery.ts`). Only identities: the notice is rebuilt from its
-- background-work row, so no command, path or output is stored here. A row
-- leaves when the fact is delivered or dropped; boot restores the rows of a
-- held session and forgets the rest, as a restart always has.
CREATE TABLE background_delivery_outbox (
  session_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('wake', 'defer')),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, item_id, revision)
);
