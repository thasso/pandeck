-- Provider-failure interruptions now owe their sender a notice too.
--
-- 0055 gated the notice on `interruption_kind = 'restart'`: re-asking a session
-- the provider refused reproduces the refusal, so waking the sender looked
-- worse than silence. In practice the sender then waits forever on a reply that
-- is never coming, and it is the one agent that could route around the failure
-- (a fresh session, another model, the user). The gate now covers every
-- interruption kind.
--
-- Every existing `failure` row predates that change and is long past being
-- actionable, so it is marked notified rather than delivered: otherwise the
-- first boot of this build wakes every sender about refusals from weeks ago.
UPDATE peer_prompts
SET sender_notified_at_ms = updated_at_ms
WHERE status = 'interrupted'
  AND interruption_kind = 'failure'
  AND sender_notified_at_ms IS NULL;
