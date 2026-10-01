-- Workflow v1.1 triage fan-out cap (docs/agent-workflows.md, Task 374).
-- A plain limit column, consistent with the existing v1 bounds; no budget table.
ALTER TABLE workflow_runs ADD COLUMN max_review_passes INTEGER NOT NULL DEFAULT 1;
