-- A session whose AUTOMATIC turns are held: the user pressed Stop, and nothing
-- an agent or the app queued for it may start a turn until they resume it or
-- send a message of their own (`automaticTurnHold.ts`).
--
-- What waits is untouched: peer prompts, agent handoffs and background facts
-- keep their own rows. This row only gates delivery, so a session without one
-- behaves exactly as before.
CREATE TABLE session_automatic_turn_hold (
  session_id TEXT PRIMARY KEY,
  held_at_ms INTEGER NOT NULL
);
