-- WHICH agent produced a Task, when one did. `TaskSource.agentType`/`sessionId`
-- have been on the wire and in the tool schema all along, but nothing persisted
-- them: `toSummary` rebuilt `source` as `{ createdBy }` alone, so every arrival
-- read as a generic "from an agent" no matter what created it. The Backlog's
-- Inbox needs this to say where a Task came from, which is the whole point of
-- its second line.
ALTER TABLE tasks ADD COLUMN source_agent_type TEXT;
ALTER TABLE tasks ADD COLUMN source_session_id TEXT;
