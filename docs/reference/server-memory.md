# Agent memory implementation — reference

Relocated from `app/server/src/memory/CLAUDE.md` (Task-274) so it stops costing
agent context on every visit. This is a descriptive snapshot of what the modules
in that subtree own; the rules an agent must not violate stay in that folder's
`CLAUDE.md`. Correct or delete a section here when the code moves on. Relative
paths in the body are relative to the original subtree.

## Purpose

The agent memory system domain layer (Task 91): the lifecycle service + scope
resolver, the deterministic selector/search, the bounded automatic processor,
and the adaptive scheduler. SQL persistence lives in `../db/memory*Store.ts`;
shared contracts/validators live in `@assistant/shared`
(`memory.ts`/`memoryValidation.ts`).

## Module ownership

- `memoryService.ts` owns the SINGLE deterministic mutation path for all memory
  writes (human, agent tool, UI, processor). It owns validation, optimistic
  concurrency (`expectedRevision` → stale result with the current card),
  lifecycle (create/reinforce/edit/pin/archive/restore/supersede), deterministic
  expiry (no model call; pinned/open-ended never expire), content-dedup
  idempotency (explicit writes and automatic processing converge on one card),
  provenance/supersession lineage, the scope resolver + intersection matching,
  and the `onMemoryChange` domain event. No other module mutates the memory
  tables directly. A test clock is injectable via `setMemoryClockForTests`.
  Archive is SUPPRESSION: `createMemory` re-observing an archived card's exact
  content via automatic provenance (`processor`/`consolidation`/`import`) leaves
  it archived; only explicit provenance (`manual`/`agent`) restores it.
  `withOperationIdempotency(key, fn)` runs a mutation + ledger record
  (`../db/memoryOperationStore.ts`) in one transaction so an exact retry of a
  trusted operation key is a no-op and a crash between mutation and record
  cannot happen; `supersedeMemory` accepts its own `operationKey` since it opens
  its own transaction. Every mutation path (tool calls, processor operations,
  browser API mutations) threads a key; retention-pruned during maintenance.
- Baseline cards (pinned/preference/constraint/active-temporal) rank
  independently of the prompt (lexical relevance scores query cards only) so an
  unchanged baseline never reorders/reinjects. Recurring cards without their own
  timezone fall back to the profile timezone (`userTimeZone()`), not UTC.
  `memory_search` and the selector share time eligibility (nowMs + timezone).
- `memorySelector.ts` owns the pure, deterministic, budget-bounded selector +
  `searchMemory`. Selection is a hybrid sticky snapshot: a baseline (pinned +
  preferences/constraints + active-now temporal state) plus query additions
  admitted only above an explicit relevance threshold AND (when a current query
  card exists) exceeding the weakest current query card by a replacement margin,
  with a lower retain threshold so a previously-admitted card stays sticky
  (hysteresis) — a marginal new card never displaces a stronger current one. It
  filters inactive/expired/future/off-recurrence/scope-mismatched cards, ranks
  by pin/strength/scope-specificity/temporal-activity/normalized-lexical-match/
  freshness, reserves the top card of each present category, enforces item +
  rendered-char budgets by dropping whole lowest-ranked cards (never fragments),
  and returns ordered id@revision items, reasons, a versioned fingerprint,
  `changed`, and char counts. An empty result after a prior non-empty snapshot
  is a real change (clearing). Bump `SELECTOR_VERSION` when scoring/rendering
  changes. Fails closed on individual invalid cards; the call never throws so a
  turn is never blocked.

- `memoryRuntime.ts` owns the harness-neutral memory-enrichment seam invoked by
  the runtime prompt facade (`session/runtimePrompt.ts`) for eligible top-level
  human turns only. It decides delivery (`injected` on first/changed/post-reset,
  `reused` on unchanged fingerprint, `cleared` once after a non-empty snapshot
  goes empty, `none` otherwise), renders a delimited model-only `<memory>` block
  with precedence + supersedes-all-earlier guidance, and — AFTER the turn is
  accepted — persists the per-turn effective-load audit and advances the session
  snapshot + cumulative-injection counter, ATOMICALLY (`commitMemoryDelivery`
  wraps `recordBatch` + the snapshot write/`markLoaded` in one
  `withDbTransaction`) so a failure partway through can never leave the audit
  claiming one delivery state while the snapshot used for the NEXT turn's
  decision reflects another. The clean human text is what the app log/projection
  store; the block reaches the model only through
  `RuntimePromptOptions.memoryBlock`, prepended to the model-bound text in
  `liveSession.prompt`. Selection/delivery fails OPEN (turn proceeds, delivered
  fingerprint not advanced); a failed provider acceptance skips the commit. When
  selection/delivery itself throws (or committing the decision fails) for an
  ACCEPTED turn, `recordMemoryDeliveryFailure` persists an explicit `failed`
  audit batch (no items, zero chars, snapshot/cumulative untouched) so the
  inspector shows this turn as a failure instead of silently continuing to show
  the PREVIOUS turn's batch as if it were current (`session/runtimePrompt.ts`
  calls it from both failure paths). `resetMemorySessionContext` clears the
  snapshot after fork/compaction/rotation and is wired to a successful manual
  `/compact` on EITHER harness (`hostSlashCommands.ts`'s `runCompactForHost`,
  which flushes pending observations first and skips the reset when the harness
  declined to compact; available to `personal-assistant` too), to ANY automatic
  compaction that actually applied a result — pi's `compaction_end`
  (`!aborted && result`, regardless of `willRetry`: pi saves/applies the
  compacted context before retrying a failed prompt, so a will-retry compaction
  is still a successful one) and the Claude CLI's own threshold compaction
  (`claudeSdk/ClaudeSdkSession.ts`'s `handleAutoCompaction`, driven by the
  `compact_boundary` message that arrives mid-turn) — and to permanent rotation
  (which now AWAITS the pre-rotation observation flush before clearing the
  binding). Session project scope resolves through the shared
  `sessionProjectContext.resolveSessionProject(kind, sessionId)`, not a direct
  standalone-only lookup, so a session started from a Task is scoped correctly
  even without its own standalone project link. Task 96 owns pre-prompt
  selection/delivery; Task 99 owns post-turn observation; both key off the same
  accepted user-turn id.

- `memoryProcessor.ts` owns the bounded, no-tool automatic processor: it turns a
  claimed observation batch into validated lifecycle operations with a
  configurable cheap model via the pi/Claude one-shot seams (never the provider
  SDK directly; a fake runner is injectable for tests). It enforces the GLOBAL
  ceilings atomically BEFORE any call (`tryReserveProcessorCall`: calls/hour +
  reported cost/day across all sessions/modes; a mode/trigger/retry can never
  bypass them — exhaustion defers observations to a later window), applies
  per-run operation/input/output/timeout/attempt bounds, parses STRICT JSON
  operations (`create`/`reinforce`/`replace`/`archive`/`ignore`) and applies
  accepted ones through the lifecycle service (there is no candidate/approval
  state). Provenance is code-owned (`sourceKind: processor`/`consolidation`), so
  the model cannot invent a source; created-card scope is DERIVED from the
  observation (no scope escalation) and reinforce/replace/archive targets must
  be in the observation's applicable scope; output is strictly validated
  (types/enums/unknown keys/bounded relative days/confidence/evidence); relative
  temporal is normalized DST-correctly (calendar days in the tz) against each
  observation's immutable source timestamp/timezone (also the created card's
  `observedAtMs`); unknown reported cost never disables the call ceiling. A
  processor failure never alters a user response and leaves observations
  retryable within bounded attempts.

- `memoryScheduler.ts` owns adaptive post-turn observation + automatic
  maintenance. `observeTurn` (called by the runtime prompt facade with the SAME
  accepted user-turn id and the clean human text — never the memory-snapshot
  bytes) enqueues a bounded observation only when learning is enabled AND the
  persona is capture-eligible (Personal Assistant + ordinary Assistant only;
  Developer/Workshop ordinary turns enqueue nothing). Modes: `off` (no calls, no
  retained text), `adaptive` (immediate for deterministic high-signal turns,
  otherwise batched on a turn threshold / idle / before rotation-compaction),
  `every-turn`. Flushes are single-flight per session (concurrent triggers
  coalesce), claim observations atomically, and go through the bounded processor
  so the global ceilings gate every trigger/mode (exhaustion defers, never drops
  or fans out). It snapshots the source timestamp + timezone at ingestion (never
  reinterpreting old observations with later settings), runs model-free expiry
  in `runMaintenance`, bounds the durable queue (per-session pending counts,
  count/age prune) AND the operation-idempotency ledger (rolling retention
  prune), triggers model consolidation (`memoryProcessor.runConsolidation`,
  single-flight, same bounded processor/budget path) behind a mutation threshold
  / daily idle, and recovers stale `processing` claims at boot. A Claude
  session's automatic compaction has no pre-notice either, so
  `claudeSdk/ClaudeSdkSession.ts`'s `handleAutoCompaction` coalesces the same
  detached `flushBeforeReset` call after the fact (the observation text was
  already captured at turn time). `startMemoryMaintenance` (index.ts) drives the
  periodic idle-flush + maintenance loop. Rotation
  (`permanentAssistant.rotatePermanentAssistantSession`) flushes pending work
  and resets the memory session context before abandoning the old binding. A pi
  `compaction_start` (automatic threshold/overflow compaction, which has no
  external pre-hook) also coalesces a `flushBeforeReset` call
  (`piSdk/PiLiveSession.ts`); the manual `/compact` path already awaits its own
  pre-flush. `observeTurn` resolves session project scope through the shared
  `sessionProjectContext.resolveSessionProject(kind, sessionId)` rather than a
  direct standalone-only lookup, so Task-derived sessions scope correctly too.

- `memoryApi.ts` owns the server-authoritative browser read/mutation surface:
  bounded/paginated `listMemory` (text/project/persona/kind/state/pin/active-now
  filters, default active compact rows) is fully SQL-backed for every filter,
  including `activeNow`'s DETERMINISTIC part — `memoryStore`'s `activeNowMs`
  filter mirrors `temporalEligibility`'s boolean for
  `persistent`/`until-changed`/ `window` entirely in SQL (from/until bound
  comparisons need no timezone; only `recurring` needs per-card weekday+timezone
  evaluation, which SQLite cannot express). `recurring` cards are scanned via
  `scanRecurringActive` in fixed-size SQL chunks (`RECURRING_SCAN_CHUNK`,
  `memoryStore.list({ temporalModes: ["recurring"], limit, afterCursor })`
  iterated to exhaustion), advancing by a KEYSET cursor
  (`MemoryCardFilter.afterCursor`, matching `list`'s `updated_at_ms DESC, id`
  order) rather than an increasing `OFFSET` — an offset loop would make SQLite
  re-walk and discard the entire already-seen prefix on every call (O(N²) row
  visits across a full scan), while the cursor makes each chunk O(chunk size)
  regardless of how far into the scan it is — backed by
  `../db/migrations/0016_memory_cards_recurring_scan_idx.sql`'s
  `(temporal_mode, updated_at_ms DESC, id ASC)` index, without which SQLite
  would still scan/sort the remaining recurring rows per chunk despite the
  cursor (verified via `EXPLAIN QUERY PLAN` in
  `../db/memoryStoreQueryPlan.test.ts`). An exact count still requires examining
  every recurring card (eligibility isn't SQL-computable), but only the
  requested `[offset, offset+limit)` window of eligible cards is ever retained,
  so memory stays bounded by the chunk size + page size regardless of how many
  recurring cards exist; it is NEVER fetched whole. The recurring page and the
  deterministic SQL page are merged (recurring bucket first) for an exact
  combined `total`/pagination with no truncation. `getMemoryLineage` (card +
  predecessor + superseded-by chain), `recentMemoryLoads` (per-session audit
  batches), and validated `mutateMemory`
  (edit/correct/pin/unpin/archive/restore) that reuses the lifecycle service —
  `expectedRevision` conflicts return the current card rather than clobbering
  concurrent changes. Untrusted client filters/operations are coerced
  (`coerceMemoryListFilter`/`coerceMemoryMutateOperation`) before any side
  effect. Its idempotency key is derived from a `MemoryMutateIdentity`
  (`connection.ts`'s server-minted per-connection id + the client's `requestId`)
  PLUS a content hash of the validated operation — never a bare client-supplied
  `requestId` alone, which is tab-local/caller-chosen and could otherwise
  collide across connections or be crafted to replay an unrelated operation's
  cached result. `connection.ts` only sends the results; `memoryEvents.ts`
  broadcasts targeted invalidations so concurrent tabs converge.

## Contract notes and rationale

- Every mutation returns compact `{ ok, card | reason | error }`; existing-card
  mutations are revision-checked and never silently overwrite a newer card.
- Corrections MUST supersede-then-create atomically; never erase history or
  leave a contradictory active duplicate.
- Scope is intersection semantics: every dimension a card specifies must match;
  absent dimensions are global. Ordinary `assistant` and singleton
  `personal-assistant` are isolated personas.
- Keep SQL out of this folder; go through the `../db/memory*Store.ts` facades.

## Verification commands

- Run `pnpm --filter @assistant/server test src/memory` for this subtree.
- Run `pnpm --filter @assistant/server typecheck`.
