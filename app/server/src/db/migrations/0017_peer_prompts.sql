-- Peer-prompt persistence (Task 87): a transactional store for cross-session
-- peer prompts, their server-owned conversations, and causal chains. Replaces
-- the uncoordinated agent-relays.json read-modify-write file.

CREATE TABLE peer_prompt_chains (
  chain_id TEXT PRIMARY KEY,
  next_hop INTEGER NOT NULL DEFAULT 1,
  closed INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE peer_prompt_chain_participants (
  chain_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  added_at_ms INTEGER NOT NULL,
  PRIMARY KEY (chain_id, session_id)
);

CREATE TABLE peer_prompts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  hop INTEGER NOT NULL,
  queue_seq INTEGER NOT NULL,
  sender_session_id TEXT NOT NULL,
  recipient_session_id TEXT NOT NULL,
  task_id TEXT,
  prompt TEXT NOT NULL,
  response_requested INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at_ms INTEGER,
  failure_reason TEXT,
  sender_label TEXT,
  task_label TEXT,
  reply_to_message_id TEXT,
  replied_by_message_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  accepted_at_ms INTEGER,
  acknowledged_at_ms INTEGER,
  completed_at_ms INTEGER,
  replied_at_ms INTEGER,
  expires_at_ms INTEGER
);

-- Recipient pending FIFO drain.
CREATE INDEX peer_prompts_recipient_fifo_idx ON peer_prompts(recipient_session_id, status, queue_seq);
-- Participant recent threads (sender/recipient history views).
CREATE INDEX peer_prompts_conversation_idx ON peer_prompts(conversation_id, queue_seq);
CREATE INDEX peer_prompts_sender_idx ON peer_prompts(sender_session_id, queue_seq);
-- Chain state and unresolved response-expectation / retention scans.
CREATE INDEX peer_prompts_chain_idx ON peer_prompts(chain_id);
CREATE INDEX peer_prompts_expiry_idx ON peer_prompts(status, expires_at_ms);
CREATE INDEX peer_prompts_retention_idx ON peer_prompts(status, updated_at_ms);

-- Durable one-time-import bookkeeping (e.g. the legacy agent-relays.json import).
CREATE TABLE peer_prompt_migrations (
  key TEXT PRIMARY KEY,
  applied_at_ms INTEGER NOT NULL
);
