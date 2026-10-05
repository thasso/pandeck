# Web hooks — implementation reference

Relocated from `app/web/src/hooks/CLAUDE.md` (Task-274) so it stops costing
agent context on every visit. This is a descriptive snapshot of what the modules
in that subtree own; the rules an agent must not violate stay in that folder's
`CLAUDE.md`. Correct or delete a section here when the code moves on. Relative
paths in the body are relative to the original subtree.

## Purpose

Reusable React hooks for assistant WebSocket state, routing, preferences,
backlog/task interaction, calendar data, and drag/reorder behavior.

## Module ownership

- `useAssistant.ts` holds the chat's `DisplayProjectionCache`
  (`@assistant/shared/display`) at MODULE level, and `withChat` passes it on
  every re-projection. It is deliberately not React state: it is keyed on entry
  identity, so a hit returns exactly what a rebuild would, which keeps the
  reducer idempotent under a double invoke and makes a foreign key cost a miss
  rather than a wrong transcript. Without it the reducer hands React a brand-new
  object for every message on every runtime event, and no memoized row in the
  transcript can hold.
- `useAssistant.ts` applies `ClientRuntimeEvent`s, never the runtime's own
  vocabulary ([Task-697](pa://task/697)): live thinking blocks and tool bodies
  are `LiveBodyRef`s on `liveStreams` (`liveBodyProgress` creates the block at
  its index with empty text; `toolEnded` stops the spinner with the output's
  size), and text reaches them only through `liveBody` frames — `replace`
  resets, `append` must continue what is held or is DROPPED (`applyBodyFrame`),
  since the next snapshot or resubscribe replaces the body whole. Demand is
  ref-counted per SESSION and body key
  (`setLiveBodyDemand(sessionId, key, wanted)`, driven by
  `ToolCallBlock`/`ThinkingBlock` visibility through `AssistantMessage` and
  `tools/registry.tsx`'s `GenericToolBlock`; `MessageList` binds its session id
  in and re-binds when it changes, so a live row that stays mounted across a
  switch — same message id, same stream key — re-registers under the new session
  with no visibility toggle, `AssistantMessage.liveDemand.test.tsx`). The
  COMPLETE set for the viewed session goes out as `setLiveBodySubscriptions` on
  the next microtask after a change, and again from the effect keyed on
  `snapshotGeneration` — the commit that carries a snapshot, after the blocks'
  own effects have run — because a session switch or reconnect attaches a
  transport that starts with no demand; a send from the socket listener would
  run before the reducer had applied the new session and name the old one.
  Entries under any other session id are pruned at each send, never sent; frames
  for another session are dropped by the reducer
  (`liveBodySessionSwitchScenario.test.tsx`). A `timelineDelta` upserts every
  entry it carries, and `carryLiveBodies` moves a fully hydrated live body onto
  the durable block only when the lazy ref's `contentHash` (length + SHA-256)
  matches the held text or serialized input — the same rule
  `carryHydratedBodies` applies to a later declaring correction; anything else
  keeps the preview and the ref, so the exact persisted body loads on demand.
  Local hydration only; the persisted timeline cache still describes the compact
  projection.
- `useAssistant.ts` gives a durable-body read (`loadTimelineBlock`) a lifecycle
  rather than a flag: `pendingLazyBlockLoadsRef` holds each read in flight with
  its session, identity and attempt count. A read leaves it when answered —
  `timelineBlockLoaded`, or `timelineBlockFailed` by name — and a transient
  failure earns one more attempt after `LAZY_BLOCK_RETRY_MS`
  (`LAZY_BLOCK_MAX_ATTEMPTS` bounds it); a block the server reports
  `unavailable` is not asked for again until a snapshot of its session arrives,
  which REQUEUES it as one bounded read — explicitly, because a cache-hit
  snapshot keeps entry and ref identity and the block's own effect never
  re-fires. Every snapshot REISSUES the session's outstanding reads as fresh
  attempts and drops other sessions' — a reconnect or reload attaches a
  transport that never saw them, and a read lost with the old one used to stay
  "pending" forever, leaving an expanded block a preview until a full page load.
  The reducer ignores answers for a session that is not viewed, and the body
  cache is keyed by session (`lazyBodyLifecycleScenario.test.tsx`).
- `useAssistant.ts` writes the app shell cache (`localStorage`) only through a
  `lib/idleWriter.ts` `IdleWriter`, never straight from the effect: the payload
  is a `JSON.stringify` of the session list plus the cacheable Task list (~217
  KB measured against production data) and a blocking `setItem`, on an effect
  that fires up to ~4x/second while any agent streams. Deferring it costs
  nothing — it is a COLD-START accelerator, so lagging live state by seconds is
  invisible — as long as it is flushed on `pagehide`/hidden and unmount.
  `taskListForCache` additionally drops any Markdown body a summary happens to
  carry; `descriptionPreview` stays, because every Backlog row renders it and a
  cache that paints the list wrong has no purpose.
- Optimistic mutations are correlated by `requestId`, never by arrival order,
  and a failure RECOVERS by refetching rather than by restoring a snapshot. Each
  one (`saveTask`, `assignTaskProjects`, `archiveTask`, `deleteTask`,
  `reorderTasks`, `saveProject`, `updateSettings`, `renameSession`,
  `deleteSession`, `archiveSession`, `removeWorktree`) mints an id, parks its
  domain re-read in `pendingMutationsRef`, and is resolved ONLY by that id's
  `error` (re-read) or `mutationSettled` (drop it). Worktree removal filters the
  row immediately while the filesystem operation runs; a failure re-lists
  worktrees. Writing a pre-change copy back would erase whatever landed in
  between — an agent broadcast, another tab, a second local edit — and Projects
  and Settings have no periodic broadcast that would repair that; the
  authoritative answer is one round trip away and is correct whatever happened.
  Correlation has to be explicit because these domains also receive unsolicited
  authoritative broadcasts, which the earlier FIFO queue consumed a pending
  entry against — leaving a genuine failure with nothing tracking it. A mutation
  the server never answers is dropped after `MUTATION_SETTLE_TIMEOUT_MS`: that
  forfeits only the recovery refetch (the next authoritative broadcast still
  corrects the state), while waiting forever would block the shell cache, which
  deliberately never persists optimistic data.
- `useAssistant.ts` owns WebSocket lifecycle, server-message reduction,
  optimistic runtime state, and action dispatchers. `pullRequestCards` is a
  client overlay (like `approvals`) rather than part of the durable timeline:
  `pullRequestCardUpdate` upserts a card by id (`upsertPullRequestCard`), and
  `withChat` restores it to its issuing `/pr` tool call's position via
  `sourceToolCallId` (`mergePullRequestCardMessages`, mirroring
  `mergeApprovalMessages`) — never tail-appended, and reset to `[]` on every
  session-snapshot switch since the server re-emits it on attach. Both stores
  hold every card of the session while the timeline is a windowed suffix, so a
  card older than the loaded window is held back (`loadedHistoryStart`) until
  "load earlier" brings its turn in; placed by timestamp it would sort ahead of
  every loaded row, which stacked a long session's whole card history on top of
  its last few turns. `choosePullRequestTask` answers a `choosing-task` card's
  disambiguation prompt, and `runPullRequestCardAction` fires a card action
  (merge/update/cleanup/Task done) as a tracked mutation: a browser-local
  `pendingAction` bridges the click to the server's durable `busyAction` (which
  still wins, so every viewer sees the same action in flight), and the
  linked-Task/worktree effects go through their canonical optimistic reducers.
  The card's own `actionError`/`actionMessage` are only read as this click's
  outcome AFTER the server's `busyAction` echo — before that they still hold the
  previous action's text (`docs/state-sync.md`).
- `useAssistant.ts`'s socket handler is also where a server message is SAID out
  loud (`announceArrival`, beside `appNotification` and for the same reason: an
  announcement is an event, and there is nothing about it to reduce). It runs
  just before the dispatch, so the decision is made from the message and the
  state it ARRIVED into. A tracked mutation's failure is answered earlier — its
  own control renders it, so the object keeps no second copy (`controlOwned`) —
  but it is still ANNOUNCED from there against the same claims, because a
  control the user has navigated away from renders nothing. What outlives the
  arrival is a failure on its session (`sessionFailures`), a failure on its
  project, Task or Knowledge entry (`objectFailures`, keyed by type then id,
  retired by that object's own next write or its note's dismiss), and a list
  failure on its collection
  (`projectListError`/`taskListError`/`worktreeListError`, routed by target
  rather than by the sentence); `error` is the viewed chat's last OUTCOME, not a
  message waiting to be said. There is no global message slot —
  `docs/messaging.md` has the reasoning and what each earlier shape cost.
- `promptQueueStates` is the same idea one level down: a condition kept on a
  single MESSAGE. It maps a transcript row id (`creq-<clientRequestId>`, the
  optimistic echo) to where that prompt stands in the permanent Assistant's
  queue, and `MessageList` renders it on the row. Only the unresolved states
  live there — `completed` and `failed` retire the entry rather than being one,
  and the failure goes to `sessionFailures` like every other session failure,
  retired like every other one (the dismiss, or that session's next send) and
  never by a later `completed`, which always belongs to a DIFFERENT queue item.
  The echo is still on screen for both conditions: the server reports `working`
  before starting the run whose durable user entry retires the echo, and that
  `entryAppended` hands the condition over to the transcript's own run
  indicator. `permanentAssistantQueue` is reduced ABOVE the viewed-session guard
  — it is a message to a session's VIEWER, not a delta of its stream, so the
  terminal frame retires the row's condition even when the user has navigated
  away mid-queue.
- `useSessionRouting.ts` owns route state and feature URL path helpers;
  canonical session path parsing/building lives in `../lib/sessionRoutes.ts`. It
  also owns `isSectionIndexRoute` — the pure predicate for "a section addressed
  with no object", which is what the shell turns into a mobile browser screen
  (ui-shell.md, Small Screens). A bare `/settings` therefore parses to a
  SECTIONLESS settings route (`section` is optional) rather than defaulting to a
  first section, so the Settings index is addressable like every other section
  index. The staged routes (`/sessions/create`, `/sessions`) canonicalize to a
  real session id only after a first send (armed via `notifyStagedFirstSend`)
  and only to a session id UNKNOWN at the send moment
  (`stagedSendCreatedSession`): the send necessarily creates a new session,
  while every drift frame (late `loadSession` snapshot, background-session
  frames settling, server-driven view switch) names an already-existing session
  and must never be adopted as the send's result. This armed advance is the ONLY
  first-send URL path for BOTH harnesses — a staged first send must never
  `navigate()` to its client-known claude-sdk id, because that id is not in the
  session list until the server creates it and the route's
  pending-unknown-session fallback would canonicalize the URL back to the
  previously viewed session. Route names include `backgroundTasks`, the
  `/background-tasks` registry, whose optional `?task=` anchor names one PA item
  — the same shape the server's `background_tasks` tool hands a model as
  `humanLink`, so an agent's link resolves without translation. It is an ACTION
  surface, not a section: no sidebar location, never a section index route, and
  it loads standalone on a direct reload because its rows come from the
  `background` topic alone.
- `useClaudeLoginTerminal.ts` owns the dedicated authenticated
  `/ws/claude-login` browser lifecycle for Settings: reconnect while the
  official CLI process is still waiting, reduce bounded snapshot/output/status
  messages, and expose only submit/cancel actions to the component.
  Authorization input is sent once and never retained in React state beyond the
  password field owned by the modal.
- `useDictation.ts` owns composer dictation: a single `toggle` (tap to start,
  tap to stop — no hold-to-talk, which lost its meaning once the control that
  starts recording stopped being the control that stops it), the `/ws/speech`
  lifecycle (including the `warm` frame sent as soon as the socket opens so the
  local recognizer loads in parallel), and the transcript hand-off. There is no
  warming state of any kind: a cold model is the server's problem, so recording
  starts and audio streams while it loads. Starting opens the MICROPHONE and the
  socket concurrently, with the microphone first and inside the press's own task
  — Safari only lets a user gesture start audio, and awaiting the handshake
  first spends it — so arming costs max(socket, microphone) rather than their
  sum; frames captured before the `start` frame is out wait in the capture's
  authoritative buffer, since audio ahead of `start` is a protocol violation.
  That window means a capture can be in flight with no handle to stop, so
  `pendingCaptureRef` holds the promise and every teardown path (socket failure,
  server error, unmount) stops the late arrival. A `lib/screenWakeLock.ts` lock
  is held for the recording and released in teardown. The waveform envelope is
  exposed as a `lib/waveform.ts` `PeakRing`, deliberately NOT React state: ~40
  bars a second through `setState` would re-render the whole composer for a
  canvas repaint, so `ui/WaveformStrip` reads the ring inside its own animation
  frame. Ownership is a MODULE-LEVEL single-owner lock, not component state,
  because `Composer` can be mounted several times at once; non-owning mic
  buttons render disabled. Stopping speech is decoupled from finishing delivery:
  on stop it flushes the watermarked backlog, waits briefly for the socket to
  drain, and falls back to `POST /api/speech/transcribe` with the capture's
  authoritative buffer when the socket died or never drained — a slow link must
  never cancel an utterance. `Escape` and a hidden tab cancel (a backgrounded
  tab suspends the `AudioContext`, so recording would silently capture nothing).
  Each utterance carries an ID that is also its IDENTITY: `teardown` clears it,
  the upload is aborted with it, and everything that resumes AFTER AN AWAIT
  checks it again before touching a shared ref, the phase, the socket or
  `teardown`. That is every completion path (socket transcript, socket error,
  HTTP answer, HTTP failure) and every continuation in between — the handshake,
  the microphone's arrival (the longest wait there is, since a permission prompt
  can sit unanswered), each drain wait, and both start/stop catches. UNMOUNTING
  ends an utterance the same way — a comment composer can close
  mid-transcription with no cancel anywhere — so the cleanup invalidates the id,
  aborts the upload and clears the timers itself; it cannot call `teardown`,
  which sets state on a component that is going away. A socket's
  `onmessage`/`onerror` are scoped by the utterance they were INSTALLED for,
  before they read anything: closing races the server, an error frame's
  `utteranceId` is optional and the native `error` event has none, so the socket
  a frame arrived on is the only thing that can place it. Ending an utterance
  cannot recall the work it started (a close races the server, a POST is already
  on the wire), so a late answer must be DROPPED rather than handed to a caller
  who has moved on, and must never run `teardown` against the utterance that
  replaced it. This is the hook's job alone: from a composer, two utterances of
  the same hook are indistinguishable (`useDictation.test.tsx`). Every delivered
  transcript (WebSocket and HTTP-fallback paths alike) is also passed to
  `lib/recentTranscripts.ts` before the caller sees it, so Settings can surface
  recent wording for vocabulary authoring.
- `useTranscriptScroll.ts` is the SINGLE owner of the chat transcript's scroll
  position (`components/MessageList.tsx`), over the policy and memory in
  `lib/transcriptScroll.ts`. It replaced four effects racing over two refs, and
  the thing they could not do is the thing it exists for: content that changes
  height AFTER the commit that caused it — a lazily imported tool card mounting,
  a commit card turning its dry run into a commit, Shiki, an image, an expanded
  output, the container itself shrinking under the mobile keyboard — reaches it
  through a `ResizeObserver` on the container and the content, not through a
  single `requestAnimationFrame` guess. A restore is therefore a LOOP, not one
  shot: it re-applies the anchor after every height change until the READER
  touches the transcript or a 2s deadline, and while the row is still missing it
  keeps looking rather than dropping the reader at the bottom on the first
  commit — the transcript arrives in stages (a widened render window, lazily
  loaded blocks), and giving up early is what made the old restore feel random.
  A boot-cache PREVIEW is deliberately outside that loop: persisted restoration
  waits for the authoritative transcript and validates the memory's two-row tail
  key against it. Otherwise a position saved before a later turn completed can
  paint the cached end and then jump thousands of pixels into an older suffix —
  the reported regression after byte-windowed timeline caching made that race
  visible on large sessions. If the reader scrolls the preview first, that input
  cancels deferred restoration and its position wins; the controller also
  records nothing while the deferred restore exists, so its temporary bottom
  cannot overwrite the real memory. A remembered position rests at the END while
  its row is missing and stays there if it never arrives (forked away,
  compacted); a jump to a row the transcript already lists does not, since that
  row is one render away. Two invariants: nothing here may `setState` on a
  scroll or a resize (rows are memoized and the list re-renders as fast as
  tokens arrive; the one exception is `onRequireRows`, once per restore), and a
  scroll the READER made hands them the position. Whose a scroll is cannot be
  read off the offset: comparing `scrollTop` against the value we last wrote
  only ever proves a scroll is OURS, never that it is not, because the browser
  rewrites the offset in the same frame we write it — measured at ~400px per
  frame, 23 of 24 events, while `content-visibility` estimates resolve above the
  reader. So the reader is tracked from their INPUT instead: `wheel`,
  `touchstart`/`touchmove`, `pointerdown` on the container plus the scrolling
  keys at the document (never a caret moving inside a text field), and
  `READER_INPUT_MS` after one of those every scroll is theirs — long enough to
  cover a fling's tail, which keeps firing `scroll` with no finger on the glass.
  The other half is the `ResizeObserver`, which dates every size change (in
  `free` mode too — what it records is that the layout moved, not what to do
  about it): a scroll inside `LAYOUT_SETTLE_MS` of one that NO input backs is
  the layout's, changes no mode, and is re-applied instead, which is what keeps
  a just-submitted turn's Thinking row from parking under the bottom card and
  keeps a "load earlier" hold alive through the churn it exists to absorb. The
  input that ASKED for a restore or a pin is consumed (`takeReaderIntent`): the
  tap on send and the keyboard closing under it are one gesture, and only the
  second half reaches the container. The browser's own `overflow-anchor` is now
  left ON in every mode — measured, it holds the content still to the pixel
  through those same estimate corrections, so this controller corrects the
  residual rather than replacing it. That is not enough on its own, which is
  what the STICKY anchor is for: a released hold keeps its row, and a height
  change in `free` mode that no reader input backs puts that row back. Measured
  on a transcript of ~600px rows — a "load earlier" prepend applies correctly,
  and the rows mounted above the reader then resolve their `content-visibility`
  estimates ~2s later in ONE +19,966px resize, past any deadline a hold can
  have; the browser does not absorb it either, because the controller's own
  correction a frame earlier is a programmatic scroll, which suppresses
  anchoring. So `free` is hands-off about SCROLLING, not about content appearing
  above the reader. It costs one rect read per resize (the row element is kept,
  never looked up) and is dropped on any change of MODE, because a row describes
  the reader's position in the EPISODE that captured it: submitting pins to the
  bottom with no reader input to clear the row, and a later unbacked scroll into
  `free` (find-in-page, a `focus()` from the cross-pane jump) would otherwise
  let the first resize after it put the reader back on a row hundreds of
  messages away. Every mode change therefore goes through one setter that bumps
  the episode, and the hold's release is the single handover a row is allowed to
  survive. Ownership of `free` mode changes once per episode, in this order: the
  browser's anchoring holds the position until the first sticky correction, and
  since that correction is a programmatic scroll — which suppresses anchoring —
  the sticky anchor holds it alone from there. On WebKit there is no first owner
  to inherit from: `overflow-anchor` is unsupported in every iOS browser (Safari
  26.2). The sticky anchor still holds ordinary late height changes there, but
  `index.css` does not ask it to race a `content-visibility` estimate resolving
  during touch: transcript rows are `visible` under the iOS-only
  `-webkit-touch-callout` feature query. The render window starts bounded and
  grows only when the reader asks for older rows, so truthful geometry trades
  incremental layout work for removing the source of the jump. Chromium with
  anchoring disabled showed that the controller could buy back nine simulated
  jumps of ±200–2,900px, but it cannot prove that WebKit delivers its resize
  before painting the estimate correction. The row is still not dropped by the
  input that starts a gesture — nothing has moved at the moment an input
  arrives, and from the gesture's first scroll on every scroll event refreshes
  it in O(1): one `elementFromPoint` at the top edge plus one rect read, no walk
  and no `setState`. Two things that hit test finds are not rows, and both
  recur: the margins between rows (20px at a turn boundary, 12px between
  assistant rows), where the hit is the content column and says nothing about
  where in it the point fell — which is what the second probe 24px down is for;
  and the blocks BETWEEN rows (a turn-end separator with its stats row, the
  "load earlier" button, the standalone Thinking indicator, all siblings of the
  rows), which resolve to the row below them, the same answer `scanRows` gives
  for an edge that falls between two rows. Per the spec's rendering update, the
  scroll steps run ahead of the intersection observations that
  `content-visibility` relevancy rides and ahead of the `ResizeObserver` loop,
  which is what leaves the resize measurable against the offset the scroll just
  stored, and corrected before that frame paints. What a gesture changes is the
  PRICE of a correction, not who owns the position: while it is running the
  drift must clear `GESTURE_DRIFT_PX` (64px) to be worth a write, because a
  `scrollTop` write during an iOS momentum fling stops the fling — measured,
  that buys back the nine jumps with nine writes over sixty wheel steps and
  leaves everything smaller to the reader's momentum. The gesture has its OWN
  clock, rolled forward by each scroll attributed to the reader, and one clock
  drives both halves on purpose: the row is refreshed exactly while corrections
  are priced, so it can never be stale at the moment one gets cheap. Keying the
  price off the reader's INPUT instead left a fling that outlived
  `READER_INPUT_MS` freezing the row where the window closed, and the next
  resize wrote the whole untracked distance back — 900px for a 2s tail, and the
  write stops the fling too. Widening the input timestamp itself would have been
  the wrong fix: it also feeds `nextScrollMode`, where near the bottom a layout
  scroll arriving in the extended tail would flip the mode to `bottom`. Drift is
  always measured against the row's OFFSET and never against `scrollTop`, which
  is what makes this cooperate with browser anchoring instead of doubling it:
  where anchoring already absorbed a change it moved `scrollTop` by exactly the
  amount that leaves the offset alone, so the residual is zero and nothing is
  written. The row walk also samples the heights of the rows on screen and feeds
  them to the row-estimate rules in `lib/transcriptScroll.ts`, writing the
  result to `--transcript-row-estimate` (the `contain-intrinsic-size` every
  unrendered row reads in `MessageList.tsx`). Three DOM-side rules go with
  those: the estimate is reset per SESSION, since it describes the rows of one
  transcript and a prose session's 600px is the wrong opening guess for a
  tool-heavy one; the change threshold gates the CSS WRITE, never the estimate
  itself, which otherwise stalls inside the deadband and settles short of the
  transcript for good; and the WRITE compensates the reader in the same frame,
  because it relayouts every skipped row and moves the content under an
  unchanged `scrollTop` by (Δestimate × skipped rows above) — measured at
  +28,551px for one 240→464px publish, and in BOTH directions as the estimate
  follows the rows on screen. Neither existing hold catches it: browser scroll
  anchoring does not cover `contain-intrinsic-size` changes of skipped rows, and
  a record runs 150ms after the reader's last input — inside the window where
  the sticky anchor holds a correction to its mid-gesture threshold. The publish
  therefore puts the row the record just walked back at its offset itself,
  unconditionally — the shift is the controller's own, not the reader's and not
  a fling's. Two more shifts are the controller's own, and neither reaches it as
  an event. A DISPLAY PREFERENCE reshapes every row at once: the menu that flips
  it is portaled out of the container, so no input of the reader's arrives, and
  `syncAfterRender` used to return early in `free` mode and leave them wherever
  the new layout put them. `holdViewChange` is therefore called by the HOST, in
  the event that flips the flag and before the state update that renders it
  (`App.tsx`'s `updateTranscriptView`, which registers it through
  `MessageList`'s `onRegisterViewHold`) — the layout that has to be measured,
  where the reader's row sits with the tool calls still hidden, is gone by the
  time the change has rendered. Deliberately NOT a render-phase comparison of
  the flags, which reads the right layout but at the wrong time: React renders
  work it may abandon, and a capture there arms a restore, takes the mode and
  widens the window for a preference that was never committed. The event only
  MEASURES, and the restore is started by `commitViewChange` from the commit
  that reshaped the rows (`MessageList` tells that commit apart by its view
  token and calls it in place of `syncAfterRender`) — a hold is a 2s deadline
  against a layout that is still moving, and the flip is scheduled as a
  transition React may defer or restart for as long as urgent work keeps
  arriving, so timing it from the click can run it out before there is anything
  to hold, settle, and take the fallback rows with it. A capture the reader has
  overtaken is dropped instead of applied: a scroll or an input after it, or any
  change of episode (a submit pinning to the bottom, a session switch), and
  putting their row back where it sat before their own gesture is the one thing
  a hold must never do. That hold also carries FALLBACK rows, which no other one
  needs: "show tool calls" off unmounts every tool-only turn, and the row a hold
  was captured from can be one of them, so the walk keeps a bounded run of the
  rows below it (with the offsets they had) and the restore takes the first that
  is still in the transcript. Off iOS, a WARM-UP renders the rows the browser is
  skipping, a couple at a time, while the reader is stopped: a row that has
  never been laid out is worth one estimate for the whole transcript — measured
  on one 120-row window, 116px, 185px, 202px, 1,624px, 4,481px and 5,961px rows
  all reading 727px — and it corrects itself by that difference exactly when the
  reader scrolls into it, mid-gesture, where a correction is priced at
  `GESTURE_DRIFT_PX` and costs the fling it interrupts. A batch flips its rows
  to `content-visibility: visible`, forces the layout with the rect read the
  correction needs anyway, and hands them back a full frame later — not the same
  frame's `requestAnimationFrame`, since the size a skipped row keeps is
  recorded at the end of a rendering update it was rendered in, and a batch
  handed back before that frame renders keeps nothing (measured: the rows came
  straight back to the estimate). Both corrections go through the same hold, and
  a batch only ever runs between gestures — never through a restore, never
  inside `READER_INPUT_MS` of the reader, and the second correction is dropped
  outright if they started scrolling in those two frames. Measured on a first
  upward read of a 2,000-entry session: 7,366px of layout moving under the
  reader, 7,252px of it in ONE frame, and a 25-notch scroll that carried them
  14,708px instead of the 7,500px they asked for — against 0px of movement and
  exactly 7,500px afterwards. It is bounded by `WARM_REACH_PX` from the
  viewport, because rendering every row of a window that "load earlier" can grow
  to a thousand is the layout cost `content-visibility` exists to avoid — and
  bounded again to ONE batch at a time, which is a different bound and the one
  that is easy to lose. Timers and frames come apart: a hidden tab keeps firing
  throttled timers with no frame to hand a batch back, and so does a long task
  in the foreground, so scheduling the next batch alongside the hand-back rather
  than FROM it renders row after row with nothing undoing any of them — measured
  in that state, the whole 22-row window `visible` at once, which is the hitch
  the batching exists to prevent, paid on the way back to the tab. So the next
  batch is scheduled by the hand-back frame, a batch in flight blocks another
  from starting, a hidden document is not warmed at all (`visibilitychange`
  restarts it), and a teardown or session switch cancels the pending frame AND
  removes the inline `content-visibility` it would have removed, since nothing
  else ever will.
- `useListScroll.ts` is the same idea for a LIST, over the policy and memory in
  `lib/listScroll.ts`: hand it a scroll container and a stable `listKey` and it
  records where the reader stopped and restores it on the way back in. It exists
  because on a phone the object browser is UNMOUNTED, not hidden, as soon as an
  object screen opens (`shell/AppShell.tsx` renders the left panel only on a
  browser route), so the DOM cannot hold the position and neither can component
  state. Three details carry it, and the first is the one that is easy to get
  wrong. WHERE the outgoing position is captured depends on how the list is
  leaving. An unmount can be caught in a layout cleanup, which React runs before
  it removes the host nodes. A key change cannot: React mutates a fiber's host
  children BEFORE running that fiber's layout destroy, so a cleanup there
  measures the list being ENTERED — it files the new rows under the old key, and
  a shorter incoming list clamps `scrollTop` to 0, which the policy reads as
  "the reader is at the top" and forgets a perfectly good position. The sidebar
  hands one container to seven browsers, so that is not an edge case, it is
  every section switch. The outgoing list is therefore captured during RENDER,
  when the container still holds it (`keyRef.current !== listKey`) — read-only,
  one anchor walk per switch, and idempotent under StrictMode's double render.
  Second, the restore is a bounded loop (100ms retries) rather than one shot,
  because a list arrives after its container mounts and re-measures for a while
  after that; it holds the pixel fallback meanwhile and keeps looking for the
  anchored row, settling once two consecutive passes change nothing. Its budget
  is TWO ceilings, not one: waiting for a list that does not exist yet (8s, the
  cold-socket case this feature is for) is not spent out of the budget for
  converging on one that does (1.5s from the moment the target is reachable).
  Third, the container's content root is re-resolved rather than captured, since
  it is replaced on every section switch — an observer bound to the first one
  silently stops reporting "the list arrived" for every list after it. Any
  scroll the hook did not itself cause (compared against the value it last
  wrote, which is also what survives an iOS momentum fling) abandons the restore
  — a controller that keeps correcting after the reader has moved is worse than
  one that never restored. The browser's own `overflow-anchor` is switched off
  for the duration, because content inserted above the viewport would otherwise
  move `scrollTop` by itself and be read as exactly that. It never calls
  `setState`: these are the sidebar's browsers, whose rows are memoized
  precisely so an unrelated broadcast cannot rebuild them. The sidebar keys by
  SECTION, which also fixes the older bug that one shared scroll container made
  every section open at the offset the last one was left at.
  `useListScroll.test.tsx` opts into jsdom and models the geometry (fixed-height
  rows, a clamping container); it pins the key-change capture, the late list,
  the reader's veto and the per-key isolation, and it renders under StrictMode
  because the app does.
- `useBacklog.ts` owns the shared Backlog controller AND `BacklogState`, the
  exact `UIState` slice a Backlog surface reads (`connected`, `taskList`,
  `projectList`, `taskMutations`, `taskProjectsAssignedSeq`, `sessions`,
  `worktreeMerge`). It is narrow on purpose: the sidebar's Backlog sits inside a
  memoized `Sidebar`, so what this type names is what makes the left pane
  re-render — which is why `error` left it the moment its last reader did, since
  a slice that names the viewed chat's failures rebuilds every Task row for a
  fact no Backlog surface asks. Its `sessions` exist for ONE fact — which of a
  Task's linked sessions are RUNNING — so App gates that array on
  `lib/sessionRows.ts`'s `runningSessionsKey` rather than handing over a list
  that churns ~4x/second. The Focus view's **Working** indicator is what reads
  it (`components/BacklogFocusList.tsx` via `lib/taskActivity.ts`), which is why
  the gate matters: without it every Task row would rebuild on each session
  broadcast just to answer a question whose answer rarely changes.
- `useBacklog.ts` learns the fate of its own writes from the REQUEST that
  carried them, never from the sentence the server sent back. A reorder and a
  project assignment each land in a `taskMutations` record (`new:reorder`,
  `new:assignProjects`), which is what feeds the reorder note and the teardown
  of an assignment's dead Undo. Those keys are per OPERATION, not per request,
  so what they separate is these writes from every other message — not one
  attempt from the next; the assignment's pending Undo snapshot is a single slot
  the newer assignment overwrites, so two overlapping assignments share one
  receipt and the failure of either ends it. What those records may NOT do is
  speak: the assignment is the one tracked Task write with no in-place slot to
  be refused in — its receipt is a toast — so its failure is SAID at the arrival
  that reports it (`useAssistant`, into the same `PROJECT_ASSIGNMENT_TOAST_KEY`
  slot, so one replaces the other). Announcing it from the stored record instead
  would re-announce it on every remount that found the record still `error`,
  with no arrival behind it. Both used to match the message TEXT off a global
  carrier, which is not an interface: it fired for a failure about something
  else, and stopped firing entirely once the wording moved
  (`docs/messaging.md`).
- `useBacklog.ts` also binds the archive rules to its list: `archiveTasks` runs
  `lib/taskArchiveRun.ts` (Undo receipt, refusal with its "Archive all N"
  escape) and `canQuickArchive` is the per-row question `BacklogTreePane` asks
  for the phone swipe and the pointer button. Both read a context built from the
  WHOLE list plus the live sessions, because a Task's subtree and its running
  work decide whether it may go — not the row itself. `archiveTasks` passes on
  the IDS it archived (`null` on a refusal), not merely whether the archive went
  through, which is what a surface that has to MOVE the rows itself needs: an
  archive takes the Task's finished subtasks with it (`docs/tasks.md`), so the
  swipe animates that whole set out — and only on the answer that it is leaving,
  never on the request.
- `useWorktreeHosting.ts` owns the app's PER-WORKTREE PR/CI projection: ONE poll
  of `GET /api/worktrees/hosting` for every surface that states delivery — today
  a `comfortable` Task row's chip, on the sidebar and on a Project page. It
  lived inside the Worktrees inbox while that was the only such surface; two
  pollers for one projection would double the provider traffic and let the two
  disagree about the same branch. It is NOT what the Pull Requests section
  reads: that has its own inventory, keyed by pull request rather than by
  checkout (`usePullRequestInventory.ts`). The tiers are unchanged and both are
  timers: fast while a check is actually running, slow otherwise, and the slow
  one is NOT optional because a review, a merge and a new PR all happen on
  someone else's machine, so no local HEAD moves and no watcher fires. A failed
  request keeps the last known map (flapping every row to "unknown" on one bad
  response is worse than briefly stale data), and a response that repeats the
  last one is DROPPED rather than stored (`worktreeHostingKey`) — this state
  reaches the memoized sidebar and through it every Task row, so storing it
  would repaint the whole Backlog every five minutes to say nothing. `active`
  `active` comes from `lib/worktreeHosting.ts`'s `hostingSurfaces`: app state is
  not a licence to poll a provider for a window parked on a conversation. The
  last map is KEPT while inactive, since it is what the next surface renders on
  its first frame.
- `usePullRequestInventory.ts` is the Pull Requests view's read: ONE
  `GET /api/pull-requests` through `useFetchState`, polled every ~60s WHILE a
  Pull Requests surface is visible, projected into the five-state model. The
  BROWSER and the DETAIL PAGE share it — the detail route resolves its pull
  request out of the same answer (`lib/pullRequestInbox.ts`'s
  `pullRequestDetailState`) rather than fetching one by number, so the list and
  the page cannot disagree. Polling is a `reload()` of the SAME key, so a poll
  never blanks the rows (R2), and moving between the index and a detail route
  keeps one key. Going inactive parks it at `idle`: the next visit performs a
  real first load rather than painting an answer of unknown age as current.
  `docs/pull-requests.md` is the contract. The detail page's local joins read
  `lib/pullRequestInbox.ts`'s `pullRequestJoinSources`, which carries each
  list's own current-episode freshness — including `sessionListFresh`, the flag
  `useAssistant` sets in the `ready` step that installs the session list,
  because `connected && hydrationSource === "live"` would bless previous-episode
  rows in the reconnect window.
- `useDirtyWorktrees.ts` hands the same rows their dirty dot: the set of
  worktrees with uncommitted changes, derived from `state.worktreeStatuses`
  (`lib/worktreeDirty.ts`) with a STABLE identity — the same dirty set is the
  same object, however many watcher pushes rebuilt the record in between. That
  stability is the whole hook: the set reaches the memoized `BacklogList` and
  through it every Task row, and the watcher reports a worktree an agent is
  writing in several times a second. It is also why the raw record is not in
  `BacklogState` and why a row cannot simply look its own worktree up. Its
  `scope` is the Backlog's own worktrees (`lib/taskActivity.ts`'s
  `taskWorktreeIds`), so a worktree no row can show — the one behind the open
  conversation, say — moves nothing.
- `useWorktreeWatches.ts` binds one surface's git-status watches to the shared
  refcounting registry (`lib/worktreeWatchRegistry.ts`) for as long as that
  surface is mounted: it says only what IT needs, and the registry sends the
  union. That is not tidiness — the wire has no refcount, so two surfaces
  wanting one worktree ended with the first to leave taking the other's watch
  with it. `connected` is part of the lifecycle rather than a guard on the first
  send, because a watch dies with the socket and nothing replays it: a hook
  keyed on the ids alone goes quiet forever after a reconnect and leaves every
  marker frozen at what it last heard. Its three callers are all in `App.tsx`
  (the Backlog's worktrees, the open worktree route, the viewed session's
  worktree) plus `Sidebar` for its own browsers. Tested in
  `useWorktreeWatches.test.tsx`, including two mounted surfaces sharing an id.
- `useFetchState.ts` owns the ONE request/response fetch effect, replacing the
  hand-rolled `let cancelled = false` copies. It is keyed by object identity, so
  the loading-state rules fall out of the hook instead of being remembered per
  surface: a new key drops the data to `loading` DURING render (no frame ever
  paints the previous object's answer under the new id), while `reload()` on the
  same key goes to `refreshing` and keeps the data, keeping it on error too. A
  `null` key (or `enabled: false`) parks it at `idle`. Late answers are dropped
  twice over — the effect cleanup aborts the request and the setter re-checks
  the key on arrival. Contract: `app/web/docs/loading-states.md`. Its
  `useReloadOnToken(key, token, reload)` is how an external invalidation counter
  (a worktree status `updatedAt`, a `knowledgeChanged` timestamp) reaches a
  surface without blanking it: folding the token into the fetch key would drop
  the data on every push, so it reloads the SAME key instead, and it compares
  the previous key too — arriving at an object that already carries a token is a
  first load, not an invalidation of it.
- `useTouchComposerMode.ts` answers ONE question for every composer that accepts
  Enter — the chat one and every comment one: is this a thumb or a keyboard.
  Enter sends on a keyboard (Shift+Enter is the newline) and inserts a line on a
  phone, where the return key is the only way to type one. Coarse pointer AND a
  narrow window, because a touchscreen laptop still has a keyboard; the send
  button never goes away either way, and a missing `matchMedia` (jsdom, a markup
  render) degrades to "keyboard" rather than throwing on the way to a textarea.
- `usePrefs.ts` owns browser-local preferences.
- `useSidebarSection.ts` owns the `SidebarSection` union, the persisted section
  selection, the route→canonical-section mapping (ui-shell.md navigation rules),
  the section→index-path mapping (`sectionIndexPath`, the mobile
  back/browser-screen target; a round-trip test keeps it in sync with
  `parseRoute`), and the nav-bar slot model:
  `NAV_ACTIONS`/`NavAction`/`NavSlot` + `isNavAction` (the app-level actions
  share that bar with the sections, per ui-shell.md) plus its order defaults
  (`DEFAULT_NAV_SLOTS` + `normalizeNavSlots`, consumed by `usePrefs.ts`).
- Backlog/calendar hooks own their feature-specific API calls and derived client
  state.
- `useSelectionAnchor.ts` owns domain-neutral, touch-capable text-selection
  snapshotting. Its 150 ms-debounced document `selectionchange` listener accepts
  only a non-collapsed range inside the current root and captures the quote,
  shared `SelectorBundle` and a cloned `Range`; action handlers never read the
  live selection, which iOS may collapse before a bar click. The live range uses
  only the browser's native selection paint. `hold()` paints the captured range
  as a CSS Custom Highlight once a composer owns it, `release()` ends that
  lifetime, and `clear()` dismisses the action. Escape and an outside pointer
  clear only when the hook is not held.
- `useMemory.ts` owns the memory management/audit feature state over the shared
  socket (memoryList/memoryGet/memoryMutate/memoryLoads requests keyed by
  requestId; mutations resolve a promise for conflict feedback). The list is one
  `LoadState<MemoryListView>` (`list`), not a `cards`/`total`/`loading` triple:
  a filter or page change is a DIFFERENT query, so it drops to `loading` and the
  manager draws placeholder rows, while an invalidation broadcast reloads the
  same query and keeps the rows on screen (`app/web/docs/loading-states.md`
  R2/R3). Lineage (`memoryGet`) is keyed by memory id (`lineageById`, via a
  requestId→id correlation map), not a single shared slot — the manager and the
  Session inspector can each have an independent row expanded (even
  simultaneously), so a shared slot would let one row's fetch clobber another's.
  It refetches authoritatively on `memoryInvalidated` (every currently-open
  lineage id, not just the last-opened one) /`memoryLoadInvalidated` broadcasts
  so concurrent tabs converge — it does not duplicate global reducer state.

## Contract notes and rationale

- Clean up sockets, subscriptions, timers, and DOM listeners in effects.
- Keep reducer updates immutable and predictable; reconcile runtime events with
  shared `@assistant/shared/runtime` types.
- For the currently viewed chat, derive run state only from runtime
  snapshots/events; session list rows are sidebar metadata and must not drive
  the working indicator. Before a direct connection or `loadSession`,
  `useAssistant` loads the IndexedDB timeline RANGE and offers its descriptor; a
  delta snapshot is dispatched only after reconstructing and validating the
  range it will render. That range is deliberately partial for a long session —
  the timeline's gapless suffix, anchored to the live tail — and
  `state.timelineStart` says how much precedes it (the wire's `totalEntryCount`
  is deliberately not mirrored into state — nothing renders a total).
  `actions.loadOlderTimeline` asks for the entries before it, one request at a
  time; an answer that does not join the current first entry exactly is dropped,
  and a missing/corrupt local range reattaches for a fresh WINDOWED snapshot,
  never a splice. `state.turnStatsSeed` (server-computed, and re-sent with every
  range) is what keeps the Session cumulative and context deltas honest over a
  suffix, and what leaves already-rendered turn rows unchanged when older
  entries arrive. The one row that cannot be right over a suffix is the leading
  turn of a window a too-long turn forced open INSIDE itself: that seed says
  `partialTurn`, and `MessageList` draws no turn-end row for the fragment rather
  than a number a later range load would change.
- Avoid duplicating global app state outside `useAssistant` unless it is
  strictly local browser preference/cache.
- Domain lists arrive by SUBSCRIPTION, not with `ready`. `App.tsx` derives the
  topic set from the route + selected sidebar section and calls
  `actions.setTopics`, which diffs it into `subscribe`/`unsubscribe` and
  re-declares the whole set on every reconnect (subscriptions live on the server
  connection). `tasks`, `projects` and `worktrees` travel together because each
  of those surfaces reads all three, and each subscription returns its
  authoritative current list; relying only on broadcasts would leave a cached
  worktree row stale when a tool mutated it while the browser was unsubscribed.
  The `usage` topic works the same way: subscribing delivers the cached
  `usageIndicators` immediately and every later refresh pushes to subscribers,
  while `actions.refreshUsage` is only a hint (the server owns freshness, min
  interval and backoff — `docs/usage.md`). `App.tsx` sends it once a minute
  while a metering page is mounted AND the tab is visible. A browser parked in a
  conversation subscribes to nothing and therefore receives no list traffic at
  all — which is the point, and also why a surface that reads one of those lists
  MUST be covered by that derivation.
- The `tasks` subscription's `taskList` answer is authoritative and replaces any
  locally cached Backlog list on every connection; after it, the list moves only
  by `stateEvents` batches applied through `applyEvent` (`docs/state-sync.md`).
  A snapshot RESETS the per-object revision sidecar and rebaselines
  `stateEventSeq`, since it carries no revisions of its own; a batch whose `seq`
  does not continue the last one means an event was missed while subscribed, and
  the hook resubscribes with a loud log rather than replaying anything. Every
  such list is SUMMARIES ONLY — the wire type says so (`TaskListResponse.items`
  is `TaskSummary[]`), and `lib/backlogTree.ts`'s `Task` is therefore
  `TaskSummary`. A Task's lazily loaded Markdown body lives in
  `state.taskDetails`, a bounded per-id `LoadState<TaskItem | null>` cache,
  fetched per Task via request-correlated `requestTaskDetail`. A newer summary
  makes retained data `refreshing`; it never evicts readable Markdown. The open
  Task id is pinned in both body and activity LRUs until its route closes.
  Authoritative not-found is `ready(null)`, distinct from a failed read, and the
  latest request generation per id rejects superseded answers. `taskSaved`
  adopts its full `TaskItem` as ready rather than refetching and — for a create
  — replaces the browser-local temp row with `taskSummaryOf(item)` at the same
  position. The temp id lives only in `pendingMutationsRef`, keyed by
  `requestId`: the server has never seen it, so an upsert event alone could
  never retire that row. A surface rendering the body must distinguish
  loading/error/not-found from an empty ready body and refuse to save over the
  former. Title and STATUS always come from the row, so lists are correct before
  the detail arrives. Task activity comments use the same bounded keyed
  `LoadState` cache; opening a Task watches and revalidates it, closing sends
  `unwatchTaskComments`, and the cache remains reusable (see
  `app/server/src/CLAUDE.md`).
- `settleSession` mints a `requestId` like
  `renameSession`/`deleteSession`/`archiveSession` and is tracked in
  `pendingMutationsRef`: the server's `error` carrying that id triggers a
  `listSessions`/`loadArchivedSessions` refetch, which is how an ineligible
  settle (running/queued/blocked work) rolls back. Settlement is a LIFECYCLE
  bit, not activity: the optimistic update must never move `updatedAt`, or the
  inbox re-sorts around a row on its way out of the working set. It carries
  `throughRevision` — the `outcomeAttention.revision` the CURRENT row holds,
  read from `stateRef` so every settling surface sends the same observed value,
  and 0 when the row has none, which is the fail-closed answer — and the
  optimistic row acknowledges exactly that revision. `normalizeCachedSessions`
  drops every live-derived field on shell-cache hydration — `isStreaming`,
  `runStartedAt`, `awaitingInput`, `attention`, `queuedWork` — keeping durable
  `lastError`/`settledAt`/`outcomeAttention`/ `archived`; a cached elapsed label
  would otherwise count up from a run that ended while the tab was shut, and a
  stale "Needs your approval" row would both lie and disable Settle until the
  socket re-asserted the truth.
- Worktree review comments are held as authoritative per-worktree projections
  from comment broadcasts; components request/mutate them only through
  `useAssistant` actions. The list/unwatch pair goes through
  `useCommentWatch.ts`, which counts the surfaces holding one object — the
  worktree route and the panel's Worktree tab can hold the same worktree — and
  sends one list for the first and one unwatch after the last, since the wire
  has no refcount and the unwatch deletes the cached threads for everyone
  (`docs/comments.md`). Task activity-trace comments follow the same rule:
  authoritative per-Task full lists from `taskComments` broadcasts, requested,
  unwatched and added only via the corresponding `useAssistant` actions.
- Approval cards are store-backed overlays, not tail-appended transcript
  entries. `useAssistant.ts` keeps their authoritative lifecycle in
  `state.approvals` and rebuilds chat with each card immediately after
  `ApprovalCard.sourceToolCallId`'s tool block; legacy cards without an anchor
  use `createdAt` against durable `DisplayMessage.createdAt`. Lifecycle updates
  replace by approval id and therefore never move or duplicate a card.
- The live worktree-provisioning card is the same kind of overlay:
  `state.worktreeProvision` is keyed by the SEND's `clientRequestId` (not a
  session — a failed provision never produces one) and `withChat` prepends it to
  the chat, matching the position of the durable genesis card the server appends
  once the session exists. It clears on `created` (the durable card takes over),
  on the next `harnessSend`, and on any session snapshot, so a failed card
  cannot leak into another chat. `harnessSend` takes one `HarnessSendInput` and
  returns the `clientRequestId` it used; re-sending under the same id replaces
  the optimistic echo instead of appending a second one.
- The skills library is ONE canonical slot, `state.skillLibrary`, a
  `LoadState<SkillLibraryList>` rather than a nullable list — the `skills`
  subscribe makes the server RESCAN the working tree, so the difference between
  "not asked yet", "rescanning what you can see", "authoritatively empty" and
  "the read failed" is the whole contract (`docs/skills.md`). `setTopics`
  dispatches `skillLibraryLoad` when the topic is added, and the reconnect
  re-declaration does the same, so the pane is pending from the moment the
  request goes out; `beginLoad` keeps rows on screen for the same query, and a
  `skillList` carrying `error` records the failure against the last good list
  instead of replacing it with an empty library. Only Settings → Skills reads
  the slot, and only its rendered section subscribes. Which of those skills is
  ON is NOT in that slot: it is `state.settings.skills`
  ([Task-613](pa://task/613)). `defaultSettings` carries an empty map so an
  unfetched read answers "off" for every skill rather than leaving the section
  undefined.
- Skill toggles are the one settings control that is NOT optimistic: only a
  server echo may show a skill as enabled, so `setSkillEnabled(name, on)` — not
  the generic `updateSettings` — is what the section calls, and it dispatches no
  `optimisticSettings`. That action, not the component, builds the whole-section
  replacement, because the map it must build ON is `state.pendingSkillToggles`:
  the map last SENT, held precisely because the displayed one does not move
  until the echo. Without it a second toggle made while the first is in flight
  would send a replacement missing the first skill and turn it back off. That
  base is never rendered and is keyed BY REQUEST, because writes overlap and
  each is echoed as it lands: a `settings` message names no request, so it
  cannot answer one, and clearing the base on an echo that predates a still
  in-flight write reintroduces the same defect one write later.
  `skillTogglesAnswered` is what retires it, dispatched from the
  `mutationSettled` arrival (which the server sends AFTER that write's echo) and
  from the tracked mutation's recovery, so a refused or unanswered write stops
  being re-asserted by later ones instead of being retried behind the user. An
  answer naming an older request changes nothing. A disconnect clears the base
  outright, since nothing sent is then known to have landed.
- Workflow Runs mirror the other domain lists: `state.workflowRuns` and
  `state.workflowCards` hold the `workflow` topic's authoritative
  `workflowRunList` summary/card snapshot (null/empty until first subscribed).
  Pause, resume, cancel and semantic retry are plain `useAssistant` sends with
  no optimistic state; the next broadcast converges them independently of agent
  availability. `state.workflowRunStarts` holds `workflowRunStart` phase replies
  keyed BY REQUEST id — a map, not a latest-message slot, because several starts
  can be in flight (multiple runs are allowed and a backgrounded provisioning
  takes minutes), and a slot would let a later request's message shadow an
  earlier one's terminal outcome. Entries persist until the consumer drops them
  with `clearWorkflowRunStart`: the start flow clears its own request, and
  `App.tsx`'s background-start settlement (`lib/workflowStart.ts`, pure and
  tested over interleaved outcomes) clears backgrounded ones as it toasts them.
  The `startWorkflowRun` action sends the start command
  ([Task-366](pa://task/366)). `useWorkflowIndicators.ts` narrows summaries to
  active/paused flags per Task and keys content before constructing its Map, so
  a broadcast that changes no indicator preserves the exact Map identity handed
  to memoized Backlog rows.
- Peer-prompt cards are store-backed, not frozen: `peerPromptCardUpdate`
  broadcasts (keyed by an opaque `messageKey`) merge into
  `state.peerPromptCardOverrides`, applied to rendered messages at `App.tsx` via
  `applyPeerPromptCardOverridesToMessages` (see
  `lib/peerPromptCardOverrides.ts`) rather than mutated in place on the durable
  timeline. `peerPromptHistoryExpanded` holds an explicit
  `requestPeerPromptHistory` expansion result, overriding the default bounded
  `SessionState.peerPrompts` snapshot for display; both reset to their defaults
  whenever a new session snapshot loads.
  `seedPeerPromptCardOverridesFromHistory` re-derives the override map from the
  authoritative `SessionState.peerPrompts` projection on every
  `ready`/`snapshot`/`state` message (merged, not replaced, on `state`) so
  navigating away and back or reconnecting shows each card's durable lifecycle
  state immediately instead of the frozen creation-time snapshot until the next
  live broadcast. An explicit `requestPeerPromptHistory` expansion merges into
  `peerPromptCardOverrides` the SAME way (not just into the separate
  `peerPromptHistoryExpanded` display list), so loading more history also
  reconciles any already-rendered transcript card older than the default bounded
  snapshot.
- Jumping to a message is a two-step the hook owns end to end.
  `revealPeerPromptMessage`/`revealTimelineEntry` send `resolveTimelineAnchor`
  and hold the in-flight `revealRequest` (so a superseded answer is dropped and
  the asking control can render busy); the `timelineAnchor` answer becomes
  `state.messageReveal`, a token-consumed navigation signal like `forkSwitch`,
  and a target that is gone is SAID at that arrival and leaves nothing behind.
  The effect beside it then walks the window BACK to `anchor.index` — one
  `loadTimelineRange` sized to the reported distance rather than blind paging,
  repeated while the window is still short of it (the server bounds a range by
  bytes too) and stopped the moment a page fails to move `timelineStart`.
  Without that walk the jump lands at the tail of the right session, which is
  indistinguishable from a broken link. A jump is RETIRED (`revealSettled`) both
  when it is given up on and when the transcript reports landing
  (`onFocusEntryApplied` → `retireMessageReveal`, alongside `App.tsx`'s own
  focus): one left live is a jump waiting to happen again, since reopening that
  session arrives on a fresh tail and the walk back to the old anchor would
  start over. `messageRevealScenario.test.tsx` asserts the walk, both
  retirements, and the stale/gone answers.
- `useLocationHash.ts` observes the one part of the address no route change
  reports: the fragment. It subscribes to `popstate`, `hashchange` AND
  `historyNav` (the app's own `pushState` fires neither event), and it is what
  `App.tsx`'s `#m-<entryId>` effect keys on — the route is identical across
  back/forward between two messages of one session.
  `messageDeepLinkScenario.test.tsx` covers that move, plus returning to an
  address visited before (the "already acted on" key is cleared by leaving it,
  never sticky).

## Working notes

- When adding a server message or client command, update shared protocol types,
  `useAssistant`, and server `Connection` handling together.

## Verification commands

- Run `pnpm --filter @assistant/web test` for hook reducer tests.
- Run `pnpm --filter @assistant/web build` for this subtree.
- Run root `pnpm run build` before closeout.
