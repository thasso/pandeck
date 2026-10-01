-- Pull-request cards and approval cards leave their whole-file JSON stores
-- (`pull-request-cards.json`, `pending-approvals.json`).
--
-- Both files were rewritten whole on every change and parsed whole on every
-- read: the PR-card file (1.7 MB, ~500 cards, a handful open) was rewritten on
-- every watcher poll, and showing a session parsed the whole approval file to
-- find its grants. Each row here is one record, so an operation reads and
-- writes only the rows it names.
--
-- The record's JSON stays the source of truth: `card_json` is the client card
-- and `context_json` its server-only context, exactly as the file held them.
-- The plain columns are the ones reads select by. They are rewritten from the
-- card on every write and never read back into it.
--
-- `seq` is insertion order. The files were append-only arrays, and "oldest
-- first" meant array order, not `created_at_ms`: two cards created in the same
-- millisecond still keep the order the store saw them in, and the session
-- summary's tie-break (the later card wins) depends on it.

CREATE TABLE pull_request_cards (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  worktree_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  card_json TEXT NOT NULL,
  context_json TEXT NOT NULL
);

-- One session's cards (its transcript and its list-row summary).
CREATE INDEX pull_request_cards_session_idx ON pull_request_cards(session_id, seq);
-- The watcher's open cards and the sessions blocked on a Task pick.
CREATE INDEX pull_request_cards_status_idx ON pull_request_cards(status, seq);
-- Delivery's card for a managed worktree.
CREATE INDEX pull_request_cards_worktree_idx ON pull_request_cards(worktree_id, seq)
  WHERE worktree_id IS NOT NULL;

CREATE TABLE approvals (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  -- `card.autoApproved`: a pending card a session grant covers blocks nobody.
  auto_approved INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  card_json TEXT NOT NULL,
  context_json TEXT NOT NULL
);

-- One session's approval cards, oldest first.
CREATE INDEX approvals_session_idx ON approvals(session_id, seq);
-- Pending cards only: the attention set, auto-approval batches and
-- supersession all ask about these, and they are almost always none.
CREATE INDEX approvals_pending_idx ON approvals(session_id, auto_approved)
  WHERE status = 'pending';

-- "Approve for session" grants. `seq` keeps the order they were granted in.
CREATE TABLE approval_grants (
  seq INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  key TEXT NOT NULL,
  granted_at_ms INTEGER NOT NULL,
  source_approval_id TEXT NOT NULL,
  UNIQUE (session_id, key)
);

-- Which legacy JSON files have been imported, by content hash. The import and
-- this row commit together, and the file is renamed to a backup after, so a
-- crash between the two finds the same bytes already recorded and only renames.
CREATE TABLE legacy_file_imports (
  name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  imported_at_ms INTEGER NOT NULL,
  PRIMARY KEY (name, sha256)
);
