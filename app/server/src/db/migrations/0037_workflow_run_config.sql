-- Workflow Run start configuration (docs/agent-workflows.md, Task 366).
--
-- The start sheet captures per-role provider/model/thinking and optional prompt
-- overrides; the step-4 agent executor must be able to build each role's
-- session from it after any restart, so it is persisted with the run. The
-- column stays GENERIC: opaque recipe-owned JSON, written once at creation and
-- never rewritten (the store refuses updates). It is a captured input, not the
-- mutable run blob the schema comment in 0036 forbids — run STATE remains
-- columns and step results.
ALTER TABLE workflow_runs ADD COLUMN config_json TEXT;
