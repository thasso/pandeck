-- Durable queue for the decisions a running session could not be told about.
--
-- Approving a card, answering a question, choosing a Task or handing off review
-- comments all end in a prompt to one session. That prompt used to be attempted
-- once, against a session the user had just watched start a turn: a provider
-- that cannot take mid-turn input (claude-sdk) answered `SessionBusyError`, the
-- browser showed a failure toast, and the decision the user had made reached the
-- agent never. The row here is what the decision becomes instead — FIFO per
-- session, delivered on the session's next idle edge.
--
-- `prompt` is the rendered text, the same content `peer_prompts` already
-- persists: it is a message TO a session, not transcript content, and it is
-- written once at resolve time so a card the user later archives cannot change
-- what the agent is told. `context_block` is the model-only half of that
-- message (a review handoff's comment bundle) and never reaches the durable
-- transcript, exactly as it would not have on an immediate send.
--
-- `origin_kind` is the turn's provenance: `system` stamps `source` on it (a card
-- outcome), `human` is text the USER wrote and the agent must read as the user's
-- own message. `hidden` keeps a card outcome out of the visible transcript.
--
-- `outcome_ref_json` names the object that is WAITING to hear what became of
-- this handoff — today a pull-request card whose rebase offer must stop being
-- offered once the agent has the prompt. It is persisted rather than kept as a
-- callback because the card outlives the process: a handoff delivered after a
-- restart would otherwise leave the card still advertising an action the agent
-- is already carrying out, and a second click would start it twice. The token
-- inside it is what makes that late write safe (`recordRebaseHandoff`).
--
-- `attempts` bounds a handoff whose delivery keeps failing for a reason that is
-- not busyness (a missing worktree, a session that cannot be resumed at all):
-- the row is dropped once the budget is spent, and whatever was waiting on its
-- outcome is told, rather than re-waking the session forever.

CREATE TABLE agent_handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  origin_kind TEXT NOT NULL DEFAULT 'system' CHECK (origin_kind IN ('system', 'human')),
  -- The system source label; always null for a `human` row.
  source TEXT,
  prompt TEXT NOT NULL,
  context_block TEXT,
  hidden INTEGER NOT NULL DEFAULT 1,
  outcome_ref_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

-- The only read there is: the next handoff owed to one session, FIFO by id.
CREATE INDEX agent_handoffs_session_fifo_idx ON agent_handoffs(session_id, id);
