-- The OpenAI-compatible endpoint became an account of its own (Task-1373,
-- docs/account-routing.md). Its models keep the pi provider id
-- `openai-compatible`, which is also the id of the account the endpoint
-- migrated to, so every session and held peer child running such a model is
-- rebound to that account, whatever OpenAI account carried it before.
--
-- Unconditional: deployment runs with no sessions. Until the boot's JSON
-- migration has created the account, these rows name a missing account, which
-- is the deleted-account path (an explicit error; a fork picks again).
UPDATE session_index
   SET credential_profile_id = 'openai-compatible'
 WHERE provider = 'openai-compatible';

UPDATE direct_peer_children
   SET credential_profile_id = 'openai-compatible'
 WHERE provider = 'openai-compatible';
