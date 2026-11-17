-- A requester, or the user on its behalf, can withdraw a request it no longer
-- needs answered (`withdrawn`, Task-1427). The reason it gave is shown on both
-- parties' cards.
ALTER TABLE peer_prompts ADD COLUMN withdraw_reason TEXT;
