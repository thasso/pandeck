-- A peer prompt that passed its claim gate right before its turn was appended
-- (`reserveAdmission`) may have reached the recipient's provider even when the
-- app's own log never got its entry: a provider can take input before the app
-- records it, and recording can fail after it did. `reserved_at_ms` keeps that
-- fact durably, so boot recovery can tell a reserved row — never sent again on
-- a missing log entry — from a claim that never reached its gate, which is
-- safely requeued.
--
-- Null on every existing row: none was reserved under this rule.
ALTER TABLE peer_prompts ADD COLUMN reserved_at_ms INTEGER;
