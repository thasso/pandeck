-- When the USER has processed a Task that arrived on its own (meeting minutes,
-- Slack intake, an agent noticing work). Null means it is still in the Backlog's
-- Inbox waiting for a decision.
ALTER TABLE tasks ADD COLUMN triaged_at_ms INTEGER;

-- Every Task that already exists has been lived with, so backfill it as
-- triaged. Without this the Inbox would open holding the entire history —
-- hundreds of rows, none of them new — which is the opposite of what it is for.
UPDATE tasks SET triaged_at_ms = created_at_ms WHERE triaged_at_ms IS NULL;
