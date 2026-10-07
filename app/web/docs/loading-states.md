# Loading states

Binding model for how the web client shows that data is arriving, missing,
stale, or broken. It covers every async region — a whole pane, a list, an
inspector row, a single button — and it is what `src/loadingStateAudit.test.ts`
and the three-line rule in `src/components/CLAUDE.md` enforce. Decided in
Task-361, built in Task-383, and migrated to in six phases that ended with
Task-391: the audit now has no allowlist and no exemptions.

## The five states

Every async region renders exactly one of these, and it can always say which one
it is in:

| State        | Meaning                                    | Presentation                                                          |
| ------------ | ------------------------------------------ | --------------------------------------------------------------------- |
| `loading`    | No data yet; a fetch is running            | `Skeleton` where there is a silhouette to reserve, else `PaneLoading` |
| `refreshing` | Data on screen, a fetch for it is running  | The data, plus a `RefreshIndicator`                                   |
| `ready`      | Data on screen, nothing running            | The data                                                              |
| `empty`      | The source answered, authoritatively, zero | `EmptyBox` naming what is missing                                     |
| `error`      | The fetch failed, with or without data     | `ErrorNote`; retained data stays under it                             |

`empty` is a property of `ready` data, not a fourth status on the wire:
`lib/loadState.ts` carries `idle | loading | ready | refreshing | error`, and
`isEmpty(state, predicate)` answers the empty question only for data that
actually arrived. `idle` is the fifth status and the sixth state of nothing: no
key, no selection, an inactive pane — nothing was ever asked for.

**Stale-while-refresh is the default.** A second fetch of the same query keeps
what is on screen. Blanking is reserved for a different object.

## The rules

- **R1 — empty is not loading.** An empty state may render only when the source
  is authoritatively loaded: a subscription list `!== null`, a fetch state with
  data. `?? []` over an unanswered source, which then draws "No tasks yet", is
  the bug class this kills — it tells the user their data is gone.
- **R2 — refreshing never blanks.** Refetching the same data keeps it visible
  and marks it with a `RefreshIndicator`. A failure during a refresh KEEPS the
  data and adds a non-blocking `ErrorNote`; it never clears it and never
  swallows the error, because a failure that looks like an empty success is
  worse than either.
- **R3 — a different object gets a placeholder.** Entry A → entry B, day → day,
  inspector → inspector: the new object renders its own `loading` state, never
  the previous object's content under the new id. Keep-content applies to
  refreshing the SAME object or query. The `useFetchState` key encodes object
  identity, so this falls out of the hook rather than being remembered.
- **R4 — initial loads reserve layout.** Where the surface has a stable
  silhouette (cards, rows, meters), the first load draws `Skeleton`s at the real
  content's heights so nothing jumps when data lands. `NewSessionQuickStart` is
  the exemplar. A centered `PaneLoading` is for whole-pane loads with no
  silhouette to reserve.
- **R5 — a mutation busies its own control only.** The initiating button takes
  `busy` (spinner, disabled, `aria-busy`); everything around it stays visible
  and interactive. An optimistic write needs a revert path and a visible error
  (precedent: `useBacklog`'s reorder). ONE accepted exception, and it has to
  stay one: `MergeWorktreeDialog` swaps its body for the merge's phase line,
  because what it started is a server-side phase machine (merging → conflicts →
  agent resolving) that outlives the dialog, and the strategy radios underneath
  are a choice that run has already consumed. A control that stays enabled while
  it spins is the mirror-image failure: either it is busy — all three parts — or
  it is a retry and says nothing about being busy (`CreateWorktreeDialog`'s
  "propose another name", which must stay clickable when the naming agent never
  answers).
- **R6 — accessibility and motion.** A loading region carries `role="status"`
  and an accessible label; the persistent container whose content is being
  replaced carries `aria-busy` — never the announcing region itself; every
  loading animation is `motion-safe:`. Spinners themselves are `aria-hidden` —
  the region announces, not the glyph. See below for what each half means in
  practice.

## Surface loading blueprints

These named rules are the default for every per-surface migration:

- **Boot-critical data joins the shell cache.** Data needed for the default
  landing surface's complete first paint is browser-cached and silently
  revalidated. A subscription answer remains authoritative and replaces its
  cached list in place; the cache accelerates a boot, it does not become a
  second source of truth.
- **Connection state is never a fetch key.** A reconnect or domain change event
  calls `reload()` on the SAME `useFetchState` key. It therefore enters
  `refreshing` and keeps data rather than resetting a bespoke `{ status: … }`
  union. Fetch status belongs to `lib/loadState.ts`; local alternatives are a
  bug class, not a style choice.
- **One narration per source per surface.** If a source's placeholder or error
  is already visible, secondary controls disable quietly. They do not repeat the
  same loading or failure sentence elsewhere on the page.
- **R4 applies at page scope.** A row or section whose existence depends on an
  unanswered source reserves its eventual silhouette. It may collapse once the
  source is authoritatively ready and says the row is not applicable; staggered
  answers must not repeatedly reshape the page.
- **Subscribe = read.** A fresh subscription already requests and delivers that
  list's authoritative snapshot for the connect episode. Never issue an explicit
  list command for the same reducer slot in parallel, and use one canonical
  request shape for that slot.
- **A surface preloads the chunk its primary action mounts.** Route chunks may
  load on navigation; a chunk mounted by the surface's main action is fetched
  while that surface is idle. New session preloads the transcript renderer, so
  first send cannot pass through a whole-pane lazy fallback.

## R6 in practice (Task-390)

**`aria-busy` goes on the container that survives the swap — never on the region
that announces.** A busy live region is the documented licence for assistive
tech to hold that region's output back until busy clears, and a loading region
clears by UNMOUNTING when the data lands, so a `role="status"` element marked
busy can be deferred into silence: exactly the announcement R6 exists to
guarantee. So `PaneLoading`, `RefreshIndicator` and every hand-built skeleton
region announce and are not busy; `loadingStateAudit.test.ts` fails a
`role="status"` element that carries `aria-busy` at all.

The flag belongs on the persistent element whose CONTENT is being replaced,
where it really does go true→false in place: `Inspector`'s scrolling body while
its object loads, `QuickRow`'s listbox through its `busy` prop (both branches
render a `QuickRow`, so the same DOM node flips), and the expanded body
`<div id={bodyId}>` in `ToolCallBlock`/`ThinkingBlock`, which stays mounted
while `useNearViewport` withholds its children and clears the flag when they
land — the placeholder inside it is a bare height spacer, not the busy element.
Where a surface has no such container — the placeholder IS the whole swapped
subtree — the announcement is the affordance and nothing is marked busy. A
status LINE that adds itself to a surface rather than standing in for it — the
merge dialog's phase, "Complete Slack authorization in the opened tab", the
syntax-highlighter pill — is announced and not busy either.

**One announcement per region.** Spinners are `aria-hidden`, so a control or
region that shows one must say what it means in text: an sr-only line, a label,
or the button's `aria-label` (`WorkflowRunCard`'s step buttons). Nesting a
labelled indicator inside another labelled region announces twice; put the label
on the outer one.

**The transcript is the documented exception to `role="status"`.** Streaming
rows — `ThinkingBlock`, `ToolCallBlock`, `ProgressIndicator` — announce through
the content they stream, so their spinners sit in plain headers with the status
in ordinary text ("Running tool call:", "Thinking… 4s"). A live region on a line
that changes with every step of a turn would talk over the transcript itself.

**Motion means CSS animations too.** Tailwind animation classes are written
`motion-safe:`, and the audit enforces that for every file. The hand-written
animations in `index.css` are outside what a class-name scan can see, so they
are review's job: the two that mean "still working" — `.shimmer` on text an
agent is producing (a progress label or pending session title) and the streaming
`.caret` — are stilled in a `prefers-reduced-motion: reduce` block, staying
legible and drawn while they stop moving, and Task-391 gave `.chat-dock-panel`'s
120ms entrance the same block. It is not a loading state; the promise is the
same one either way, and it cost three lines to keep rather than a second audit
pattern over `.css`.

## Errors: inline or toast

Inline `ErrorNote` when the act that failed has a home on screen — the pane it
loaded, the list it belongs to, the control that started it. A toast only for
fire-and-forget acts whose surface is already gone by the time the answer
arrives. A failure that has a home and is shown as a toast is a failure the user
cannot retry from.

## Vocabulary

`src/components/common/load.tsx` is the only module allowed to spin, pulse, or
draw a dashed box:

- `Spinner` — the one glyph (`LoaderCircle`), sizes `xs`/`sm`/`md`/`lg` =
  10/13/16/22px (`xs` fits inside `text-micro` chrome such as a card's state
  badge), `motion-safe:animate-spin`, `aria-hidden`. `variant="ring"` draws the
  transcript's bordered circle at the same tokens instead of the glyph: one
  element, no icon module, for the streaming tool-call and thinking headers that
  render on every token. Task-390 folded that visual in rather than exempting
  those two files from the audit — the ring is a variant of the app's spinner,
  not a second spinner.
- `PaneLoading` — centered spinner + label, `role="status"`, for whole-pane
  first loads. Announcing and NOT busy; see R6 above for why the two do not go
  on the same element.
- `Skeleton` — `motion-safe:animate-pulse` rounded `bg-raised` block; the caller
  gives it the dimensions of what it stands in for.
- `RefreshIndicator` — small header/corner spinner with an sr-only label and
  `role="status"`, for R2.
- `EmptyBox` — the dashed-border empty state with an optional action. It is also
  the one box for a region with no object to show at all — a section index with
  nothing selected, an id that does not resolve — which is not R1's
  authoritatively-zero list; the rule still governs when a LIST may claim zero.
  Three variants, because an empty state has to fit where the content would
  have: `box` (default) is the full-width centred card, `inline` the same box at
  a caption's height for an empty section inside a panel (`Composer`'s "No child
  sessions yet."), and `item` an empty state that is a ROW in a horizontal
  scroller — `NewSessionQuickStart`'s "No worktrees", which carries the snapping
  and two-line geometry of the worktree cards beside it, since a `box`'s height
  in that row would resize the whole scroller.
- `ErrorNote` — danger-toned inline box with an optional retry.
- `ProgressIndicator` — the transcript's turn-progress line: `Spinner` plus a
  `.shimmer` label. The shimmer is the app's one text treatment for “an agent is
  still producing this text”; `SessionTitleText` uses it for the naming agent's
  pending title too. It lives in `index.css` because it clips a moving gradient
  to the glyphs, which no primitive can express.
- `DASHED_EDGE` and `LIVE_PULSE` — the two class tokens for treatments that look
  like a loading state and are not. See "What is not a loading state" below.
- `ui/Button`'s `busy` prop — spinner + `disabled` + `aria-busy`, for R5;
  `common/GhostIconButton`'s `busy` is the same thing for an inline icon action.
  A control with its own geometry (a transcript card's pill, a panel row, a
  dialog's confirm) does it by hand with `Spinner` — the three parts are the
  contract, not the component.

State plumbing:

- `src/lib/loadState.ts` — the `LoadState<T>` union and pure helpers
  (`beginLoad`, `failFrom`, `isEmpty`, `fromNullable`, `mapData`). Framework-
  free, so it is equally usable from a subscription-fed surface and a fetch.
- `src/hooks/useFetchState.ts` — the one keyed fetch effect, replacing the
  hand-rolled `let cancelled = false` copies. Key change → `loading` with data
  dropped (R3, applied during render so there is no stale frame); `reload()` on
  the same key → `refreshing` with data kept, kept on error too (R2).

## What is not a loading state

Three treatments in this app look like one and mean something else. They kept
their look and lost their exemption in Phase 6: `common/load.tsx` exports them
as named class tokens, so the vocabulary still has one owner and a reviewer sees
the import. Reach for them ONLY for the meanings listed here.

- `LIVE_PULSE` (`motion-safe:animate-pulse`) — something is LIVE, not loading:
  the dictation `Mic` while the microphone is opening. Nothing has been asked
  for in either, so a spinner would pose a question the user cannot answer.
  Waiting for an ANSWER is `Spinner`; standing in for content that has not
  arrived is `Skeleton`.
- `DASHED_EDGE` (`border-dashed`) — a dashed edge that is not an empty state,
  which in this app is exactly three things: a FILLABLE SLOT
  (`NewSessionQuickStart`'s "New worktree" and "More…"), a PROVISIONAL object
  (the queued-prompt bubble in `MessageList` and `PeerPromptCard`), and an
  UNRESOLVED reference (`ProjectBadge`'s unknown project). A region with nothing
  in it is none of those: it uses `EmptyBox`.
- The transcript's own status lines, which announce through the content they
  stream rather than through `role="status"` — see R6 above.

## The app shell

The shell's own loads are pane loads (Task-391), so the first thing the app ever
draws is the vocabulary everything after it uses:

- `LoadingShell` — the boot screen, `PaneLoading` inside the full viewport.
  "Connecting…" until the socket answers, "Loading session…" once it has, which
  is the only difference the user can act on before hydration.
- `LazySurfaceFallback` — every `Suspense` fallback for a lazy route chunk, also
  `PaneLoading`. It was a bare centred word; a chunk arriving is a pane load,
  and R4 has nothing to reserve here because WHICH surface is opening is
  precisely what has not loaded.
- `PendingSessionPanel` — a `role="status"` card that names the session it is
  opening, with `Skeleton` rows for the transcript's first lines. The card is
  the R4 silhouette: the shell stays still while the transcript catches up. It
  lives in `components/SessionStage.tsx` beside `SessionRefreshMark`, the chat
  stage's other piece of chrome; see "The chat stage" below for which of the two
  a given arrival gets.
- `UnavailableSessionPanel` — what stands in for `PendingSessionPanel` when the
  server said the route's session cannot be opened at all (an `error` with
  `sessionUnavailable`, kept in `UIState.unopenableSessions`). The same card
  frame, so the shell does not move, but an `ErrorNote` with the reason and no
  spinner or skeletons: nothing is on its way, and an error region is not a
  loading region.
- `AppStatus` — the app status slot, which carries both the server restart and
  the socket dropping after hydration. The app once said neither out loud: the
  composer disabled itself and every other surface went on showing data that had
  stopped arriving. Static `RefreshCw` while a restart is QUEUED (a state),
  `Spinner` while it runs or while the socket is down (a wait for an answer).
  Deliberately not a banner (it would push every laid-out pane around on each
  blip) and not a toast (a toast is fire-and-forget; these last until they are
  over). The connection half waits out a grace period before drawing at all — a
  cached shell is hydrated but not live for a few hundred ms, and a dropped
  socket usually returns inside one retry, so an indicator without the delay
  would be a flash on every cold start instead of a signal; a restart has no
  such wait, being a decision the server has already taken, and it outranks the
  disconnect it causes. It says "Connecting…" for a shell that has never been
  live and "Reconnecting…" once the app has been live. Retained data stays on
  screen and R2 applies: it marks the whole app as refreshing, it does not blank
  it. The grace period lives in a module store (`lib/appStatus.ts`) rather than
  in either placement, because the two do not live and die together: the header
  bar exists only on wide layouts, so crossing the breakpoint unmounts one and
  mounts the other, and a component-owned timer would restart there — blanking
  an announcement that had been up for minutes, which reads as the app
  recovering. The wait belongs to the connection, not to whichever shell is
  drawing it. The floating placement sits in the z-50 band of `ui-shell.md`'s
  layer scale, the one `DiffWorkerProvider`'s visually identical pill already
  uses. What may appear there at all is `docs/messaging.md`'s to say, not this
  document's.

## The chat stage (Task-435)

A transcript is the one surface where "what was here last time" is tempting
enough to have been drawn under the wrong id for months. The rule is R3 with a
single, narrow exception:

- **Cached first paint is earned only where nothing else could be on screen.** A
  reload or a deep link landing on a session URL, and the reconnect of that same
  view. There, the cached transcript paints in the first frame and
  `SessionRefreshMark` says a fresher one is coming.
- **In-app navigation clears the stage.** Chat A → the list → chat B renders
  `PendingSessionPanel` until B's snapshot lands, and so does coming BACK to A:
  the app has been live in between, so the stored copy is precisely the thing we
  know is behind. `lib/sessionPreviewStore.ts` is the ONE place that rule lives,
  in two halves: `spendBootRouteIdentity` is a ONE-WAY latch that burns the boot
  route the first time the app navigates away from it (repeating the same
  identity — a reconnect, a re-parse — keeps it), and `previewForSessionRoute`
  hands out the cached transcript only while that identity is still alive and
  still names this route. The latch is what makes the return to A a switch, and
  it is not optional politeness: adopting A's preview while the runtime still
  holds B makes `appendLiveMessagesAfterPreview` miss its anchor and return B's
  live rows wholesale, which paints the OTHER conversation under A's URL.
- **One narration.** The stage shows either the placeholder or the cached
  transcript plus the refresh mark, never both, and a streaming row narrates
  itself (see R6's transcript exception), so the mark stands down for it. The
  mark reads at body size on full contrast: it is the only thing telling the
  reader that what they see is not current.

**A session that does not exist yet gets the shell anyway (Task-448).** The
first prompt sent from the new-session surface starts a server-side bootstrap —
a worktree checkout, the engine, the prompt — that the user watches with nothing
to look at but their own prompt. So the staging surface renders as if the
session already existed: the header carries the STAGED identity (provisional
title, model, worktree/project, and no fingerprint for an id that does not
exist), which is also why a phone gets that header here while an idle
new-session screen has none. One narration says what the bootstrap is doing, and
the worktree-provisioning card outranks it — that card is the same source's
narration, with its own phases and its own Retry. A failed bootstrap KEEPS the
prompt: dropping it back to an empty page loses text the user cannot recover, so
the blocker and the retry appear beside it (and the app-wide error banner stands
down, being the same sentence where it cannot be acted on). A send that carries
no prompt of its own — a review handoff — has nothing to keep, so its failure
sits above the staging surface it came from instead.

Both halves of that failure are one claim, and both need the same evidence.
Saying "could not start the session" is also offering to run the send again, and
running it again once its session EXISTS creates a second one; the error channel
cannot prove which send it belongs to (the server's real first-send blockers are
plain errors with no id to correlate), so the claim is gated on the session not
existing rather than on the error. Arming a send also retires the previous
outcome — a dismissed banner leaves the error set, and a prompt-less send has
nothing else that would clear it.

The handoff to the real session is R2/R3's tightest case: the created session's
durable echo settles the optimistic row one commit before the URL follows it
there, so the shell adopts the live rows instead of blanking for a frame. It
adopts them only on positive evidence that the session in view is the one this
send created — absent from the set of session ids recorded when the send left —
never merely because it is not the session we started from. Any pre-existing
conversation can drift into view mid-bootstrap (a late `loadSession` answer, a
background session settling, a server-initiated view switch), and
`useSessionRouting` already refuses to move the URL onto those; the transcript
has to refuse the same ones, from the same evidence, or it paints one
conversation under another one's URL. Where the evidence is missing the surface
shows what it has and adopts nothing. `lib/newSessionShell.ts` owns these
decisions.

**Two caches, two jobs, and neither is a source of truth.** The server's
snapshot is.

- `lib/sessionPreviewStore.ts` (localStorage, 8 sessions × the last 60 sanitized
  `DisplayMessage`s plus the session shell and `contextInfo`) exists to be
  SYNCHRONOUS. It is read once, for the boot route, because that is the only
  read that can beat the first paint — and it is a projection of what the stage
  draws, not of the wire.
- `lib/sessionTimelineCache.ts` (IndexedDB, 8 sessions × the full append-only
  `ClientTimelineEntry` prefix) exists to make the ANSWER small: its descriptor
  travels on the connection URL and on every `loadSession`, and the server
  replies with the tail after the matched prefix. A missing or corrupt prefix
  reattaches at offset zero — never a partial transcript. A range that
  reconstructs into ZERO display rows counts as corrupt (Task-450): it is
  discarded and re-requested rather than painted, because a blank stage on a
  session that has entries is indistinguishable from an empty session. The stage
  keeps one way back regardless — a live windowed transcript with older entries
  mounts `MessageList` even with no rows, so "Load earlier messages" is
  reachable instead of the reader landing on the new-session surface.

Because the descriptor has to be ON those two requests, neither can be sent
before its read answers. What is overlapped is when the read STARTS: the boot
read starts during the first render (so it runs alongside hydration instead of
after it) and a tap on a session row warms the read for the session it opens, so
the `loadSession` that follows the navigation finds it in memory. Both go
through one in-flight map, so a warm and a load read once.

## Staleness beyond loading

`common/UsageCycleMeters.tsx` is the exemplar for data that is present but AGED,
which is a different axis from the five states: it holds the slot's height in
every state, shimmers only while a fetch is actually running, dims with a `⟳`
when its snapshot is stale, and says WHY a row has no meter (`no plan limits`,
`sign in`) instead of drawing an empty one. A surface whose data has a freshness
window should follow it rather than inventing a second staleness language.
Contract: `docs/usage.md`.

## Enforcement

`src/loadingStateAudit.test.ts` forbids `animate-spin`, `animate-pulse`,
`LoaderCircle`/`Loader2` and `border-dashed` outside `common/load.tsx`, and —
for every file — an animation class without `motion-safe:`. It also fails a
`role="status"`/`aria-live` element that carries `aria-busy`, which is the R6
trap that silences an announcement.

**There is no allowlist.** The audit landed in Phase 1 with a frozen census of
the files that predated the model, because the migration was phased and a rule
that only arrives at the end protects nothing in between; Phase 6 emptied and
deleted it. This is now zero-bypass like `typographyAudit.test.ts`: a new bypass
is a bug in the change that introduced it, not a line to add to a list. A
treatment that genuinely is not a loading state gets a named token in
`common/load.tsx` and a bullet in "What is not a loading state" above — that is
the only way an exception exists, and it is one an owner still holds.

`RefreshCw` stays importable as a static refresh icon; spinning it is caught by
the class rule. `SessionDeliveryMark`'s `creating` mark, the last still spinner
glyph in the app, became a real `Spinner` in Phase 6: it is the one delivery
state that is an act under way, and a stopped spinner is the one thing a mark
for work in progress must not look like.
