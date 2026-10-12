-- Owed background facts stay owed through Resume (`automaticTurnHold.ts`).
--
-- 0073 restored only the outbox rows of sessions still held at boot, which
-- read a Resume as delivery: a fact released but not yet delivered — the
-- session resumed, then the process died before the turn, or the offer was
-- busy — was forgotten. `retained` marks the cohort a Stop has touched: rows
-- saved while their session was held, and rows already owed when a Stop
-- landed. Boot restores every retained row, held or not, until it is
-- delivered or committed. Rows never touched by a Stop keep the old rule and
-- are forgotten at boot, so no past job is announced again.
ALTER TABLE background_delivery_outbox
  ADD COLUMN retained INTEGER NOT NULL DEFAULT 0;
