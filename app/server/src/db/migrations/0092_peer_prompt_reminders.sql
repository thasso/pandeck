-- Idle-edge reminders an unanswered request has had (Task-943). Counted per
-- request when its reminder turn is appended; at the configured limit the
-- request stops being reminded and shows on the owing session's inbox card.
ALTER TABLE peer_prompts ADD COLUMN reminder_count INTEGER NOT NULL DEFAULT 0;
