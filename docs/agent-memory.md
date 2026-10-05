# Agent Memory System

The memory layer gives app agents a small, scoped, time-aware long-term memory
distinct from session transcripts, Tasks, the project registry, and the
Knowledge Base. It survives sessions, evolves automatically, stays
token-bounded, and its exact effective context for each turn is auditable and
visible.

## What a memory is

One concise, reusable **preference**, **fact**, **constraint**, or piece of
near-term **working** state. Long-form/reference material stays in the Knowledge
Base; commitments/events stay in Tasks/Calendar. Never store secrets,
credentials, raw sensitive bodies, untrusted tool content, ephemeral chatter, or
duplicates of authoritative documents.

## Storage & lifecycle

High-churn memory state lives in SQLite (migration `0011_memory.sql`, plus
append-only follow-ups `0012_memory_load_columns.sql` — adds
`cumulative_injected_chars` to `memory_load_batches` —,
`0013_memory_operations.sql` — the operation-idempotency ledger — and
`0014_memory_load_provenance.sql` — a provenance snapshot on
`memory_load_items`), never one Git-backed KB entry per card. Tables:
`memory_cards`, `memory_observations`, `memory_session_snapshots`,
`memory_load_batches`/`memory_load_items`, the `memory_processor_runs` usage
ledger, and `memory_operations` (operation-idempotency ledger). Narrow SQL
facades live in `app/server/src/db/memory*Store.ts`; the single deterministic
mutation layer is `app/server/src/memory/memoryService.ts`.

- Each card has a stable `id` plus a monotonic `revision` (the optimistic-
  concurrency token). Existing-card mutations require an `expectedRevision`; a
  stale write makes no change and returns the current card.
- Corrections **supersede-then-create atomically**: the old card is marked
  `superseded` and a new active card records `supersedesId`. History is never
  erased and there is never a contradictory active duplicate.
- Content-dedup idempotency means explicit agent writes and later automatic
  processing converge on one card; retries never duplicate. **Archive is
  suppression**: automatic capture (processor/consolidation/import provenance)
  re-observing an archived card's exact content leaves it archived rather than
  resurrecting it. Only an EXPLICIT write (manual, or an agent acting on a user
  request) restores it; the explicit restore mutation also remains available.
- Operation-level idempotency (`memoryService.withOperationIdempotency`, backed
  by the `memory_operations` ledger) covers every mutation path (tool calls,
  processor operations, browser API mutations): the mutation + ledger record
  commit in one transaction, so a crash between them cannot happen and an exact
  retry of the same trusted operation key returns the prior result without
  re-applying. Browser mutations derive their key from a server-minted
  per-connection id + the request id + a content hash of the validated operation
  — never a bare client-supplied request id, which is tab-local and could
  otherwise collide or be replayed against an unrelated operation. The ledger is
  pruned on a rolling retention window (30 days) during maintenance, far longer
  than any realistic retry/crash-recovery window.
- Deterministic expiry (no model call) archives ended working windows; pinned /
  open-ended memories never expire by age.

## Scope

Scope is multidimensional and columnar: optional `projectId` + optional
`persona`. Matching is **intersection** — every dimension a card specifies must
match the current context; an absent dimension is global on that axis. Ordinary
`assistant` and the singleton `personal-assistant` are isolated personas.

A session's project for scope resolution comes from the shared
`sessionProjectContext.resolveSessionProject(kind, sessionId)` (a standalone
session→project link wins; otherwise a session started from a Task resolves that
Task's project live) — `memoryRuntime.ts`, `memoryScheduler.ts`, and
`memoryTools.ts` all call it rather than reading the standalone mapping
directly, so Task-derived sessions are scoped correctly too.

## Personas

The permanent Personal Assistant is its own stable `personal-assistant` persona
(server-owned, singleton-only, never selectable in ordinary pickers/creation).
It shares the ordinary Assistant tool universe but owns dedicated behavior
guidance and the permanent profile suffix. In v1, Personal Assistant and
ordinary Assistant auto-capture; Developer/Workshop load/search memory but do
not auto-capture ordinary coding turns and write only on explicit user
authorization.

## Temporal semantics

Cards carry a temporal mode: `persistent`, `window` (`validFrom`/`validUntil`),
`until-changed`, or `recurring` (weekly weekdays). Windows/recurrence are
interpreted in an IANA timezone; storage is UTC ms and reasons render in the
profile timezone. Relative language is normalized against each observation's
**immutable** source timestamp + timezone snapshotted at ingestion — an old
observation is never reinterpreted with a later settings value.

## Selection & context delivery

The deterministic selector (`memory/memorySelector.ts`, no embeddings) builds a
**hybrid sticky snapshot**: a baseline (pinned + preferences/constraints +
active-now temporal state) plus query additions admitted only above a relevance
threshold, with a lower retain threshold so a previously-admitted card stays
sticky (hysteresis) and weak query changes do not churn the set. Default budget:
**8 cards / 1,200 rendered characters** (configurable); the selector drops whole
lowest-ranked cards rather than fragmenting one. It returns ordered
`id@revision` items, reasons, a versioned fingerprint, a `changed` flag, and
character counts.

Neither pi nor Claude SDK offers a supported truly-ephemeral mid-session system
context, so memory is delivered through the **model-bound user-prompt channel**
(`memory/memoryRuntime.ts`, invoked by the runtime prompt facade) while the
app-owned log/projection keep only the clean human text. Delivery states:

- **Injected** — first use, changed fingerprint, or first turn after a detected
  fork/compaction/rotation; a complete delimited `<memory>` snapshot is sent
  that states it supersedes all earlier snapshots and teaches `[id@revision]`.
- **Reused** — unchanged fingerprint; no block is sent, zero injected
  characters.
- **Cleared** — loading disabled or the set becomes empty after a non-empty
  snapshot; one tiny superseding clear marker is sent.
- **None** — no current/prior snapshot; nothing is sent.
- **Failed** — selection/delivery threw for an accepted turn, or persisting the
  computed decision failed; an explicit audit batch is recorded (no items, zero
  chars, snapshot/cumulative untouched) so the inspector shows this turn as a
  failure instead of silently continuing to show the PREVIOUS turn's batch as
  current. Never advances the delivered fingerprint.

Every accepted eligible top-level turn records one effective-load audit batch
(including reused turns, which record the exact effective set with zero injected
chars, and failed turns, which record the explicit failure marker above).
Selection/injection fails **open**: a failure yields no memory rather than
blocking the turn, and never advances the delivered fingerprint. The audit write
and the session-snapshot advance/`markLoaded` commit in one transaction
(`memoryRuntime.commitMemoryDelivery`), so a failure partway through can never
leave the audit claiming one delivery state while the snapshot used for the next
turn's decision reflects a different (stale or unadvanced) one.

## Processing cadence, settings & safety ceilings

Memory is **opt-in**: `memory.loadingEnabled` defaults to `false` and is the
master Enable Memory switch in Settings and `settings_update`. While off, no
memories are injected, observed, processed or automatically maintained; existing
cards remain stored. The Memory tool group is gated off and no Memory guidance
is added to new system prompts. Enabling it makes the tools available live and
rotates the permanent Personal Assistant so its next session has the Memory
prompt; other existing sessions keep their frozen prompt until a new session.
Automatic learning modes: `off`, `adaptive` (the preference used when Memory is
enabled), `every-turn` (experimental). Loading, learning and maintenance run
only under the master switch. The adaptive scheduler
(`memory/memoryScheduler.ts`) enqueues a bounded observation per completed
eligible human turn, processes high-signal turns immediately, and batches the
rest on a turn threshold / idle period / before rotation-compaction.

The bounded no-tool processor (`memory/memoryProcessor.ts`) runs a configurable
cheap model through the pi/Claude one-shot seams, requires strict JSON
operations (`create`/`reinforce`/`replace`/`archive`/`ignore`), and applies
validated ones through the lifecycle service — there is no candidate/approval
state. Provenance is code-owned so the model cannot invent a source.

Model consolidation (merge duplicates/contradictions across existing memories)
runs behind a mutation-threshold / daily-idle cadence through the SAME bounded
processor/budget path (`runConsolidation`): reinforce/replace/archive only over
a bounded listed set, never create, never scope escalation.

Global ceilings apply across **every** session and mode and cannot be bypassed
by a learning mode, high-signal trigger, retry, consolidation, or maintenance:
initially **12 processor calls/hour** and **$1 USD reported cost/day**.
Exhaustion defers work to a later window rather than dropping or fanning out.
Unknown reported cost never disables the call ceiling.

Settings (`AppSettings.memory`): the master `loadingEnabled` switch, learning
mode, maintenance, max cards / rendered chars, processor provider/model/thinking
level, and the two global ceilings. The authoritative timezone is the profile
timezone (`user-profile.md`).

## Tools & prompt guidance

Agents get one compact `memoryBehaviorGuidance(agentType)` section plus a small
idempotent tool surface: `memory_search` (deterministic lexical recall; results
carry `id`+`revision`) and the batch `memory_manage`. Automatic capture remains
the primary continuity path — agents are not told to search or write every turn.

## Observability

When Memory is enabled, the Session Details inspector's **Loaded memory**
section shows the persisted effective load for a turn
(Injected/Reused/Cleared/None/Failed, exact per-card text/scope/reason read from
the audit — never recomputed), defaults to the latest batch with bounded
prev/next navigation among recent batches, and distinguishes
draft/not-yet-loaded/no-eligible-memory/failed states. When Memory is off, the
whole inspector section is hidden rather than showing an inactive placeholder.
The app shell receives the server's Memory settings on connect so a returning
user with Memory enabled sees the section without opening Settings first; the
web fallback also defaults to off. A draft session (which can already have a
defined but staged/optimistic session id) is detected via an explicit
`hasAcceptedUserTurn` signal from the app, not by the session id alone, and
never issues a load-audit fetch; it renders the ACTUAL staged scope (persona,
directly-attached project id, or — for a staged Task attach — the Task's OWN
project resolved client-side from the authoritative task list, shown as "global"
when the Task genuinely has none and only as "resolves once sent" when the Task
can't be resolved at all) rather than the Task's title alone. Per-row actions
(pin/unpin, edit/correct, archive/restore) are revealed only once the row's
CURRENT live card is fetched on demand, so an action is never guessed from the
historical audit snapshot; a link opens the full Memory settings/management
surface. The **Memory** Settings section configures behavior and provides a
post-hoc manager: real SQL-backed prev/next pagination and totals for every
filter, including `active-now` — its deterministic modes
(`persistent`/`until-changed`/`window`) are entirely SQL-computable (from/until
bounds need no timezone for the boolean itself); `recurring` cards (the one mode
SQLite cannot evaluate) are scanned in fixed-size SQL chunks, advancing by a
KEYSET cursor (not an increasing `OFFSET`, which would force SQLite to re-walk
the whole already-seen prefix on every call) backed by a dedicated index
matching that exact filter+order (so the cursor is genuinely O(chunk size) per
chunk, verified via `EXPLAIN QUERY PLAN`), with only the requested page's worth
ever retained in memory — bounded regardless of how many recurring cards exist,
never fetched whole. Every card is still findable and `total` is exact, never
truncated by an arbitrary scan cap. Per-card lineage (predecessor/superseded-by,
keyed by memory id so independently expanded rows never clobber each other) and
provenance (source kind + originating session link), and scope/time editing
(project/persona/temporal mode, window start/end, recurring weekday/timezone)
alongside correct/pin/archive. Changing temporal mode resets mode-incompatible
fields (a window's `validUntilMs` cannot linger onto a "persistent" card and
silently expire it later); window/recurring datetime inputs are interpreted in
the card's/configured timezone via a validated (never-throwing) timezone guard —
a raw invalid IANA string would otherwise crash the render — that only applies
to the modes that actually use a timezone, so a stale invalid value left over
from a window/recurring edit never permanently blocks saving
persistent/until-changed; the active/expired/upcoming label uses both from/until
bounds in that same timezone, not the browser's. Non-text scope/time-only
changes are a non-semantic edit (no supersession); a text change supersedes.
There is no review/approval inbox.

## Known v1 limitations (tracked by fixtures)

- **Lexical only.** Retrieval is deterministic lexical/metadata ranking with no
  embeddings/vector search. Paraphrases with little token overlap can be missed
  (`memory/memoryEval.test.ts` documents a golden miss); `memory_search` is the
  escape hatch.
- **Bounded native accumulation.** Changed snapshots accumulate bounded
  model-bound user-prompt text until existing harness compaction/rotation resets
  it; unchanged snapshots are reused and add no memory text. Memory does not
  trigger compaction in v1; a detected reset re-injects the current snapshot and
  restarts the cumulative-injection diagnostic. The reset fires on any
  compaction that actually applied a result — on pi when `!aborted && result`
  (`willRetry` does not gate it, since pi saves/applies the compacted context
  before retrying a failed prompt, so a will-retry compaction is still a
  successful one), and on claude-sdk whenever the CLI reports a
  `compact_boundary`. Automatic (threshold/overflow) compaction has no external
  pre-hook on either harness, so a pending-observation flush is coalesced around
  it (pi's `compaction_start`, the Claude harness's boundary handler); the
  manual `/compact` slash command — harness-independent, and available to
  `personal-assistant` too, since the singleton is long-running and otherwise
  only sheds context via automatic overflow or a full rotation — awaits its own
  pre-flush and resets afterwards, except when the harness declined to compact
  (nothing was replaced, so the delivered snapshot still describes the context).
  The manual `/clear` slash command shares that ordering exactly — pre-flush,
  harness step, reset — because it drops the context outright: the snapshot the
  next turn re-injects is the only memory the model has left. A skipped clear
  (nothing there to drop) leaves the snapshot alone, same as a declined compact.

## Reset boundary

Memory state is disposable local runtime state under `DATA_DIR` (SQLite). There
is no migration of old memory shapes; wiping local `assistant-data/` resets it.

## Owning modules

`app/server/src/memory/` (service, selector/search, runtime seam, processor,
scheduler, API), `app/server/src/db/memory*Store.ts` (persistence),
`app/server/src/sessionProjectContext.ts` (shared session→project resolver),
`app/shared/memory.ts` + `memoryValidation.ts` (contracts/validators),
`config/prompts/personal-assistant.md` + `app/server/src/memoryPrompt.ts`
(persona/guidance), and the web `useMemory` hook + `MemorySettingsSection` /
`LoadedMemorySection` + `lib/timezone.ts` (timezone-aware datetime editing).
