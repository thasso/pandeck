# Server session subsystem — implementation reference

Relocated from `app/server/src/session/CLAUDE.md` (Task-274) so it stops costing
agent context on every visit. This is a descriptive snapshot of what the modules
in that subtree own; the rules an agent must not violate stay in that folder's
`CLAUDE.md`. Correct or delete a section here when the code moves on. Relative
paths in the body are relative to the original subtree.

## Purpose

Normalized session subsystem: provider-neutral log model, runtime coordinator,
harness adapters, runtime-to-wire transport, and runtime attachment helpers.

## Module ownership

- `log/` owns passive append-only session log identity, persistence, raw
  entries, and projections.
- `runtime/` owns in-memory live sessions, run state, event emission, prompt
  driving, and abort/config operations.
- `adapters/` owns provider-neutral contracts and concrete pi/Claude SDK adapter
  bridges (`adapters/pi.ts`'s structural `PiDriver` is implemented by
  `piSdk/PiLiveSession.ts`).
- `transport/` owns mapping runtime snapshots/events onto the existing WebSocket
  wire.
- Root session files own runtime attachment glue and the runtime prompt facade.

## Contract notes and rationale

- Maintain dependency direction: adapters emit provider-normalized events;
  runtime consumes adapters and writes logs; transport reads runtime and sends
  wire envelopes; log does not import runtime/adapters/transport.
- The shared normalized model in `@assistant/shared/session` remains
  provider-neutral and dependency-light.
- Subscribe before taking snapshots anywhere event ordering matters.
- Assistant entry `usage` is ONE completed run's own token/cost delta, never a
  session cumulative — consumers (runtime stats, chat turn/session stats, SQLite
  usage totals) sum entries. Harnesses convert their cumulative totals through
  `adapters/nativeEvents.ts`'s `perTurnUsage`, which also carries the real
  prompt-side context snapshot as `usage.contextTokens` (preferred over the
  per-run prompt-token sum, which over-counts multi-request tool loops).
  `NativeAdapterEventSource` stamps `startedAt`/`completedAt` on
  `messageCompleted` so durations are durable.
- Durable conversation content belongs in logs; transient streaming state
  belongs in runtime; hidden prompts stay durable but are skipped by display
  projection.
- A tool result may carry `resultDiff`: the provider's rendered display diff
  with the file's REAL line numbers (pi `edit` → `details.diff`, extracted by
  `serialize.ts`'s `toolResultDisplayDiff`). It flows harness → `toolCompleted`
  adapter event → `ToolResultRawEntry` → client projection →
  `DisplayBlock.resultDiff`, and is rendering-only: never model context, never
  required, and never synthesized when a harness reports none.
- Runtime run state must follow both runtime-driven prompts and adapter-observed
  starts/completions so observed streams never render idle. Provider
  retry/failure diagnostics travel as `providerNotice` adapter events into
  durable `provider.notice` log records: they are projected into the transcript
  with the classified kind, raw message, model and retry details, but never
  enter model context. A provider-reported aborted turn is quiet only when the
  adapter recorded an explicit runtime abort; otherwise its error is persisted
  and its completion is surfaced as a failure.
- Runtime transport owns viewed-session run-state delivery through snapshots and
  ordered runtime events; do not mirror run-state changes through separate
  state/list channels. Snapshot attach lazily projects the complete append-only
  timeline but SENDS a bounded window of it: the tail after a matching browser
  `TimelineCacheDescriptor` range, else the entry/byte-bounded tail — from a
  turn boundary when one fits the budget, otherwise from inside the turn, which
  the seed then flags as `partialTurn` (`docs/reference/shared-protocol.md`) —
  plus the `TurnStatsSeed` for everything before what the client will render. A
  stale, corrupt or empty anchor falls back to that window, never to the whole
  timeline — and so does an anchor whose range would render NOTHING
  (`timelineRangeIsRenderable` over `[startIndex, totalEntryCount)`, Task 450:
  the browsers that cached a pre-floor all-orphan window presented a legitimate
  matching range, were answered with the empty tail after it, and opened blank
  until the floor was applied to the accepted anchor too);
  `SessionLog.clientTimelineRange` answers the client's `loadTimelineRange` with
  the preceding slice and its own seed, and an anchor that is not in the
  timeline is answered with no entries rather than a slice that would not join
  up. `SessionLog.locateAnchor` answers the other windowed question — WHERE a
  jump target sits — by matching over the RAW entries (the client projection may
  have replaced a large tool payload with a preview, so a card identified by a
  key inside that payload is only reliably found there) and returning the
  transcript ROW plus its client-timeline index. The row comes from
  `projection.ts`'s `rowEntryIdFor`, which folds a tool result into the
  assistant entry that declared its call exactly as the shared display mapping
  does: an anchor has to name something the browser renders as a row.
  `timelinePayloadPolicy.ts` must bound verbose tool results by BOTH lines and
  characters because minified JSON/base64 can be one huge line. Its one
  exception is a payload a RICH CARD renders, and which payloads those are is
  decided by `@assistant/shared/toolCards` — the same `toolCardOf` the web
  registry matches renderers with, over the same name, arguments, output and
  error flag — so the server keeps a payload whole exactly when the web draws a
  card from it, in both harness spellings (`normalizedToolName` there strips the
  Claude MCP prefix; pi registers bare names). The two halves are separate:
  `toolCardReadsOutput` says the payload stays whole (every card but the
  question card, which reads only its arguments), and `toolCardReadsInput` says
  the CALL's input stays whole — only the question card and the Task card (it
  lines the operations up with what changed); the peer, show-files, workshop and
  worktree cards render from the payload alone, so a large call input is
  summarized like any other, and the Google/Jira cards read the `render` marker,
  which every summary keeps. A result whose card reads the input re-sends the
  declaring row when that input had been summarized
  (`projectTimelineDeltaForClient`). `session_send_prompt` is a card for a
  second reason: it IS the sender's half of a peer conversation, so a clipped
  payload does not degrade the rendering, it deletes the sent side of the
  exchange from the transcript.
- Live body projection ([Task-697](pa://task/697)). `transport/gateway.ts` maps
  the runtime's internal `RuntimeEvent` onto the viewer's `ClientRuntimeEvent`
  (`@assistant/shared/runtime`); the two vocabularies are distinct on purpose,
  and the projection is where verbose bodies leave the wire. Invariants:
  - Full transcript content stays canonical in the runtime (in-flight streams)
    and the append-only log; the transport never truncates what it reads, only
    what it sends.
  - Every viewer receives the same compact, deterministic timeline. A durable
    row travels as `timelineDelta`, projected by `projectTimelineDeltaForClient`
    with the SAME lazy policy as the attach snapshot and a `loadTimelineRange`
    answer (`liveBodies.test.ts` pins live == reconnect). One append can touch a
    second row: a result whose payload the rich-card policy keeps whole also
    lifts the input summary off its declaring call, so the declarer is re-sent —
    only when that input was actually summarized.
  - In-flight bodies are compact refs (`LiveBodyRef`: stream, block, kind,
    length, lines). A thinking block is announced and kept current by
    `liveBodyProgress`, a tool's live completion is the compact `toolEnded` (the
    `toolEnd` envelope no longer passes through), and a mid-turn attach projects
    `snapshot.streaming` the same way. Tool inputs follow `compactToolInput`:
    inline under the inline bound, whole for the tools whose card renders FROM
    the input (`ask_questions`, `task_manage`), otherwise a summary plus a
    `toolInput` ref.
  - Body TEXT is per-viewer demand, never session state:
    `setLiveBodySubscriptions` carries the complete set of bodies the browser
    renders expanded and near its viewport. Subscribing registers the demand
    first and snapshots the runtime's current body second, in one synchronous
    step (a `liveBody` `replace`), so no delta can fall between them; later
    deltas are `append`s whose `offset` is what the viewer must already hold,
    and a client that finds itself out of step drops the frame rather than
    splicing. Unsubscribing stops text, not lifecycle; resubscribing replaces.
    Demand is scoped to the viewed session and dropped on detach.
  - A body that goes durable is not re-sent: the browser carries its hydrated
    live text onto the durable block itself when the lazy ref's `contentHash` —
    length plus SHA-256 of the text (`bodyContentHash`, pure TS in
    `@assistant/shared/session` so a reducer step can compute it; memoized per
    raw log block on the server) — matches the text it holds (`carryLiveBodies`
    in `useAssistant.ts`), so an expanded block never flashes back to its
    preview and the rest of the row stays the compact projection a reload would
    send. Equality is treated as proof and drops the lazy ref, so the identity
    has to be collision-resistant: a 32-bit checksum collided on same-length
    strings. A mismatch keeps the preview and the ref, and the exact body loads
    on demand. Timeline cache fingerprints describe that compact projection;
    hydration is local and never persisted.
  - Hot-path frames (text deltas, progress, subscribed appends) share one 50 ms
    batch keyed per body; every non-batched event flushes first, so the viewer
    observes the runtime's order.
  - `liveBodies.bench.test.ts` is the deterministic fixture (130-row window,
    ~488 KiB of live bodies) and prints the wire cost: mid-turn streaming state
    500 KiB → under 2 KiB; the live turn 10.6 MiB relayed verbatim → 1 KiB with
    the bodies hidden and 501 KiB with both watched.
- App-level prompt paths must use `runtimePrompt.ts`/runtime-backed views; raw
  engine prompt closures are reachable only by adapter factory code. The runtime
  prompt facade is the model-only enrichment seam:
  `RuntimePromptOptions.memoryBlock` carries effective Memory and `contextBlock`
  carries server-owned structured handoff context; both prepend to
  provider-bound text while the durable app log/projection keep only the clean
  human text. `onUserEntry` reports the accepted user-turn id for the
  effective-load audit. Central callers must not wrap the prompt to inject
  hidden context themselves.
- `planHint.ts` rides that same seam for Plan mode ([Task-330](pa://task/330)).
  Plan is STATE, so the reminder is prepended to `contextBlock` on EVERY Plan
  turn — hidden, steering and agent-origin ones included, because they all reach
  the model — rather than announced once at the switch. Its job is the half of
  Plan the tool policy cannot enforce: v1 keeps the shell, so the hint names the
  shell escapes (`>`/`>>`, `sed -i`, `tee`, `git checkout`/`git apply`, build or
  test artifacts) while leaving reads, search and every app tool explicitly
  fine. The hint specifically permits `task_manage` to create and organize
  durable Tasks, including implementation plans in their descriptions, while
  still forbidding repository or product changes. Claude gets the short form
  because it injects its own plan reminder. It is never Claude's
  `additionalSystemPrompt`, which is persisted with the record and resent on
  every resumed query — toggling it would move the cached prefix
  mid-conversation. Leaving Plan needs no symmetric announcement (the reminder
  stops and the tool block changes by itself) except for ONE clearing line on
  the first Build turn after a Plan turn, because both harnesses resume a
  provider transcript that still carries the earlier in-band Plan lines. The
  bookkeeping commits from `onUserEntry`, so a duplicate `clientRequestId`
  neither consumes the clearing line nor claims a Plan turn; it is in-memory, so
  a restart drops a pending clearing line. Note the seam's known edge, shared
  with `memoryBlock`: the Claude harness's OWN mirrored record entries
  (`ClaudeSdkSession.timelineEntries`) keep the enriched text — the app-owned
  log, the client projection and the timeline the browser renders do not.
- A retained provider may start a turn without an app prompt.
  `beginRuntimeProviderTurn` applies the same worktree, session-run lease,
  frozen skills, and runtime attachment checks, then returns an idempotent
  release for the provider result. It appends no fabricated user message;
  adapter events persist the assistant turn and usage through the ordinary
  runtime, with the system `PromptOrigin` stamped on that assistant entry and
  projected to the transcript's visible origin label.
- Because it is the ONE door every run goes through, `runtimePrompt.ts` also
  carries the dead-worktree invariant ([Task-321](pa://task/321)): a session
  whose `in_worktree` worktree is gone and unacknowledged is refused (a THROW
  carrying `WORKTREE_MISSING_BLOCKED_REASON`) before
  `ensureRuntimeSessionWithRuntime` and before any append, so a refused turn
  leaves no trace in the session. It belongs HERE rather than at the client
  entry points because "resume" has many mouths — queued peer delivery and
  `session_send_prompt`, review handoffs into an existing session, day
  activation/scans, the post-reload continuation, approval outcomes, question
  answers, the merge agent — and each would otherwise have to remember, while
  `resolveSessionCwd` would silently point the agent at the app's OWN
  repository. The check fails OPEN on a store/filesystem error, like memory
  selection. Beside it, and for the same reason, the facade takes a RUN LEASE
  keyed on the session's WORKTREE (`sessionRunLease.ts`,
  [Task-324](pa://task/324)): a prompt is refused outright while a removal holds
  that worktree, and holds it for as long as the prompt is in flight so a
  removal cannot start under it. The worktree is resolved HERE, at admission, so
  a session linked to a held checkout after the hold was taken is refused too.
  The `/pr` card's cleanup is the first holder — it deletes the checkout, and
  merely SAMPLING "is it running" beforehand can never be safe, since a run that
  starts in the gap passes its own worktree check while the tree still exists.
  Both sides are synchronous check-then-set (single-threaded runtime, no `await`
  between check and set), and the state is in memory: it guards an operation
  lasting seconds, and a dead process takes both sides of the race with it.
  After taking that lease and before creating the runtime session, the facade
  calls `sessionSkills`: eager creation paths normally find an existing frozen
  row, while reopen and a legacy session's first post-upgrade run freeze here.
  `connection.ts` keeps its own up-front check on the interactive paths so the
  user sees the refusal before any side effect instead of a failed turn.
- Mid-turn steering must be explicit (`steer: true`) and only used when the
  runtime driver reports `canSteer`.
- Aborted turns are lossless: persist partial assistant content with
  `stopReason: "aborted"` and completed tool results before emitting the aborted
  run completion.
- Live tool completion before durable `toolResult` flush is runtime state: when
  a `toolEnd` passthrough arrives, mirror its output/error/done status into the
  transient tool stream so snapshots/reconnects do not re-open completed tools
  as running.

## Working notes

- Preserve fork/resume identity bindings between app log entries and
  provider-native IDs. They are what makes forking work: a client addresses a
  fork by OUR entry id (the only id it holds), and `SessionRuntime.forkAnchors`
  translates that to the harness's own anchor from the log's
  `providerMessageId`. It answers both sides because the harnesses cut
  differently — pi branches FROM the selected entry (walking to the parent
  itself), while the Claude SDK slices inclusively, so cutting before a prompt
  means cutting AT the turn preceding it. Forkability is projected PER ENTRY,
  not per session: `projectForClient` sets `SessionEntry.forkable` from the
  presence of an anchor (the anchor itself stays server-side), and the display
  projection offers the action only where that holds. Entries recorded before
  their harness captured anchors therefore show no fork action at all, instead
  of one that must fail. Which anchor a "fork before" NEEDS is a harness rule,
  so the shared projection takes the harness
  (`DisplayProjectionOptions.harness`) and each side matches what its server
  branch accepts: the Claude SDK cuts at the turn PRECEDING the prompt, so it
  needs an anchor strictly EARLIER — its first prompt has none and is refused,
  own anchor or not — while pi branches from the prompt itself and needs that
  prompt's OWN anchor, which is exactly how it forks before a session's first
  prompt. Applying the SDK rule to pi offered a fork on an unanchored pi prompt
  that the server then refused; counting a prompt's own anchor for the SDK
  offered one on its first row, which the server refuses too.
- An anchor reaches an entry TWO ways and every anchor-aware view must fold
  both: inline on the row (a harness that knows the id at turn end) or as a
  later `message.providerBound` row (a harness that recovers ids from a
  post-turn scan). `effectiveBindings` in `log/projection.ts` is that fold, and
  the bookkeeping row wins as the later correction. Missing it makes a whole
  harness look unanchored — pi binds EVERY entry that way and nothing else, so
  its fork action silently disappears.
- A provider scan is that provider's OWN transcript and is never positionally
  aligned with our log. One prompt drives one agent turn, but that turn writes
  one native assistant message per model call —
  `assistant(call) → result → assistant(call) → result → assistant(final)` —
  against the single aggregated assistant entry plus trailing tool results our
  log keeps. `SessionLog.bindScannedEntries` reconciles them under scopes that
  are as load-bearing as the matching itself, and the runtime supplies them as a
  `CompletedTurnBoundary`:
  - ONLY THE TURN THAT JUST COMPLETED. The runtime captures the log cursor when
    a turn opens (`LiveRuntimeSession`'s `beginTurn`, from the prompt path and
    from an observed `messageStarted`) and hands it over with the scan, which
    reports the WHOLE native file. Without that boundary the first scan of an
    existing session would anchor its entire history — a backfill this feature
    must not perform. The boundary SURVIVES the run completion that closed the
    turn, because the scan is delivered after it.
  - ONLY PROMPTS THE PROVIDER ACCEPTED. A prompt is appended to the log BEFORE
    the provider answers, so a refused steering message is one we hold and it
    never saw. The boundary therefore names the accepted prompt entries, and a
    refused one is left out of the pairing entirely: counting it would pair the
    turn's own prompt one row too far back, onto a PREVIOUS turn's native
    prompt. A turn with no accepted prompt is not matched at all — nothing
    anchors its tail, and the rows after the provider's last prompt answer a
    prompt our copy does not hold.
  - THE TAIL OF THE SCAN. The completed turn is the last of both transcripts, so
    our prompts pair with the provider's LAST prompts and the rows after them
    must account for exactly this turn. Matching from the START would let one
    historical divergence — a prompt the provider refused, a turn it never wrote
    — shift every later pairing by one and mis-bind silently. Under all of it
    sits one floor: a row already bound to an EARLIER entry may never be
    claimed, so a match that reaches into the session's history is refused
    whatever the counting said.
  - JUSTIFIED, COMPLETE AND ONE-TO-ONE inside the turn, on TOOL CALL IDS — the
    same ids on both sides. A native message may declare only calls this turn
    declared and only once; a native result may answer only a call a claimed
    message ALREADY declared, so a result ahead of its declaration is refused;
    every declared call must be claimed and answered exactly once; the
    provider's results and ours must correspond one for one; and a message that
    ENDS the turn must be the last row of the tail, since a second terminal
    message means the tail spans more than this turn. It is ALL-OR-NOTHING — an
    unreadable call id, a duplicate, a missing result on either side, two
    assistant entries under one boundary (a provider-retried run) or a scan that
    raced the provider's own write leaves the WHOLE turn unbound rather than
    anchoring part of it to the wrong message. An unbound turn offers no fork
    action; the next turn is matched independently, so divergence is never
    contagious. The aggregated assistant entry binds to the LAST native
    assistant message of its turn and ALWAYS records the turn's TERMINAL native
    id (`providerTurnEndId`, surfaced as `forkAnchors().ownTurnEnd`) — an
    aborted turn ends on a tool result, and the field's PRESENCE is what tells a
    reconciled binding from one written before turn ends existed.
- A fork's durable half is `SessionRuntime.forkLog` → `SessionLog.copyPrefixTo`,
  and EVERY harness owes it. It is harness-neutral (the log store is keyed by
  session id alone), but the two branches reach it from different places:
  `claudeSdkStore.forkSession` calls it internally, because the session record
  is derived from the copy, while a pi fork is seeded by `harnesses/fork.ts`
  after `piStore.forkSession` returns — pi branches its own session file and
  never touches our log, so a pi fork without that call opens on an empty chat
  beside a pi session carrying the whole history. `prepareFork` validates its
  cut with `SessionRuntime.canForkLogAt` BEFORE calling pi, whose branch writes
  a session file nothing would reference if our copy then proved impossible.
- A pi fork's two cuts must name the SAME TURN, and `harnesses/fork.ts`'s
  `piForkCut` is where that is decided. "before" is the simpler half: pi walks
  to the selected prompt's PARENT, so we copy through the entry immediately
  preceding that prompt (`forkAnchors().precedingEntryId`) — anchored or not,
  because copying our log needs no anchor, and copying only to the nearest
  ANCHORED entry would drop a turn the reconciliation left unbound from the
  child's transcript while pi's branch still carries it in context. The first
  prompt has nothing before it, so the copy is empty, which is what pi answers
  with a fresh session too. "at" cuts each transcript at its OWN end of the
  chosen turn, because the two end it in different places: our copy runs through
  the tool results trailing the aggregated entry
  (`SessionRuntime.forkCutEntryId`), pi through the turn's terminal native
  message (`forkAnchors().ownTurnEnd` — its final assistant answer, or the last
  tool result of an aborted turn). An entry anchored BEFORE turn ends were
  recorded has no `ownTurnEnd`, and its `own` names the message that OPENED the
  turn, so it keeps the older rule instead: cut pi at the anchor of OUR turn-end
  entry. When that entry is unanchored too — the shape a legacy positional
  binding leaves on a multi-cycle turn, where it stopped before the tool results
  — NO id names the end of that turn and the fork is REFUSED with a message
  saying so. Nothing repairs such a binding, and nothing may be cut at the
  entry's own native message instead: that would hand the child tool calls whose
  results nothing holds and drop the turn's final answer, while our copy showed
  both. (Seeding the child's log stays required rather than optional: pi
  branches its own file and never touches ours, so an unseeded child opens on an
  empty chat beside a pi session holding the whole history.)
- Because those two cuts are ids in DIFFERENT spaces, `piStore.forkSession`
  takes both: `nativeEntryId` to branch at, and `originEntryId` — the app log
  row the user clicked — for the `forkOrigin.parentEntryId` it records. Fork
  lineage is UI data: the client focuses `parentEntryId` in the parent's
  transcript (the boundary marker's link and the branch panel's jump), and it
  holds no pi ids, so a native id stored there resolves to nothing. The
  divergence is not hypothetical — a fork at a tool-using turn branches pi at
  the native message that turn ENDED on, which is not the row that was clicked.
  The claude-sdk fork already recorded our id; this keeps the two harnesses on
  one contract. Three rules in the copy itself are load-bearing:
  - The copy is UNANCHORED. A provider fork rewrites the transcript it copies
    (the Claude SDK remaps every message uuid), so a parent's native ids name
    nothing in the child's — carrying them over would hand a later fork an
    unresolvable id. The child re-anchors through its own turns.
  - The app cut runs to the END of the anchored entry's turn, not to the entry
    itself: tool results are appended AFTER the assistant row that declared the
    calls, while the provider transcript carries them BEFORE the anchored
    message, so cutting at the row would keep tool calls and drop their outputs.
    Only results OWNED by that turn extend it, and only a user row stops it:
    stepping over anything else trades copying a stray app-only card for never
    truncating a turn, which is the safer failure.
  - Ids naming something outside the child are dropped: native anchors AND
    `clientRequestId`, whose inheritance would make the child treat a resubmit
    of the parent's token as an already-handled prompt and append nothing. It
    writes raw instead of replaying `append`, which would re-derive ids and
    mirror the parent's turns onto the child's stats/usage rows.
  - One id points OUT of the child on purpose: every copied entry is stamped
    `inheritedFrom` (`{sessionId, entryId}`), which unlike the anchor is PUBLIC
    — `projectForClient` carries it to the browser, where it marks the end of
    the inherited prefix and addresses the same message in the session that
    wrote it (ids survive the copy). A fork of a fork keeps the ORIGINAL stamp
    rather than re-pointing at the intermediate session. Entries copied before
    this existed carry no stamp; their transcripts simply draw no boundary.
- Keep runtime event shapes synchronized with `app/shared/runtimeEvents.ts` and
  the web reducer.

## Verification commands

- Run `pnpm --filter @assistant/server test` for session tests.
- Run `pnpm --filter @assistant/server typecheck` for this subtree.
- Run root `pnpm run typecheck` when shared runtime/session types change.
- Run root `pnpm run build` before closeout.
