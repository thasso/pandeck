-- Messages the user queued behind a running turn, sent one by one as the next
-- turns once the session is idle (`promptQueue.ts` owns delivery).
--
-- Unlike `agent_handoffs`, a row here is still the USER's draft: it can be
-- edited, reordered or withdrawn until its turn comes, so order is an explicit
-- `position` rather than insertion id. `text` is what they typed; a queued host
-- slash command also records `command_json` ({name, rawArgs}) and runs as that
-- command. `attachments_json` is metadata only — the bytes wait in the session
-- attachment store, where the send reads them back.
--
-- `error` is the last failed delivery. A failure pauses the queue on its row
-- rather than dropping it: the user decides whether to edit, retry or remove.

CREATE TABLE session_prompt_queue (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  attachments_json TEXT,
  command_json TEXT,
  error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX session_prompt_queue_order_idx
  ON session_prompt_queue(session_id, position);

-- A session whose queue is held: the user stopped a turn with messages still
-- queued, or a delivery failed. Nothing is sent until they resume it.
CREATE TABLE session_prompt_queue_pause (
  session_id TEXT PRIMARY KEY,
  paused_at_ms INTEGER NOT NULL
);
