-- Background work rows carry the bounded command line and the agent's own
-- description of the job (Task: background job drawer).
--
-- The row used to hold a fixed label ("Background shell command") and nothing
-- about what was actually started, so a human reading the registry or the chat
-- card could not tell one job from another without the tool view. The command
-- is bounded at the store (4 KB, `command_truncated` says when it was cut) and
-- is the same text the transcript already shows in the tool call. Environment,
-- working directory and output bodies stay out of the row as before.
ALTER TABLE background_work_items ADD COLUMN description TEXT;
ALTER TABLE background_work_items ADD COLUMN command TEXT;
ALTER TABLE background_work_items ADD COLUMN command_truncated INTEGER NOT NULL DEFAULT 0
  CHECK (command_truncated IN (0, 1));
