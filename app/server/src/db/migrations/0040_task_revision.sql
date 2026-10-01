-- Per-Task revision for the state-change event sync model (docs/state-sync.md,
-- Task 412). Every notification of a Task change stamps the touched rows from
-- the persisted `task_revision` sequence, and the browser applies an event only
-- when its revision is newer than the one it already holds — which is what makes
-- events idempotent and order-tolerant.
--
-- The revision is PERSISTED rather than in-memory because a restart must not
-- hand out a number a client has already seen: a restarted server that started
-- again at 1 would emit events every subscribed browser silently discards.
ALTER TABLE tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
