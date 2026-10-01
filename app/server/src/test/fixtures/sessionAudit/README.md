# Session audit fixture (Task-254)

A synthetic, sanitized pi session for `sessionAudit.test.ts`. It contains no
user content: every message body is filler characters sized to make the report's
numbers checkable by hand.

`log.jsonl` is the app-owned normalized log, shaped like a real one (header
line, `seq`/`id` envelopes, `usage` on assistant entries, a `command.result`
compaction card). It carries, deliberately:

- three turns with different origins — `human`, a HIDDEN `system` injection, and
  an `agent` peer prompt;
- a Task-context attachment (4,000 bytes) and a user attachment (1,000 bytes),
  which must land in different contributor categories;
- a `find_tools` result that activates `slack_search` in turn 1, and a call to
  that tool in turn 3, so the deferred-load trail is testable;
- one oversized tool result (8,000 chars) and one failed tool result;
- one failed run (`stopReason: "error"`) and one compaction card (1,600 → 700
  tokens);
- cache boundaries: a cache-write-heavy first turn, cache-read-only later ones.

`native.jsonl` is the matching pi provider transcript: five requests across
those three turns, each with its own `input`/`cacheRead`/`cacheWrite`/
`reasoning` usage, so per-call totals, reasoning tokens and context jumps
resolve. Its per-call usage deliberately does NOT sum to the app log's per-turn
usage — a real divergence the report is required to surface rather than
reconcile.

`claude-transcript.jsonl` is the Claude CLI shape of the same idea, used only to
exercise that reader: one response split across two lines under one `requestId`
(counted once), one `isSidechain` subagent line (never counted), and no cost
field anywhere — which the report must report as unavailable rather than as a
confident `$0`.

Two narrow logs cover branches the main one cannot reach:
`log-no-context-tokens.jsonl` has runs that report no `contextTokens`, so
occupancy must fall back to the prompt-token sum and say so;
`log-cost-rounding.jsonl` has three entries at $0.0000005, where rounding each
to micros gives 3 and rounding their sum once gives 2 — the two accumulations
the two harnesses persist, which the report must reconcile against either.

Provenance: hand-written for this test, not derived from any recorded session.
Session `019fb1ca-9b37-7387-8a70-3c9aeb3af92e` (named on the parent epic) is
fixture provenance only and is deliberately not reproduced here — it predates
the prompt rewrite, the Task-tool collapse and the tool-deferral changes.
