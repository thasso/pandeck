# Agent tools

- Harness specifics arrive only through the typed `ToolCallContext`, whose
  `session` identity is always populated — never duck-type or default it.
- Helper runs go through `runOneShot` (`harnesses/oneShot.ts`) and are no-tool
  by default: a helper may receive only an explicit bounded allowlist, never a
  persona's whole toolset.
- Rich web cards parse a JSON payload out of the tool's TEXT output, so keep
  result text byte-stable unless the web renderer changes with it.
- Failure THROWS — never encode an error in the result content. Long-running
  tools honour `ctx.signal` and stream partials via `ctx.progress?.(…)`.
- A tool's rules live in its `description` and `parameters` prose — the only
  surfaces BOTH harnesses render, eager or deferred. There is no prompt-extras
  channel: never add one, and never restate a rule another prompt layer, the
  schema, or the tool's own result/error text already carries.
- Read/search integrations default to compact, bounded results: verbose
  metadata, bodies, expansions and rich render payloads stay opt-in with
  conservative limits.
- A new tool is registered in a `catalog.ts` group with a deliberate loading
  tier (new integration families default to deferred) AND an explicit
  `sideEffects` classification in the catalog; Plan exposes `none` plus the
  deliberate `task_manage` exception for durable Task organization and read-only
  `session_spawn` profile inspection; `spawn`/`propose` still refuse persisted
  Plan mode. One needing an external subprocess belongs in `mcp/toolGroups/`.
