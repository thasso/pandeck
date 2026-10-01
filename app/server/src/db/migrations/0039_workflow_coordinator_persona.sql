-- The Workflow Run planning persona became the run's COORDINATOR: it also
-- decides after each review pass whether another is warranted
-- (docs/agent-workflows.md, Task 403). The persona key travels with the session
-- record, so sessions written under the old key must move with it — an
-- unrecognized persona key would fall back to the assistant toolset on reopen
-- and would have no display name in the session list.
UPDATE session_index
SET agent_type = 'workflow-coordinator'
WHERE agent_type = 'workflow-triage';

-- The matching pi store directory (DATA_DIR/sessions/workflow-triage) holds no
-- transcript: a created pi session is canonicalized to DATA_DIR/sessions/<id>/
-- immediately (sessionStorage.ts), so that folder is a creation slot and stays
-- empty. The new key creates its own on demand; the old one is removable debris
-- and no data moves with it, which is why this migration is SQL only.
