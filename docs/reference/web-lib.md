# Web client library — implementation reference

Relocated from `app/web/src/lib/CLAUDE.md` (Task-274) so it stops costing agent
context on every visit. This is a descriptive snapshot of what the modules in
that subtree own; the rules an agent must not violate stay in that folder's
`CLAUDE.md`. Correct or delete a section here when the code moves on. Relative
paths in the body are relative to the original subtree.

## Purpose

Browser-side helper modules for API/socket origins, model filtering, backlog
tree transforms, calendar API calls, clipboard/toasts, client IDs, and session
capability logic.

## Module ownership

- `socket.ts` owns the reconnecting WebSocket wrapper.
- `markdownFrontmatter.ts` owns `splitMarkdownFrontmatter`: a Markdown file's
  leading frontmatter projected for a header (title, tags, label/value fields,
  or the raw block when the shared YAML subset cannot read it) and the body with
  the frontmatter's lines blanked so source line numbers survive.
- `loadState.ts` owns the `LoadState<T>` union
  (`idle | loading | ready | refreshing | error`, the error retaining the last
  good data) and its pure helpers: `beginLoad` keeps data across a refetch of
  the same query, `failFrom` keeps it across a failure, `isEmpty` answers the
  empty question only for data that actually arrived, and `fromNullable` bridges
  the `null`-means-not-loaded subscription lists. Framework-free per this
  folder's contract, so a subscription-fed surface and a fetch-fed one speak the
  same five states. Contract: `app/web/docs/loading-states.md`.
- `appBuild.ts` reads the `__ASSISTANT_BUILD__` define `vite.config.ts` bakes in
  — which build of the browser bundle this is. A loaded bundle has nothing left
  to ask, so the answer is a property of the build rather than of the page; the
  server's and the shell's are separate answers (`ready.serverBuild`,
  `nativeShell.nativeShellBuild`) shown beside it in Settings → About.
- `nativeShell.ts` also answers `nativeShellBuild()` from `shell_info`: the
  installed binary's own version and commit, null in a browser.
- `webBuild.ts` owns production deployment detection: it records the socket's
  first-frame `webBuildId` in local storage and reports a change exactly once,
  so the hook can reload an already-open pre-deploy document before its old JS
  consumes new server state.
- `sessionRoutes.ts` owns canonical session path parsing/building shared by
  routing, socket startup, and components, including the one in-session address:
  `messageHash`/`entryIdFromHash` for the `#m-<entryId>` fragment naming a
  single message (`../../app/web/docs/ui-shell.md`).
- `rowLink.ts` owns the ONE click rule for a link drawn inside a clickable row
  (`followRowLink`): stop the click so the row underneath does not also act on
  it, leave every modifier click to the browser so a new tab still works, and
  otherwise `preventDefault` and hand the path to the host. It is a pure
  function over the fields a `MouseEvent` already carries rather than a React
  handler, so the Backlog row's five links, its title anchor and `TaskIdBadge`
  share one implementation and it is tested DOM-free (`rowLink.test.ts`).
  Spelled out per link, this is the rule that gets fixed in one copy and not the
  others.
- `serverOrigin.ts` owns HTTP/WebSocket origin and auth-token header/query
  helpers.
- `servedFiles.ts` classifies the URLs the app serves file bytes from
  (`/api/files/<absolute path>`, `/api/session-artifacts/…`) into the kind a
  card or the viewer renders, and resolves a document's own relative references
  against its directory. Framework-free, so a link and an image ask the same
  question. `directFiles.ts` is its request half: bounded metadata and text
  reads, and the `POST /api/file-grants` mint a sandboxed HTML document is
  served under (`docs/served-files.md`).
- Backlog tree modules own pure task tree shaping and ordering logic.
- `describeAnchor.ts` turns a browser `Range` into the shared `SelectorBundle`
  (`@assistant/shared/comments`): a DOM walk resolving a range boundary to a
  character offset in the root's text content, plus the pure
  `bundleFromOffsets(documentText, start, end)` reducer that slices the raw
  quote, its 32-character prefix/suffix and the position. Only the reducer is
  unit-tested here (these tests run DOM-free); the walk is covered at component
  level. The caller's contract is that the root renders `documentText` 1:1.
  Contract: `docs/comments.md`.
- `documentCommentAnchor.ts` gives a document comment its two coordinates: the
  SOURCE lines of a selected range (`sourceLinesForRange` — Markdown blocks'
  `data-source-line-*`, or exact lines inside a `CodeBlock` window from its
  `data-code-first-line`) and the rendered `Range` a pending quote paints at
  (`rangeForPendingQuote`: stored offsets when they still hold the quote, else
  its first occurrence via `quoteRangeMath.ts`). No re-anchoring.
- `pendingCommentStore.ts` is the browser-local home of every pending comment: a
  composer's OUTBOX beside its text draft and a document's TRAY. Each comment is
  its own `localStorage` record (`<list>#<id>`), so concurrent tabs cannot
  overwrite each other's appends; lists are read by enumeration with a signature
  cache for `useSyncExternalStore`. `moveTrayToOutbox` is the one send,
  `updatePendingComment` the conditional edit. `chatCommentPrompt.ts` owns their
  types and the prompt prose they are sent as; `textRanges.ts` the
  offset↔`Range` and point↔caret helpers the transcript and document viewers
  share.
- `transcriptKeys.ts` owns the identity keys for the two transcript props that
  are rebuilt far more often than their content changes: `paObjectReferenceKey`
  (uri + title + existence; the remaining `PaObjectLinkResolution` fields are
  derived from the uri and so cannot vary independently) and
  `sessionReferenceKey` (id + title — all a rendered session autolink shows).
  Both exist because widening one fails invisibly: everything still renders,
  just slowly, since a fresh array breaks the memoized message rows and
  `Markdown` with them. Both are also order-insensitive, because both are built
  from the session list, which is sorted by `updatedAt` and rebroadcast several
  times a second while any agent runs — an order-sensitive key called every one
  of those re-sorts a content change and re-rendered the whole open transcript
  for it. Consumers memoize on these keys and therefore hand on an OLDER array,
  in an older order, whose unkeyed fields may have moved — so a new reader of
  either prop must either restrict itself to the keyed fields (read as a lookup,
  not a sequence) or widen the key deliberately. Tested in
  `transcriptKeys.test.ts`, which is the regression guard for exactly that. Both
  are keyed over a NARROWED list, not the app's whole inventory of linkable
  objects: `App.tsx` keeps only the `pa://` references the rendered text
  mentions (`objectLinkUrisToResolve`, matched on `paObjectKey` so normalization
  cannot drop one) and `MessageList.tsx` only the sessions the transcript names
  (`mentionedSessionIdsIn`). Without that, naming ONE session was a content
  change — and the server names every session from its first prompt, so starting
  a session anywhere re-rendered every message of every open transcript. Both
  scans use the same extractor the renderer resolves with, so a link that will
  be looked up is a link that survives the filter; the second half of
  `transcriptRedrawScenario.test.tsx`'s "link references" pair is what keeps a
  too-eager filter from passing as a win.
- `transcriptMentions.ts` owns that scan for both of them: `markdownTextsOf`
  (every string a transcript row hands to `Markdown` WITH reference props — a
  text block and a compaction card's summary today; a peer-prompt card gets no
  references and so needs no mention), and the two projections over it,
  `mentionedSessionIds` and `mentionedPaUris`. It is one module because the two
  callers must agree, and because the scan became load-bearing when the
  references were narrowed against it: while it only chose which links to ASK
  the server about, a field it forgot cost nothing (the local inventory still
  had the title); now a forgotten field is a link that renders without one.
  `transcriptMentions.test.ts` asserts each Markdown-bearing field by name, so
  adding a rendered field without adding it here fails.
- `broadcastTopics.ts` owns `topicsForSurface`, the one rule for which
  `BroadcastTopic`s a browser declares: the main pane's route always, the
  selected sidebar section only while its browser is visible. Pure and tested
  because the failure is silent — a section that stays selected after navigating
  away would keep a quiet surface subscribed to the heaviest broadcasts in the
  app. `usage` rides only on the two surfaces that meter accounts (the
  new-session route and the Usage page): subscribing is what makes the server
  revalidate at all, so no other surface may carry it (`docs/usage.md`).
  `skills` is the same shape and stricter: only the RENDERED settings section
  counts (`settingsSection === "skills"`), never the settings browser listing
  the entry, because a subscribe rescans the library working tree on the server.
  `background` is held by its route, by the inspector section
  (`backgroundInspectorSubscribes`) and by the composer's background ledge only
  while it is OPEN (`backgroundLedgeOpen`): the ledge's resting line reads the
  session row's own projection, so a collapsed ledge costs nothing.
- `perfStats.ts` owns the dev performance counters behind
  `components/PerfHud.tsx`: a rolling one-second window of inbound server
  messages (type + UTF-8 WIRE BYTES + `JSON.parse` time, recorded in `socket.ts`
  because that is the only place the raw frame exists; the byte count walks the
  frame, so it runs only while the HUD is on), of React commits per instrumented
  component (`usePerfRenderCount`, called during render — discarded work still
  cost what this measures; `recordRender` also takes a duration, which
  `App.tsx`'s `Profiler` around the transcript supplies), and the latest session
  load as four marks (`recordSessionLoadMark`: request in `loadSession`,
  snapshot parsed in `socket.ts`, transcript committed and next paint from an
  effect in `useAssistant`, accepted in order and once). Recording is a no-op
  until the HUD is toggled on, so production pays one boolean per message. The
  render counter lives HERE rather than with the HUD so an instrumented
  component does not pull the overlay into its chunk.
- `idleWriter.ts` owns `createIdleWriter`, the coalescing idle-deferred writer
  behind best-effort browser caches (today: the app shell cache in
  `hooks/useAssistant.ts`). It writes only the LAST value of a burst, after a
  quiet period, inside a `requestIdleCallback`, with a ceiling so a sustained
  stream still gets written; `flush()` is the synchronous path for
  `pagehide`/hidden, which is the only moment such a write is urgent. Timers,
  idle scheduling, and the clock are one injected `IdleWriterEnv` so the
  deferral rules are tested against a virtual clock rather than by waiting.
- `transcriptWindow.ts` owns `transcriptWindowStart`, the one rule behind the
  transcript's render window (`components/MessageList.tsx`): the newest `limit`
  rows are mounted, and the window's floor is the ROW it currently starts at
  rather than that row's index — so arriving messages extend it at the tail
  instead of sliding it out from under someone reading history, and a reconnect
  preview resolving into the full transcript (which renumbers every row)
  re-anchors instead of mounting the whole session. An unknown anchor degrades
  to the plain last-`limit` window. Tested in `transcriptWindow.test.ts`,
  because both failure modes are silent: one yanks the scroll position, the
  other quietly un-does the window.
- `transcriptScroll.ts` owns the transcript's scroll POLICY and its per-session
  reading-position memory; the DOM half is `hooks/useTranscriptScroll.ts`.
  Everything here is numbers in, decisions out, because web tests in this
  package run without a DOM — so the rules are testable and the container work
  is not. `nextScrollMode` is the whole policy as one machine over three modes:
  `bottom` (follow new content), `anchor` (hold a remembered row while the
  layout settles) and `free` (the reader owns the position — of SCROLLING; the
  hook still holds their row against content that appears above it). Three of
  its rules are the reported bugs' fixes and must not be weakened: a scroll that
  no reader input backs (`fromReaderInput`) but that arrived while the container
  was RESIZING (`duringLayoutShift`) changes NO mode — the browser writes the
  offset by itself in that window, while a phone submit closes the keyboard and
  collapses the composer and as every row scrolled into view for the first time
  replaces its `content-visibility` estimate, and reading either as the reader
  moving left the new turn's Thinking row under the bottom card and abandoned
  the restore "load earlier" had just started; a SUBMIT pins to the bottom
  regardless of where the reader was (the host bumps a token; it cannot be
  inferred from the rows, since an attachments-only prompt echoes no optimistic
  row), and opening a transcript with nothing remembered — or with a remembered
  position whose anchor row is unusable — lands at the END, since the newest
  message is what a conversation is opened for. `positionToRemember` is the
  other half of that contract: it records NOTHING while a restore is in flight,
  or the memory fills up with the intermediate positions the restore itself
  produced. The memory is browser-local (`assistant.transcriptScroll.v1`, newest
  30 sessions, one entry per session, `lib/idleWriter.ts` for the write so a
  scroll can propose a position per frame and still cost one `setItem`),
  deliberately last-write-wins across tabs, and hands out
  `transcriptScrollMemory()` as the app's single instance plus
  `forgetTranscriptScrollPosition` for a deleted session. A non-bottom entry
  also carries `tailKey`, the ids of the last two projected rows. When that key
  changes while the reader remains in `free` mode, `syncAfterRender` immediately
  re-records the still-visible anchor against the committed tail — including the
  `live` tail and its later settled replacement — so turns completing below the
  reader do not discard their position. Restoration is rejected only when the
  transcript changed after the last version this page observed (for example, a
  turn that settled after the tab closed), because replaying an unverified
  browser-local anchor is the recurring jump this guard prevents. That safe
  fallback deliberately loses the old reading position and opens at the end. Two
  ids distinguish consecutive streaming turns whose transient tail id is always
  `live`; legacy anchors without a key also fall back to the end once rather
  than making a stale jump recur. An anchor is
  `{messageId, offset, rowsFromEnd}`: absolute offsets are meaningless here,
  because off iOS a `content-visibility: auto` row that has never been measured
  is only worth an estimate (`--transcript-row-estimate`, re-measured by the
  hook), and `rowsFromEnd` is what lets a restore widen the render window before
  the row can exist at all. The ROW-ESTIMATE rules live here for the same reason
  as the mode machine — they are arithmetic, and they decide whether a
  measurement is worse than the constant it replaces: `rowHeightSample` (the
  MEDIAN of the rows on screen, so one screenshot card cannot outvote five short
  rows, clamped 80–800px because a screenful can BE one freak row — measured, a
  117px row beside a 5789px one — and refusing a sample under
  `ROW_ESTIMATE_SAMPLE` rows), `nextRowEstimate` (a sample MOVES the estimate by
  `ROW_ESTIMATE_WEIGHT` and never replaces it, so it converges over the reader's
  stops rather than being owned by one screenful) and `shouldPublishRowEstimate`
  (`ROW_ESTIMATE_CHANGE` against the PUBLISHED placeholder, because gating the
  estimate on it as well stalls it inside the deadband: a true median of 300
  could then never leave 240, and one of 700 froze 24% short). Tested in
  `transcriptScroll.test.ts`, including that a burst of scroll samples writes
  once and that the estimate converges.
- `listScroll.ts` owns the same idea for the app's LISTS: where the reader was
  in a browser, and how to put them back. Pure so the rules are readable and
  testable on their own (`hooks/useListScroll.ts` is the DOM half, covered by a
  jsdom-opting test of its own), and a separate module from
  `transcriptScroll.ts` on purpose — a list neither follows new content at the
  bottom nor renders a windowed subset, so none of that machine applies. A
  remembered position is `{scrollTop, anchor?}` where the anchor is
  `{rowId, offset}`, the first row still visible at the top edge: sessions
  re-sort by activity and a Task can be filed while the reader is away, so a
  pixel offset alone would point at a different row than the one they left. The
  offset is kept anyway as the fallback for the cases an anchor cannot cover — a
  refiltered list, or a browser whose rows carry no `data-list-row-id`.
  `positionToRemember` returns null at the top (that is where every list opens,
  so storing it would only keep a stale entry alive) and for a container that is
  not laid out — a hidden or detached one measures as "at the top", which is how
  a good position gets overwritten on the way out. `canReach` is what makes a
  restore against a list that has not arrived yet (a fetched Knowledge tree, a
  Backlog subscription still answering) a RETRY rather than a wrong answer
  clamped to the end. The memory is browser-local (`assistant.listScroll.v1`,
  newest 24 lists, one entry per key, `lib/idleWriter.ts` for the write),
  last-write-wins across tabs, and hands out `listScrollMemory()` as the app's
  single instance — module level, because on a phone the whole browser is
  unmounted while any object screen is open. Tested in `listScroll.test.ts`.
- `sessionRows.ts` owns the sidebar session row's display/identity pair:
  `relativeTime` (the compact row timestamp) and `sessionRowKey` +
  `sameSessionRowProps`, the content key and `memo` comparator behind
  `components/SessionRow.tsx`. Same contract as `transcriptKeys.ts` and the same
  invisible failure: the session list is rebroadcast up to ~4x/second with
  brand-new row objects, so the rows can only memoize on content, and a row that
  reads a field the key omits silently stops updating. The RENDERED relative
  timestamp is in the key rather than `updatedAt`, so a row whose label ticks
  over re-renders. It also owns `backlogSessionsKey`, the same trick for the
  facts a Backlog ROW reads off the list — which sessions exist, which stream,
  which are archived, which worktree each runs in — so ~220 Task rows do not
  rebuild for a title or unread flag moving. That one is a correctness key as
  much as a performance one: while it held running ids ALONE, a session deleted
  or archived while idle never invalidated the Backlog's gated copy, and a Task
  row went on offering to open it. `updatedAt` stays out by design (it moves on
  every streamed token); the single consumer that reads it is documented at both
  ends. Leaving the FIELD out was only half of that, though, and the ORDER was
  the other half: the list is sorted by `updatedAt`, so every token re-sorts it,
  and a key that read the rows in list order changed for exactly the broadcasts
  it exists to absorb — which cost the Backlog a full re-render of every Task
  row several times a second. The tokens are sorted, and the Backlog reads these
  as a `sessionById` lookup, so the order is not information.
  `sameSessionRowProps` compares every OTHER prop by identity generically
  (enumerated, not listed) so a new prop is covered by default; row callbacks
  must therefore take the session id instead of closing over the row. Tested in
  `sessionRows.test.ts`.
- `backlogFocus.ts` owns the pure projection behind the Backlog's **Focus**
  view: `effectiveFocusDate`, `focusBucketFor` (a Task's bucket: `review` when
  an agent has suggested a status for it — finished, or handed back unfinished —
  else its when-bucket relative to an explicit `today` —
  overdue/today/tomorrow/this-week/later/unscheduled). "Suggested" means
  `backlogTree.ts`'s `pendingStatusSuggestion`, not the raw wire field: a
  suggestion whose `to` already equals the Task's status was ANSWERED (the
  `userRequestedStatus` path records the claim on a Task it also moved), so it
  is provenance — it neither buckets here nor lights the amber glyph anywhere
  else. A pending suggestion outranks every date, because answering it is a
  yes/no and burying it is how a Task ends up neither done nor being worked on;
  both kinds share the bucket (they are the same question) and inside it the
  OLDEST suggestion leads (priority does not override age there — the point is
  what has been ignored longest), `compareFocusTasks`, `buildFocusBuckets`
  (ordered, EMPTY buckets dropped) and the labels
  `focusDateLabel`/`dueLabel`/`scheduledLabel`. A Task carries TWO dates that
  mean different things — `scheduledFor` is the day you (or an agent planning
  for you) chose to work on it, `dueDate` is what the outside world needs — and
  `effectiveFocusDate` buckets on whichever comes FIRST. That is the only rule
  that hides neither: taking the plan alone would let a near deadline sit
  silently under "Later", and taking the deadline alone would make planning your
  day change nothing on screen. The labels keep the two apart in words as well —
  a missed DEADLINE is "3d late", a slipped plan is only "3d ago" — and
  `scheduledLabel` returns null when the plan equals the deadline, so one fact
  is never printed twice. Grouping is on TIME and sorting on priority happens
  only INSIDE a group: a `high` Task due next month must not outrank an ordinary
  one that is late today — the deadline is a fact and the priority an opinion.
  The list it builds is FLAT, so a subtask sits in its own bucket rather than
  under a parent that may fall in another one. `today` is a parameter rather
  than a call to the clock, so the rules are testable without freezing time; the
  labels use fixed weekday/month tables rather than `Intl` (uniform three
  characters in a tight metadata line, and immune to an ICU version changing
  "Sep" to "Sept"). The Backlog's manual `sortOrder` is deliberately NOT a
  tiebreak here — a hand-arranged order is what the tree view is for, and
  honouring it would make two rows swap for a reason this list gives no way to
  see. Tested in `backlogFocus.test.ts`.
- `backlogTree.ts` owns the Backlog tree's ORDER, in `compareTaskOrder` and the
  `flattenTasks`/`orderTasks` pair every tree surface goes through (the project
  layer and the drag adapters in `backlogTreeModel.ts` included, so there is one
  answer). Manual `sortOrder` decides it within a sibling group, and the server
  gives every Task one as it JOINS that group (`taskStore.nextSortOrder`), so a
  row's place is settled when it arrives and only a drag moves it afterwards.
  Nothing MUTABLE may break a tie: it falls back to `createdAt`, then the id.
  `updatedAt` used to, and that made a row jump whenever the Task was worked on
  — a status cycle, a plan, a project assignment — which is precisely what the
  hand-arranged view exists not to do. A tie is now only a LEGACY row (created
  before positions were assigned on arrival, and ordered above the arranged
  ones) or a position a caller stated itself through `task_manage`. Tested in
  `backlogTree.test.ts`.
- `backlogTree.ts` also owns `acceptStatusSuggestionSave`, the ONE save that
  accepts a suggestion. Both surfaces that answer one — the Focus row
  (`useBacklog.ts`) and the transcript's `TaskManageToolCard` — build the
  request here, because "confirming in chat produces the same state as
  confirming in Focus" is otherwise two literals that drift. It is an ordinary
  user save (that is what makes the server clear the claim) and clears the
  suggestion explicitly, since the `userRequestedStatus` path leaves one whose
  answer changes no status. It carries NO title: the card's copy is as old as
  the mutation that recorded the suggestion, so echoing it back would rename a
  Task renamed since — `TaskSaveRequest.title` is optional on an update for
  this.
- `taskActivity.ts` owns what is HAPPENING to a Task, derived from its linked
  sessions instead of its status field: `isWorkingRef`, `isTaskWorking` and
  `taskStartSession` — the ONE session a row acts on (streaming first, otherwise
  the most recently touched). That last one only ever answers with a session the
  caller's map HOLDS and that is not archived: a row action must not lead
  nowhere (which is why the old hover `+` came off these rows) and must not
  change meaning because the user expanded the sidebar's archive, since a
  default broadcast omits archived rows until then. Its freshness is
  `sessionRows.ts`'s `backlogSessionsKey`, keyed on exactly the fields read here
  except the `updatedAt` tie-break — that one moves on every streamed token, so
  it stays out of the key and only ever picks between sessions that both exist.
  Status is the user's judgement and is routinely stale — agents start work and
  forget to move a Task to `doing` — so "working" is OBSERVED (a linked session
  is streaming) and needs no agent to be honest. The link FILTER is the whole
  point: only `origin: "task-start"` counts, never a bare `reference`, which is
  what a scanner, a search or a conversation that merely mentioned the Task
  produces. Counting those would light a Task up because something looked at it
  — precisely the false signal this exists to avoid. `taskWorktreeIds` applies
  that same rule to a LIST: the distinct worktrees a set of Tasks has work in,
  sorted. It is the Backlog's whole reach into worktree state — what App holds a
  git-status watch for and what may reach the memoized list as a dirty flag
  (`worktreeDirty.ts`) — so the watched set, the marked set and the re-render
  trigger are one set by construction. Tested in `taskActivity.test.ts`.
- `taskArchive.ts` owns WHICH rows an archive takes and WHEN it may happen
  (`docs/tasks.md`): `archiveSet` (the requested rows plus every done
  descendant, parent before child, already-archived rows dropped so Undo cannot
  restore an older archive), `archiveBlocker` (open subtasks anywhere in the
  subtree, an unanswered status suggestion, a session observed running) and the
  narrower `quickArchiveOffered` the swipe and the row button ask per row, plus
  `archiveBlockerMessage` for the refusal's wording. The blocker is asked of the
  whole SET, never of one id: a finished subtask's live session or unanswered
  claim refuses the epic that would carry it off, while an open subtask that is
  itself in the set strands nothing — so an epic archived together with its
  subtasks passes while its head alone does not. A blocker names the row that
  BLOCKED (`taskId`), which is routinely not the row the user clicked. The
  id/child indexes are cached in a `WeakMap` keyed on the `tasks` array, because
  the tree asks these questions per row per render (twice, for the swipe and the
  row button) and rebuilding two full-list Maps inside each call is quadratic at
  the ~220 rows this repo sizes for; the callers hand over a memoized array, so
  its identity is the cache key. `taskArchiveRun.ts` is the acting half: it runs
  an archive through those rules, answers with the ids it archived (or `null` on
  a refusal) so the swipe can animate the whole subtree out, shows the Undo
  receipt that names the Task and counts the subtasks that went with it (there
  is no confirmation prompt — archiving is reversible on the wire), and turns
  the open-subtasks refusal into the "Archive all N" whole-subtree offer. Both
  `useBacklog.ts` and `App.tsx`'s inspector wiring go through it, so the same
  act cannot mean two things. Tested in `taskArchive.test.ts` and
  `taskArchiveRun.test.ts`.
- `taskRowMeta.ts` owns the ONE derivation behind a Task row's second line —
  `buildTaskRowMeta` (the pending status claim, the observed "working", the
  session started from the Task and the worktree it runs in, that worktree's
  PR/CI as one `delivery` chip — with the `url` its chip LEADS to, the pull
  request or, for a branch that has none, the checks' own page — and whether it
  is `dirty`, the active/attention Workflow Run marker, the planned day, the
  deadline and whether it has passed, a non-default priority, the project, and
  the Task's age) plus `taskRowMetaEmpty` and `taskRowsHaveMeta`. Two views
  render it (`TaskRowBody` for the tree's `comfortable` rows and for Focus),
  because a row that says different things about the same Task depending on
  which view you are in is worse than a row that says less. Every field but
  `delivery`, `dirty`, and `workflow` is FREE — already inside the narrow
  `BacklogState` — and that is still the rule for anything new. The three that
  are not free are each PAID for by a slice sized so that its identity moves
  only when it says something new, never by widening `BacklogState`: `delivery`
  is not reducer state at all and arrives as an app-level projection
  (`hooks/useWorktreeHosting.ts`), `dirty` is the one boolean lifted out of
  `worktreeStatuses` by `worktreeDirty.ts`, and `workflow` comes from
  `workflowIndicator.ts`'s content-stable Map. The raw statuses record stays out
  of the slice — every watcher push rewrites it, which would re-render the
  memoized sidebar (the whole screen, on a phone) several times a second while
  an agent writes. The worktree is likewise an id and its chip a bare glyph: the
  worktree RECORDS, and so any branch name, are not in the slice either.
  `taskRowsHaveMeta(density, view)` is the shared answer to whether a surface's
  rows have that second line at all — only a `tight` TREE row has none, which
  since the sidebar went two-line leaves the composer's Task picker as the one
  surface that answers false — because both costs behind the line hang off it
  (`hostingSurfaces` polls for PR/CI, `Sidebar` watches git status) and both
  fail silently in either direction. `today` and `now` are parameters, so a row
  owns no clock. Tested in `taskRowMeta.test.ts`.
- `worktreeDirty.ts` owns that dirty slice: `dirtyWorktreeIds` (the dirty ids
  within a SCOPE, sorted, so the key answers on CONTENT rather than on whichever
  worktree reported first), `dirtyWorktreeKey` and the shared
  `NO_DIRTY_WORKTREES`. It is narrowed twice, and both halves are the point. By
  VALUE: a boolean per worktree and nothing more — the counts behind it
  (`4 files +120 −38`) move on every keystroke an agent makes. By SCOPE: it
  walks the caller's id list rather than the statuses record, so the worktree
  behind the conversation you have open — watched, and going dirty as you work
  in it — cannot repaint a Backlog where no row could have changed. That scope
  is `taskActivity.ts`'s `taskWorktreeIds`. An id that is absent, or scoped but
  unreported, is unknown as readily as it is committed, so a row states nothing
  rather than calling a branch clean. `hooks/useDirtyWorktrees.ts` turns it into
  a prop with a stable identity; tested in `worktreeDirty.test.ts`.
- `workflowIndicator.ts` is the equivalent framework-free slice for Workflow
  Runs: it folds active/paused summaries into `{ running, attention }` per Task,
  omits terminal-only history, and serializes sorted content to a compact
  identity key. `hooks/useWorkflowIndicators.ts` uses that key to preserve the
  Map object across broadcasts that move card details but no row indicator.
- `worktreeHosting.ts` owns that projection's SHAPE and its rules,
  framework-free and shared by every surface that states delivery.
  `HostingAttentionFacts` is exactly what the ladder consults (its `pr` narrowed
  to the `state` it reads, so a caller holding a pull request with no number or
  URL yet — a `/pr` card mid-creation — ranks on the same rungs instead of
  inventing either a second ladder or the missing fields), and `HostingFacts` is
  the worktree's fuller version of it. `hostingAttention` is the one precedence
  — a red check outranks a review, a review outranks the merge that ended the
  branch, a running check outranks the bare fact of an open PR — read by a Task
  row's chip, so the same pull request cannot be ranked two ways in two lists.
  Absent CI and a closed-unmerged PR both answer null: the ABSENT-IS-UNKNOWN
  rule, again, and "checks passed" on a branch nobody proposed is noise.
  `worktreeHostingKey` is the gate that decides whether a polled response said
  anything new — the whole payload, sorted by id, because every field is read by
  some surface and only the ORDER is incidental (the server fills the list from
  a concurrent worker pool). `hostingSurfaces` answers what the browser is
  showing and therefore what is worth polling for, on the same two rules as
  `broadcastTopics.ts`: the main pane's ROUTE always counts, a selected section
  only while its browser is visible — plus one of its own, that a surface which
  cannot STATE delivery is not a reason to poll for it. Two things follow from
  that and both are inputs rather than assumptions about the route: a Task row
  needs a second line (App answers that from the sidebar's density and the view
  together — one predicate, so the answer cannot drift from what the rows draw),
  and the Tasks section lives on a project's PAGE, not on the projects index.
  Those two are also reported on their own as `taskRows` — whether a two-line
  Backlog is on screen anywhere — because the app owes those rows a second thing
  besides the poll: a git-status WATCH per worktree. The The worktree screen is
  absent altogether — its Delivery panel fetches its own worktree by id — and so
  is the Pull Requests section, which reads its OWN inventory
  (`hooks/usePullRequestInventory.ts`), keyed by pull request rather than by
  checkout. Tested in `worktreeHosting.test.ts`, and the re-render counts in
  `uiLoadScenario.test.ts`.
- `worktreeWatchRegistry.ts` holds ONE refcount per watched worktree for the
  whole browser, because `watchWorktree` has none on the wire: the server keeps
  a plain Set of ids per connection, so a second watch for an id already in it
  does nothing and the first `unwatchWorktree` ends that watch for everybody.
  Three surfaces routinely want the same worktree — a Task row's dirty dot, the
  Projects/Worktrees browsers, the open session's header — and one of them
  leaving used to freeze the others. Each consumer holds a LEASE and states only
  its own ids; the socket sees the union, a watch on the first holder and an
  unwatch on the last release, with an id that survives a lease's change of mind
  never released and re-taken. It also tracks what the CURRENT connection was
  told apart from what the app wants: a drop forgets the former silently (the
  watches went with the socket, and an unwatch would be answered by the
  replacement connection), and the next connection is brought up to the full
  desired set. `hooks/useWorktreeWatches.ts` is the only way in, and
  `worktreeWatchAudit.test.ts` pins this as the only file that calls the two
  actions. Tested in `worktreeWatchRegistry.test.ts`.
- `swipeGesture.ts` owns the row-swipe math consumed by
  `components/common/SwipeRow`, for a row carrying an action on EACH side.
  Direction is part of every question here rather than a sign baked into the
  formulas, and WHICH sides exist is the caller's to say (`SwipeAllowed`): the
  edge guard that leaves iOS its back/forward gestures — now wider than
  `EDGE_SWIPE_ZONE_PX`, because a row's rightward swipe is the shell's own back
  direction and only the guard keeps one finger from arming both;
  `swipeClaimsTouch` (the lean at which the row takes the touch from the
  scroller, short of the engage threshold because the UA has decided about a pan
  by then, and only toward a side that HAS an action, since a claim spends the
  touch); the engage threshold at which the row starts following the finger; the
  vertical yield and dominance that give the scroller back only a MOSTLY
  vertical drag it has NOT claimed (a tie is a thumb's arc, not a scroll;
  `classifySwipeMove` takes `claimed` and answers with the DIRECTION, and a
  claimed touch stops judging the vertical entirely — there is nothing left to
  yield to once the pan has been vetoed); `swipeTravel`, signed and CLAMPED to
  the engaged direction so dragging back through zero cannot open the opposite
  action; the rubber band past full travel; and the width-aware threshold so a
  sidebar row does not need a swipe wider than itself. That threshold is asked
  as two questions: `swipeArms` is the VISIBLE one the panel paints, distance
  only because distance is all a reader can see, and `swipeCommits` is what a
  release asks — armed, OR a flick past `SWIPE_FLICK_VELOCITY` in the gesture's
  own direction, which also refuses a row thrown BACK however far it had
  travelled. The claim mirrors `components/shell/edgeSwipe.ts` and keeps its own
  constants: that one only judges touches from a reserved edge strip, this one
  is asked about every list scroll that starts on a row. Pure, so the numbers
  are tested rather than tuned by feel (`swipeGesture.test.ts`, which also pins
  the guard against the edge strip — separate modules, so only a test holds them
  together).
- `taskDelete.ts` owns WHICH rows a delete really takes and how it asks.
  `deleteSet` is the subtree, deepest first: the server's `deleteTask` promotes
  a deleted Task's children to roots, so a parent removed first would have its
  subtasks drawn at the top level in the instant before they went too, and depth
  is read off the tree rather than off the walk so the order does not depend on
  the order the ids arrived in. It takes UNFINISHED descendants, unlike
  `taskArchive.ts`'s cascade, because there is no surviving parent to leave them
  attached to — and `deleteConfirmation` is the guardrail that replaces the
  archive's Undo, naming the subtask count in the QUESTION
  (`taskDelete.test.ts`).
- `backlogInbox.ts` owns the pure projection behind the Backlog's **Inbox**
  view: `isUntriaged`, `belongsInInbox`, `buildInboxList` (newest arrival first
  — triage is a queue you work from the top of, and the thing that just arrived
  is the one you have most context for), `hasInboxWork` and `taskOrigin`.
  Membership keys on `triagedAt` and NEVER on `source.createdBy`: who WANTED a
  Task is a different question from whether it was typed into the Backlog, and a
  Slack shortcut import is honestly created "by the user" while still being an
  arrival — keying on the creator silently kept every Slack Task out of the
  surface advertised for it. The server decides typed-vs-arrived at creation
  (`tasks.ts` `createTask`'s `triaged` input). ONE further rule: a SUBTASK is
  never in the Inbox and a top-level arrival always is. A subtask hangs off a
  parent you already accepted, so a coding session decomposing its work would
  otherwise fill the queue with implementation detail — the exact noise that
  makes an inbox get ignored — while a root Task is a new claim on your
  attention whatever produced it. `done` is excluded for the same reason Focus
  excludes it. `taskOrigin` is the row's reason for a second line: deciding
  about something you did not write requires knowing what produced it, so it
  prefers a real external source (Slack/Jira/GitHub) over the persona that
  recorded it and degrades to a generic phrase rather than printing an internal
  persona key. Tested in `backlogInbox.test.ts`.
- `sessionInbox.ts` owns the pure Sessions-inbox projection behind
  `components/SessionInbox.tsx`: status classification (`classifySessionStatus`
  — a human decision outranks running, running outranks a stale failure, and the
  session you have READ THROUGH is never "unread"; that is the `readCurrentId`
  option, deliberately separate from `currentId` and never defaulted from it,
  because "routed" and "read" are the two ends of `SESSION_READ_DWELL_MS` and
  collapsing them is exactly the jump the dwell exists to remove — `currentId`
  alone only pins a routed settled row; an unacknowledged OUTCOME classifies as
  `completed` below `unread`, so a run that finished while another tab held the
  transcript open still states itself), attention tiers, the active/settled
  partition (the shared `isShelvedSession` refuses to hide human-blocking work
  in the shelf, but NOT a running session — a settled session's next turn is not
  news, and the server withholds `settledAt` from a row whose latest outcome is
  unacknowledged, which is what brings it back), tier-then-activity-then-id
  ordering (a card moves when its STATE changes, not on every recency tick), the
  age labels (malformed timestamps degrade to `—`/`0s`, never `NaN`), search
  matching, and settled-shelf paging with routed-row pinning. The state is split
  in two: `sessionStatusBadge` is the SHORT coloured marker
  (`Answer`/`Approve`/`Pick task`/`Failed`/`Done`/`Working 4m`, with a semantic
  `tone` the renderer maps to theme tokens; `Pick task` is a `/pr` card's
  `attention: "task-choice"` — a **needs-you** decision of its own, because the
  answer is a click on that card rather than a reply in the composer) and
  `Interrupted` is the odd one out and deliberately `warning` rather than
  `danger`: a turn the server process died inside is not a broken run and needs
  no decision, it is work waiting on the next prompt, and it sits BELOW `failed`
  in `classifySessionStatus` so a session that actually broke says so first.
  `sessionStatusDetail` is what the badge cannot say (above all the bounded
  failure message). A QUIET session deliberately has no badge and, unless it
  holds queued work, no detail either — absence is what says nothing needs you,
  and the card drops its state line — and `sessionStatusText` recombines both
  for the assistive-technology label, falling back to `Active`.
  `sessionCardMeta` returns the third line as marked items rather than strings
  (Project → Worktree → Task → fork lineage), each carrying its `kind` so the
  card can draw the object's own glyph; only the Project item is also the card's
  target for its object, the Worktree and Task items are named there and opened
  from the card's jump buttons. The Project item carries the resolved id, the
  short KEY and the registry color, and the Task item is its ID (`#227`) — both
  keep the full name/title as the tooltip only, since a title used to eat the
  whole line. The Worktree item carries `missing: true` when
  `session.worktreeMissing` is set (Task-325), so `ActiveSessionCard` can tint
  just that item's glyph and label with the warning token instead of a
  whole-card treatment. Everything that led nowhere is gone from that line — the
  persona (the card's leading icon is the agent), the model, and the Task
  progress counter. Settle ELIGIBILITY is deliberately NOT defined here — it is
  `@assistant/shared`'s `settleBlockedReason`, the one predicate the server
  enforces with. It also owns the card's memo identity: `sessionCardKey`
  (everything `ActiveSessionCard` renders off the row, with the RENDERED
  age/badge labels standing in for `now`) and `sessionRelationsKey` (the
  browser-resolved half). Same contract and same invisible failure as
  `sessionRows.ts` — the list is rebroadcast up to ~4x/second with brand-new row
  objects, so cards can only hold on CONTENT, and a card that reads a field the
  key omits silently stops updating. `SessionInbox` reuses both keys, headed by
  the host's row density, as the digest gating its reorder pass, so a commit
  that repaints no card also costs no layout (Task-338). React- and socket-free,
  so the rules stay testable against partial rows.
- `sessionDelivery.ts` owns where a SESSION's pull request stands, for the
  indicator every session list carries ([Task-342](pa://task/342)). Its input is
  the row's own `SessionListItem.pullRequest` — nothing here fetches or joins —
  and its rungs are `worktreeHosting.ts`'s ladder plus the ones only a CARD has:
  `choosing-task` and `creating` before the pull request exists, `failed` for a
  card that never opened one, `conflicts` inserted directly UNDER red checks
  rather than reordering the shared ladder, and `draft` taking the rung a plain
  open pull request would (a review ON a draft still outranks it — a comment
  someone left is not waiting for the flag to clear). A TERMINAL status answers
  before the ladder is consulted at all, which is the one rule here that is not
  cosmetic: the watcher stops polling once a card leaves `open`, so its `ci` is
  frozen, and letting the CI rung outrank `merged` showed a shipped pull request
  as permanently failing with nothing left to revise it. The worktree ladder can
  afford that rung because its CI is live. A closed pull request is stated
  rather than dropped (the worktree ladder answers null for one): the question
  this indicator answers is which session owns the card, and a session that
  opened a pull request nobody merged still owns it. `sessionDelivery` returns
  the state, its semantic tone, the one- or two-word chip label (the Backlog
  chip's wording, so a state is not learned twice) and the sentence that does
  not fit; `sessionDeliveryKey` is what puts it on `sessionRows.ts`'s and
  `sessionInbox.ts`'s memo keys, since CI turning red moves nothing else about a
  session. Tested in `sessionDelivery.test.ts`. `sessionInbox.ts` also owns the
  ONE effect background work has on a card: `SessionBackgroundActivity` may lift
  an otherwise QUIET card from the `active` tier into `working` when it holds
  work somebody waits on or an empty retained host in its grace
  (`backgroundWorkBusy`; a declared service does not) — the session really is
  busy, just not with a turn — and it may do nothing else. It never becomes the
  card's `status`, so the badge, the spinner and unread are untouched, and
  `sessionCardKey` folds in the rendered chip (`backgroundActivityKey`) plus the
  resulting tier.
- `sessionInbox.ts` shapes ONE more surface: `spawnedSessionsView` is the peers
  a single session spawned, for the composer's spawned-session ledge. Every row
  is built by the same private `inboxCard` the inbox and the cluster fold use,
  and the aggregate by the same `clusterCounts`, so the three can never state
  the same session — or count the same set — differently;
  `spawnedSessionsSummary` is `sessionClusterSummary` plus the strip's
  `· N settled`, so the relation is called one thing wherever it is read —
  including when that wording changes, which is why the seam exists rather than
  a second format string. Three rules differ from the fold on purpose. Settled
  history is a toggle on the strip itself, offered even when every peer is
  settled, where the fold exists only while something is live. Membership is the
  durable `spawnedBySessionId` edge ALONE: ownership does not filter here,
  because "what did this chat start" is still answered by a peer the user has
  since taken over (the fold's ownership rule exists to keep that peer a
  top-level row, which is a different question). And its rows run by latest
  activity alone, newest first, where the fold sorts by tier: the strip is a
  feed of what the peers last did, and the tiering is stated on its collapsed
  line instead. It walks EVERY depth (breadth-first, each peer once, so a cycle
  cannot repeat one) and returns the peers as a tree with `depth` and nested
  `peers` counts. The tree splits on `isDormantInSpawnTree`: LIVE peers — not
  put down, a settled peer running a turn or holding jobs again, or a dormant
  peer that live work hangs below (the branch it hangs from) — are always listed
  and counted; DORMANT history is counted as `settled`, never in `counts`, and
  listed in `rows` only with `includeSettled`, which adds rows and no numbers.
  `bubbled` — the peer waiting on a human or holding a failure — is picked in
  TIER order over all live peers, so the activity order cannot hide the one that
  needs answering. `spawnedSessionsKey` is the content key the host holds the
  strip on (`App.tsx` gates the ledge node on it exactly as it gates the
  Backlog's session slice — the composer is memoized, and a node rebuilt on
  every rebroadcast re-renders the whole card for a line whose text did not
  change; `transcriptRedrawScenario.test.tsx` counts it). Same contract, and the
  same silent failure, as `sessionCardKey` — with the bubble and whether it is
  DISMISSIBLE in it, and two differences that come from the CONSUMER rather than
  from taste: this key gates a value the host RETAINS, where a card key feeds a
  comparator that re-reads the old row against the new one at the current time.
  (1) `open` is part of it. The collapsed strip draws counts and a bubble, and
  neither reads a clock — a bubbled peer waits on a human or holds a failure,
  never runs a turn — so a peer streaming tokens changes nothing on it, which is
  the hot path and is free. Opened, every listed peer is on screen with its own
  age, so the rows join the key and a moved timestamp rebuilds the node: the
  honest cost of a live list the user asked for, bounded by how long it stays
  open. Flipping the disclosure is itself a key change, so the rows arrive
  current. (2) A peer's timestamps go in RAW, not as `sessionRowKey`'s bucketed
  label: a bucket that keeps answering "now" for the live row while the retained
  one ages would let the strip drift arbitrarily far from the truth — sound for
  a comparator, wrong for a held value. The state's sentence goes in through
  `sessionStatusDetail`, so a row that starts saying something new — queued work
  waiting, a failure message, an outcome that failed rather than finished, none
  of which move `status` — cannot say it while the gate holds the old view.
  There is deliberately no `readCurrentId` option: the ledge belongs to the
  session on screen, so a peer of it is never the session being read.
- `backgroundWork.ts` owns the pure background-work projection
  ([Task-486](pa://task/486)) shared by the `/background-tasks` registry, the
  session inspector's Background work section and the session card's chip:
  active/recent classification (`pending-launch` and `running` are both ACTIVE),
  RENDER paging over the whole match set (a cutoff, not a cursor, so a running
  row cannot fall off the end when a page boundary moves) — this bounds what is
  DRAWN and nothing else: the `background` topic still ships every live row on
  subscribe, and no client-side view changes that. A `pinnedId` survives the
  cutoff so a `?task=` deep link's target is on the page it opens, which is a
  stronger failure than not scrolling to it, the state badge,
  kind/backend/age/frozen-deadline/retained-host labels, the bounded evidence
  facts, `backgroundWorkCommandDetail` (the command a row shows UNDER its title,
  or nothing when the title already is the whole one-line command — so a bare
  command never prints itself twice), `backgroundWorkOutcomeDetail` (the same
  test applied to the server's outcome sentence: a summary that opens with the
  job's own title loses that prefix — only at a delimiter, so label `Test` never
  turns `Tests failed` into `s failed` — one that IS the title says nothing, and
  a bare `Exited with code 0` is what the success mark already showed on a
  `completed` update, and ONLY there: that inference holds for a PA-supervised
  process, whose state is derived from its exit code, not for a Claude task
  reporting a provider status), the `Background 2 · 8m` chip with its assistive
  sentence, the global active count derived from SESSION summaries alone, and
  the row/chip content keys (which fold in the command and description). The
  registry's free-text search covers the description and the command as well as
  the label and owner title. Every function is deterministic over one
  `BackgroundWorkItemSummary` (or one `SessionBackgroundActivity`) plus an
  explicit `now`; nothing here derives a lifecycle transition, and a Stop that
  is only REQUESTED renders as `Stopping`/`Stop unconfirmed` on a still-active
  row rather than as a terminal one. Tested in `backgroundWork.test.ts`,
  including that an artifact id never reaches a rendered fact. `serverOrigin.ts`
  grew `artifactHttpUrl` alongside `serverHttpOrigin`/ `withToken` when a second
  surface needed it: it is the ONE way an artifact URL is authenticated for a
  header-less context (`<img>`, an anchor download, a blob fetch), used by the
  session Artifacts drawer and by the background-work evidence link.
- `relativeTime.ts` holds `relativeAge` and `elapsedLabel`, the two compact time
  labels every inbox-style row shares. They live apart from `sessionInbox.ts`
  because `sessionInbox.ts` and `backgroundWork.ts` read each other (a session
  card carries both its provider status and its separate background chip), and
  keeping the formatters here is what stops that from being an import cycle.
- `rowDensity.ts` is the one `RowDensity` (`tight` | `comfortable`) both the
  Backlog and the Sessions inbox take from their host — `backlogTreeModel.ts`'s
  `BacklogDensity` is an alias of it — so the two browsers cannot answer "how
  much room does a row get" differently. It is a host decision passed as a prop,
  never a breakpoint a row reads for itself: the desktop rail is short of width,
  a phone screen is short of nothing but needs thumb targets.
- `worktreeAxes.ts` is what is LEFT of `worktreeInbox.ts` (Task-243), which
  owned the deleted Worktrees inbox's whole projection. The surface went; the
  axes stayed, because the Project page's worktree rows and the Projects tree
  still draw them through `components/worktreeRowParts.tsx`. `worktreeAxes`
  splits three independent questions — worktree vs local base, local base vs its
  tracked remote, and worktree vs its tracked remote — into conditionally
  omitted spans inside one truncating run, which ellipsizes as a whole when it
  does not fit. It takes the narrow record + status inputs directly so both
  surfaces use one model. Remote-facing labels come from the status projection's
  optional Git-resolved upstream names; an older server degrades to the generic
  relationship word `upstream`, never to an invented `origin`. Base-upstream
  drift is a MODIFIER; its group is omitted when in sync and on main, whose same
  relationship is already the upstream axis. A status with no `fetchedAt` counts
  as stale rather than fresh, on the module's one surviving contract: an ABSENT
  status is UNKNOWN, never clean.
- `pullRequestInbox.ts` is its successor in the sidebar slot: the pure Pull
  Requests projection — grouping, ordering, search, the row's status vocabulary,
  and the detail page's derived state — React-, socket- and fetch-free, and
  tested in `pullRequestInbox.test.ts` for the same reason its predecessor was:
  every failure here is INVISIBLE. Three groups, in order: **Needs your review**
  (a review request outranks your own authorship — somebody else is blocked),
  **Yours** (drafts marked, never hidden), **Needs cleanup** (a terminal pull
  request is ALWAYS here, because the server inventories one only while a
  worktree still holds its branch). Ordering is most-recently-updated first with
  an absent `updatedAt` sorting LAST, tie-broken by `pullRequestRowId`
  (`projectId#provider#repositoryKey#number`) so the order is TOTAL — a poll
  that changed nothing must not reshuffle the list, and a number alone names
  nothing since every repository has a #1.
  `PullRequestTarget`/`pullRequestTargetOf`/ `isPullRequestTarget` are the same
  identity as an ADDRESS — what the route carries and what a row compares itself
  against — so a row, its URL and the page it opens can never name different
  pull requests. The vocabulary keeps UNKNOWN apart from a negative answer
  throughout: an unread CI is unknown on an open pull request and "no checks" on
  a terminal one, a review with no thread count is not "all resolved", and
  `mergeable: null` is the provider STILL CHECKING, never a conflict.
  `pullRequestDetailState` derives the detail page's `LoadState` from the one
  inventory and the route's target, which is what makes R1 (an unanswered source
  may not say "no such pull request") and R2/R3 fall out of the model rather
  than being remembered per surface. `matchesPullRequestQuery` normalizes its
  own needle: it is exported, and a helper that silently wanted pre-lowercased
  input would answer "no match" for `Release-3`.
- `sessionDockContext.ts` owns the ONE priority rule behind the mobile dock
  row's context slot (`components/SessionDockActions.tsx`): worktree → origin
  Task → staged Knowledge entry → staged project, with a draft's staged context
  counting only until the session has an accepted user turn (those stagings
  outlive the send they were made for, so afterwards a stale one must not
  outrank the session's real worktree). `undefined` means the row falls back to
  the composer's paperclip. Pure and tested, so the order cannot drift into
  per-caller guesswork.
- `sessionHandoff.ts` owns the shared derivation rule behind every new session
  opened FOR an existing object: a plain start in a worktree
  (`startSessionInWorktree`, from the Project page's worktree rows and the
  object dock), both review handoff directions (`/review`'s
  `startReviewSessionForSession` and the worktree comment draft's
  `startWorktreeReviewDraft`) and the Pull Requests view's Review
  (`startPullRequestReviewDraft`, whose `pullRequestReviewContext` decides WHICH
  Task from SERVER ids only, in three tiers: the checkout's own `taskIds` out of
  the checkout answer, a Task claiming a session that runs in the checkout, then
  the pull request's links. SEVERAL live candidates in a tier is ambiguity and
  stops; NONE is a spent tier and hands over to the next, as the worktree rule
  already did for an edge whose Tasks are all archived. The browser's lists
  travel WITH their currency and answer only what they can: the middle tier is
  the client-side rule, skipped unless both lists are fresh and with UNKNOWN
  stopping the derivation rather than falling through; a FRESH Tasks list is the
  live projection, so an id it does not hold is SPENT (an archived Task leaves
  that list rather than carrying `archivedAt`, and staging it would link an
  archived Task); a list that has not answered rules nothing out, and the chosen
  id is then staged under the canonical `Task-<id>` label; and whose
  `buildPullRequestReviewPrompt` names the pull request, its number, its
  `base...head` range and its URL, because the agent lands in a checkout and
  that prose is all it has to tell which change it is looking at). It answers
  what Task / project / persona that session inherits, plus the `/review` draft
  text (`buildSessionReviewPrompt` — one editable paragraph naming the source
  session, telling the reviewer to send its review with `session_send_prompt`
  and then END its turn (replies arrive as new messages; a busy-waiting reviewer
  blocks the very delivery it waits for) and to say so explicitly when it
  accepts, with `/review <extra>` appended as a second paragraph; the delivery
  mechanics themselves stay owned by the tool description). The Task link
  resolves strongest-first (origin Task, a single Task claiming the session,
  then the worktree's Task) and ambiguity attaches NOTHING rather than guessing;
  degradation (no worktree, no Task, unloaded lists) is owned and tested here so
  the flows cannot disagree. A worktree's Task is the inverse of
  `worktrees.ts`'s `worktreeForTask` and takes its two rules — the record's
  `taskIds` edge, else a Task claiming a session that runs in that worktree (the
  edge is only written when the checkout was made FOR a Task, so without the
  second rule a checkout worked for days looks Task-less). Unlike
  `worktreeForTask` neither rule breaks ties on recency: several Tasks in one
  checkout is real ambiguity about what a new session is FOR.
- `sessionTimelineCache.ts` owns the bounded IndexedDB cache of lazily projected
  client timeline RANGES (eight most recent sessions), their reconstruction from
  a server snapshot, anchor validation, and best-effort persistence/deletion. A
  record is a range, not a prefix: `descriptor.startIndex` says where in the
  server's projection it begins, because a browser that only ever opened a long
  session holds its windowed tail — a descriptor read as a prefix from zero
  would splice the next snapshot into the wrong place. It is acceleration only:
  cache or quota failures degrade to a fresh windowed snapshot, and a v1
  (prefix) record no longer validates and is simply replaced. Its descriptor
  rides on the socket URL and on `loadSession`, so the read is on the critical
  path of both; `useAssistant` owns the in-flight map that lets a row tap warm
  it (one read per session, not one per caller). What it stores is the range the
  SNAPSHOT produced: entries pulled in afterwards by `loadTimelineRange` are
  deliberately NOT folded back into the record, so a reconnect or a revisit
  collapses the transcript to the cached range again (and the reading position
  with it). Persisting them would mean re-fingerprinting a multi-megabyte range
  on the main thread for rows the reader may never come back to; if that trade
  is ever revisited, the descriptor must be rebuilt for the whole grown range —
  a record whose descriptor does not describe its own entries is exactly what
  the range validation rejects. Both halves also refuse an UNRENDERABLE range
  (`timelineRangeIsRenderable`, Task 450): a reconstructed range that projects
  to zero display messages is treated as corruption — `expandTimelineSnapshot`
  returns null so `useAssistant` deletes the record and re-requests with an
  empty descriptor, and `cacheRecordForSnapshot` never persists one, so a blank
  transcript cannot become durable and re-poison every reopen. Only a SPLICE is
  refused: a window is the server's authoritative answer and rendering it is the
  end of the round trip, which is what bounds the repair to one retry.
- `sessionPreviewStore.ts` owns the OTHER transcript cache: the localStorage
  copy of the last painted `DisplayMessage`s (plus session shell and
  `contextInfo`) for the eight most recent sessions. It exists because it is
  synchronous — an IndexedDB read cannot beat the first paint — and it is read
  for the BOOT route only: `spendBootRouteIdentity` (a one-way latch burned by
  the first navigation away from that route) and `previewForSessionRoute` are
  together where "a cached transcript may only be painted where nothing else
  could be on screen" lives, so an in-app switch — including a return to the
  session the app booted on — has no cached paint to hide behind
  (`app/web/docs/loading-states.md` § The chat stage).
- `newSessionRuntime.ts` owns new-session model/harness defaults and the
  invariant that first-prompt runtime settings match the optimistic session
  shown in the composer. The harness travels with the model: both the defaults
  and the first-prompt selection derive it from the model option, so a staging
  record written before the model was known can never send a harness that
  contradicts the picked provider account. `mode` is a REQUIRED field of
  `NewSessionRuntimeDefaults` (it may be undefined = Build) and the defaults
  state Build: the model and thinking level are remembered picks, Build/Plan is
  chosen for ONE session, so a fresh staging entry point (a Task, a worktree,
  the `/review` handoff) never inherits a Plan staged for an earlier one. Only a
  RESTAGE of the record being edited passes its own mode on, and `App.tsx` drops
  the staged mode when the staging surface is left. `reviewHandoffSessionTarget`
  is the same invariant for the handoffs that create their session SERVER-side
  (`attachComments`): ONE assembly of that target for both comment bundles,
  because the two hand-written copies drifted — Build/Plan reached neither.
- `newSessionShell.ts` owns the optimistic session shell: what the staging
  surface shows between the first send and the URL landing on the session that
  send created. `newSessionShell` decides the header's provisional title and
  staged subtitle, the ONE bootstrap narration (nothing while the
  worktree-provisioning card narrates the same source, the server's blocker when
  the send failed, nothing once the agent answers) and `retryable`, the single
  rule behind both the retry affordance and the composer's re-issue routing.
  `stagedTranscript` decides which rows that surface renders, whether the send
  has `landed` (the viewed session is absent from the ids recorded at the send,
  so it is this send's own answer) and whether the created session's transcript
  has taken the prompt over. `landed` is what keeps the two apart: a failure
  claim and a re-issue are only honest while no session exists, and adoption is
  only safe on positive evidence — the same evidence `useSessionRouting` uses
  for the URL, so both layers name one session. Both functions are pure, so the
  scenario test (`src/newSessionLoadScenario.test.tsx`) drives the same
  decisions `App.tsx` renders.
- Turn grouping and per-turn/per-run usage math are NOT here: they live in
  `@assistant/shared/turnStats` (`docs/reference/shared-protocol.md`) because
  the transcript is windowed and the server computes the running totals for
  everything before the window with the same code the renderer continues them
  with. `components/MessageList.tsx` and `TurnStatsRow.tsx` import from there.
- `worktrees.ts` owns authenticated browser HTTP helpers for worktree reads plus
  explicit manual/auto commit, clean, push, deterministic synchronization
  (pull-rebase/rebase-main/fast-forward-main), and hosting/PR writes, plus
  `fetchWorktreeHostingAll` (the whole-list PR/CI projection the inbox orders
  itself by; a worktree the server could not reach is ABSENT from it, and
  callers must keep reading that as unknown). It also owns `worktreeForTask`,
  the ONE rule for which worktree a Task is being implemented in: the
  `task —in_worktree→ worktree` edge (`taskIds`) first, else the newest session
  that claims the Task and itself runs in a live worktree — that second rule
  exists because the edge is only written when a worktree is created FOR a Task,
  while picking the Task up later in an existing worktree links the SESSION
  instead. Both break ties on recency (resuming lands in the checkout last
  worked in, not in whichever row the list yielded first) and neither may return
  a REMOVED worktree, since a Task's edge outlives the checkout it names and
  staging a dead one would create a session against a missing cwd. It is pure
  and tested in `worktrees.test.ts` because every new-session entry point
  answers this question and they must not answer it differently — the Task page
  used to clear the worktree while the quick-start's Task row staged one.
- `pullRequestsApi.ts` owns the Pull Requests view's ONE read,
  `GET /api/pull-requests`, and its writes, `POST /api/pull-requests/merge` and
  `POST /api/pull-requests/checkout`. None is a worktree endpoint, so they are
  not in `worktrees.ts`; `hooks/usePullRequestInventory.ts` is the read's only
  caller, `components/pullRequest/usePullRequestMergeCleanup.tsx` the merge's
  and `components/pullRequest/usePullRequestReview.tsx` the checkout's. The
  checkout answers 200 with what it DID — created, updated, already-current, or
  refused with its kind and reason — so a dirty or diverged checkout arrives as
  data to render on the pull request rather than as a transport error. The merge
  answers 200 with a PER-PHASE outcome — a cleanup that refused beside a merge
  that landed — so only a refusal of the whole action throws. That refusal
  throws `PullRequestApiError`, and the CLASS is the point: the endpoint reports
  a landed merge as landed even when its own follow-up work fails, so an
  answered refusal means nothing landed, while any other throw (no response, a
  failed connection) leaves the outcome unknown — a distinction the surface has
  to make and cannot make from message text. `checkPullRequestFromView` is the
  read that ENDS that uncertainty (`POST /api/pull-requests/check`): it attempts
  nothing, so unlike a re-issued merge it stays answerable once a guard has
  turned against merging.
- `worktreeRetire.ts` is the two rules a retirement's surface must not get
  wrong, shared by the worktree inspector's Retire and the Pull Requests view's
  cleanup: which `refusalKind` `force` may answer (never `sessions`), and the
  outcome sentence, which reports what the run DID — verified delivery, a forced
  removal that SKIPPED the check, an unforced one that established nothing, or a
  kept branch. Two copies of these would drift into claiming a verification that
  never ran.
- `skillsApi.ts` owns per-skill HTTP reads. `fetchSkillDetail(name)` gets the
  bounded `SKILL.md` plus recursive tree; `fetchSkillFilePreview` reads one
  bounded text/Markdown preview keyed by NAME + NUL + skill-relative path; and
  `skillFileUrl` builds the token-carrying bounded raw/image/download URL
  ([Task-614](pa://task/614), [Task-615](pa://task/615)). The LIST is not here —
  it arrives on the `skills` topic through `useAssistant`. Fetches take an
  `AbortSignal` so `useFetchState` aborts the previous skill or file when its
  key changes.
- `knowledgeMarkdownDiff.ts` owns the pure Markdown diff helpers backing the KB
  tool cards' rendered diff: frontmatter strip, `diffMarkdownLines` (line-level
  runs), `diffMarkdownWords` (word-level segments), and
  `buildRenderedDiffMarkdown` (a single Markdown string with inline
  `<ins>`/`<del>` marks, line-aware so no mark spans a block boundary and block
  markers stay outside the mark) — all over one LCS core (prefix/suffix
  trimming, coarse fallback for huge changes) with an optional
  `ignoreWhitespace` comparison.
- `timezone.ts` owns pure IANA-timezone wall-clock conversion
  (`zonedWallTimeToUtcMs` over `@assistant/shared/zonedTime`'s verified
  `localWallTimeMs`, and `utcMsToZonedWallTimeValue`) plus validation
  (`isValidTimezone`, `resolveTimezone`, `temporalModeUsesTimezone`): lets a
  `datetime-local` input be interpreted as a wall-clock time in an arbitrary
  configured timezone (e.g. the profile timezone) rather than the browser's own
  timezone. `resolveTimezone` is the REQUIRED guard before passing any
  free-text/user-typed timezone into the conversion functions —
  `new Intl.DateTimeFormat({ timeZone })` throws synchronously for an invalid
  IANA string, which would otherwise crash a React render mid-keystroke.
  `temporalModeUsesTimezone` (true only for `window`/`recurring`) scopes
  timezone-validity errors to the modes where a timezone is actually meaningful,
  so a stale invalid value left over from editing a different mode never
  permanently blocks saving `persistent`/`until-changed`.
- `chartSpec.ts` owns the pure, framework-free constrained chart-spec schema +
  validator for the Markdown/KB `chart` fence (Task 139): `parseChartSpec`
  (bar/line only — no pie/doughnut/contributor rankings — with hard item limits,
  strict shape validation, and a concrete error string; never throws) and the
  deterministic `CHART_PALETTE`/`chartColor`. Consumed by
  `components/common/ChartBlock.tsx` and its table fallback.
- `credentialProfiles.ts` owns authenticated safe-profile fetch/create/delete
  and pi OpenAI-login-start calls plus `orderCredentialProfilesByProvider`, the
  shared stable Claude-then-OpenAI grouping used by New Session and Usage. It
  returns only summaries/setup instructions; no token ever crosses this HTTP
  boundary. It also owns the settings account surfaces: `accountModelOptions`
  (the account/model combinations the settings pickers list — enabled accounts
  only, plus a disabled account while a slot still pins it), `accountPinWarning`
  (mirrors the server's degradation so a slot pinned to a disabled/removed
  account says which account actually runs), and `disableAccountImpact` (what
  moves vs. what keeps running, for the disable confirmation).
- `usage.ts` owns the Usage page's authenticated profile-scoped fetches of
  `/api/usage/claude` (`fetchClaudeUsage` → `ClaudeUsageSnapshot`) and
  `/api/usage/openai` (`fetchOpenAiUsage` → `OpenAiUsageSnapshot`).
  `UsagePage.tsx` fans these calls out across every enabled account. It also
  owns `redeemOpenAiResetCredit(creditId, profileId)` (POST
  `/api/usage/openai/redeem-reset` → `OpenAiResetRedeemResult`) — irreversible,
  called only behind an explicit confirm; the server 409s when no reset is
  applicable.
- `webPush.ts` owns browser-side Declarative Web Push feature detection
  (`window.pushManager`, secure context, Notifications API), VAPID public-key
  decoding, authenticated subscription registration/removal, and enable/disable
  orchestration. Permission requests must remain inside the explicit Settings
  button gesture; this latest-iOS-first path does not use service-worker
  push/click handlers. It is the BROWSER half of notifications only: the native
  shell has no push service at all, and `nativeShell.ts` answers who raises an
  alert there.
- `nativeShell.ts` owns detection of, and the typed surface for, the Tauri
  shell: the platform read synchronously off the root attribute the shell stamps
  before first paint (an awaited check would render the browser layout and
  correct it a frame later, visible as a jump in the chrome it exists to tidy),
  whether the overlay title bar is in play, whether the microphone grant
  persists on its own, whether the app may claim the screen edges for gestures
  of its own (`ownsScreenEdgeGestures`: only in the shell, where WKWebView's
  back/forward gestures are off and unsupported on iOS anyway — in a browser
  both edges are the platform's and an app gesture there loses), and
  `nativeNotify`. Alerts are the one capability split by runtime rather than
  enhanced: `notificationsNeedNativeShell()` says which client acts on an
  `appNotification`, since a browser is already subscribed for the same alert
  and acting on both would notify twice. `onNativeOpenUrl` and
  `takePendingNativeOpenUrl` are the two halves of an open request arriving from
  OUTSIDE the page: the live event, and the one that arrived before this page
  could listen — the case that matters, because a `pa://` link LAUNCHES the app
  and the page then takes seconds to subscribe. `notifyWindowReady` and
  `openNativeWindow` are the window half. A shell window is created HIDDEN and
  pointed straight at the server, so the first `notifyWindowReady` is what
  reveals it — and it is called on `hydrated` rather than on mount, because
  hydrated is the first render that draws the app instead of `LoadingShell` and
  a window revealed before that would show the boot screen the change exists to
  remove. The theme rides with it because the shell paints the NEXT window's
  frame before any page exists to be asked, and `assistant.prefs` lives on this
  origin where Rust cannot read it; re-reporting on a theme change keeps that
  value fresh, and the shell reveals a window only on the first report.
  `openNativeWindow` is the only way the page can ask for a second window at all
  — it is granted no window API — and answers false in a browser and on iOS,
  which has one window and no second one to open.
- `openTarget.ts` turns that request into a route. Two producers name the
  destination differently and both are right: a notification carries the
  server's `navigatePath` (already canonical, and the only form that can express
  a surface with no object behind it), while a `pa://` deep link names an
  OBJECT, because it was written into a document months ago and has to survive
  the routes moving underneath it. They are told apart by their first character.
  Anything else resolves to null and is dropped — this input crosses a trust
  boundary, so a protocol-relative `//host` or a backslash path must never
  become a navigation.
- `appStatus.ts` decides which app-wide lifecycle state the app status slot
  announces, and in what words: a queued or running server restart, or a socket
  that has dropped, ranked so the restart wins because it owns the disconnect it
  causes. Pure and DOM-free, which is the point — the slot has two placements
  (`AppStatus.tsx`) and a phone and a desktop must never be able to disagree
  about whether the app is restarting. It also holds the connection's grace
  period in a module store, because the two placements do not live and die
  together — the header bar exists only on wide layouts — and a timer owned by a
  component would restart at the breakpoint and blank an announcement that had
  been on screen for minutes. The copy is short enough for a pill, because that
  is the geometry the narrow layout gives it and the user can act on none of it.
  What is ELIGIBLE for this slot at all is `docs/messaging.md`.
- `messageAnnounce.ts` turns a server `notice`/`error` into the ephemeral
  announcement the model allows for an event whose surface is gone: it NAMES the
  object from the wire's `MessageTarget` (a resolved title where the client has
  one, otherwise the object's type and id — a bare id is not a name, but it is
  attribution, and attribution is exactly what the old global bar lacked), picks
  the tone from the severity, takes its duration from `toast.ts`'s two constants
  rather than a number per call site, and keys a targeted message by its object
  so a second failure about the same thing REPLACES the first instead of
  stacking. Pure, so the naming rule cannot be skipped at a call site.
  `failureOnViewedSession` is the other half and the model's first question made
  concrete: a failure naming the session on screen is rendered THERE (above the
  composer, where it can be acted on and where `clearChatError` retires it) and
  must not also be announced, because a failure shown twice and one shown
  nowhere are both silent mistakes. Sessions carry the great majority of the
  app's failures, which is why they get an in-place home first.
- `messageArrival.ts` is where an announcement is DECIDED, from the message and
  nothing that outlived it. `arrivalMessage` is the one list of what each server
  message says (the generic `notice`/`error`, a failed run in the viewed chat,
  the Assistant's queue states, a draft session's note, a jump whose target is
  gone), and it takes only the correlation facts the matching reducer branch
  already asks for — is this our chat, is this the jump still pending.
  `sessionFailureFrom` is the same function the reducer uses to put a failure ON
  its session, so the object that keeps a failure and the decision not to also
  say it in passing cannot disagree about which object it was. The module store
  holds the other half of ownership, the half no server can know:
  `setFailureHomes` is how the surfaces on screen state that they render a
  failure in place — the viewed session, and a staged first send, which claims
  by SITUATION because it is creating the session it is about: the server's
  pre-creation refusals name nothing, so those are what it takes, plus its own
  id where the client minted one (claude-sdk supplies the session id, pi does
  not). It is deliberately not "every error while a send is out": that loses a
  background failure with no object to be found by. `openObjects` is the same
  claim for the other three object types that own a surface — the project, Task
  and Knowledge entry currently open, one id each, compared BY id so the open
  member says nothing about the rest of its list. `objectFailureFrom` is their
  `sessionFailureFrom`, over the one internal derivation both use, and
  `OBJECT_FAILURE_TYPES` is the single list of which types keep such a store (a
  worktree does not: its writes narrate themselves where they were issued).
  `arrivalHasHome` consumes an arrival against those claims plus the collections
  whose load failure is kept as a pane condition (`CONDITION_COLLECTIONS`:
  projects, Tasks, worktrees). Errors only: the in-place note exists for a
  failure, so a warning naming the session or object in view is still announced.
  Why it is shaped this way, and what each earlier shape cost, is
  `docs/messaging.md`.
- `historyNav.ts` owns the app's position in its own history, and therefore
  every `pushState`/`replaceState` in the app. The platform answers no question
  about history's shape — deliberately, since that would leak browsing — so each
  entry the app creates is stamped with an index, `deepest` (kept in
  `sessionStorage`, because a reload is one keystroke away in the shell) records
  how far forward the user has been, and the header's arrows read the two. A
  bare history call elsewhere is an entry with no index: the counter freezes and
  the arrows point at the wrong places, with nothing failing.
- `toolOutput.ts` owns the pure parsers behind the native tool bodies:
  `parseNumberedFileOutput` (lift a `cat -n` gutter out of `read` output,
  returning the real first line — it declines unless every row matches AND the
  numbers are consecutive, so ordinary content starting with digits is never
  mangled), `splitTrailingNotice`, `parseNumberedDiff` (a provider-rendered
  `"<sign><num> <text>"` diff with `...` elisions → rows), `diffRowsFromRuns`
  (LCS runs → rows with NO numbers), `markIntralineChanges` + `tokenizeCode`
  (pair replaced lines and mark the changed spans within them, the word-level
  detail the pierre surfaces give the worktree views), and `bashCommand`. The
  word diff itself is `knowledgeMarkdownDiff.ts`'s `diffMarkdownWords`, which
  now takes an optional `tokenize` so code callers get identifier-level
  granularity while prose keeps whitespace words.
- `jiraApi.ts` owns the authenticated linked-issue metadata fetch used to enrich
  Task inspector Jira rows; callers must tolerate an empty issue list when Jira
  is disabled or unconfigured.
- Other files own focused browser helpers used by hooks/components.

## Contract notes and rationale

- `recentTranscripts.ts` owns a browser-local, count- and length-capped history
  of delivered transcripts, so Settings → Dictation can show what the recognizer
  ACTUALLY wrote — the phrase a vocabulary rule must match is otherwise gone the
  moment you fix the word in your draft. It is `localStorage` and nothing more,
  deliberately: the server persists no transcripts and this must not quietly
  change that, so it is per-device (merging phone and laptop would mean durable
  server-side storage of dictated text) and the editor offers a Clear action.
  The list transforms (`parseStoredTranscripts`, `appendTranscript`,
  `transcriptAge`) are exported as pure functions because this package's tests
  run DOM-free; keep the storage wrapper around them trivial rather than adding
  a jsdom environment.
- `waveform.ts` owns the dictation display envelope: `framePeaks` (peak
  magnitude per bucket of one PCM frame) and `PeakRing` (fixed-capacity ring,
  oldest-first, with a `version` counter so a canvas can skip redundant
  repaints). The envelope is derived on the MAIN thread from the frames
  `speechCapture`'s `onFrame` already delivers — the audio thread stays
  untouched, no extra worklet messages exist to keep in sync, and the plot
  cannot drift from the audio actually captured.
  `components/common/WaveformStrip.tsx` renders it.
- `speechCapture.ts` + `pcm16Worklet.js` own microphone capture for dictation,
  and `insertTranscript.ts` owns where the transcript lands in the draft (at the
  caret, spacing added only where missing, never auto-sent). The worklet runs on
  the audio thread and must stay allocation-light: it frames ~200 ms of audio
  per message (raw 128-sample quanta would be ~375 messages/s of overhead) and
  decimates to 16 kHz ONLY by an exact integer factor, passing other rates
  through for the server to resample — never resample at a non-integer ratio
  here. `vite.config.ts` excludes `pcm16Worklet.js` from asset inlining: it is
  small enough that Vite would emit a `data:text/javascript` URL, and
  `audioWorklet.addModule()` does not reliably accept data URLs. The capture
  handle keeps every frame as the AUTHORITATIVE utterance and only feeds the
  socket while `bufferedAmount` is under the watermark — `WebSocket.send`
  neither blocks nor drops on a slow link, it queues, and that queue is
  discarded if the socket closes. The microphone STREAM is module state that
  outlives one utterance: Safari does not persist the grant (an installed Home
  Screen app re-prompts on every `getUserMedia`, which made every mic tap cost a
  permission dialog), so the tracks are parked DISABLED instead of stopped and
  reused by the next utterance. That hold is bounded — released when the page
  hides or unloads, after `PARK_TIMEOUT_MS` idle, and never taken at all where
  `navigator.permissions` reports the grant as remembered (Chromium/Firefox),
  since there it would only add a standing recording indicator. Do not go back
  to stopping the tracks per utterance. The `AudioContext` (with the worklet
  module already registered) is parked the same way and for the same reason:
  constructing it and fetching/compiling the worklet is the bulk of the wait
  between the press and recording, and it says nothing about the utterance — so
  `stop()` only SUSPENDS it, and `releaseMicrophone` closes it together with the
  stream. It is also acquired BEFORE `getUserMedia` rather than after: Safari
  only lets a user gesture start audio, and an awaited permission prompt spends
  that gesture, leaving a resumed-but-suspended graph recording silence. A
  parked context that will not resume is discarded and rebuilt rather than
  retried.
- `screenWakeLock.ts` owns `requestScreenWakeLock`, held only while dictation is
  recording: that is the app's one state where the user is deliberately not
  touching the screen, so the display timeout would otherwise dim and lock
  mid-sentence — which hides the document, and a hidden document cancels the
  utterance (a backgrounded `AudioContext` records silence). Every failure path
  degrades silently; the API is absent on some browsers and the request is
  rejected outright when the page is not visible, and neither may fail a
  recording.
- Keep helpers small and mostly framework-free unless a browser API is the
  purpose.
- Do not import React components from this folder.
- Preserve auth-token propagation for all guarded API and WebSocket calls.
- Keep pure transform helpers deterministic and covered by TypeScript
  strictness.

## Working notes

- Prefer this folder for shared client logic that would otherwise be duplicated
  across hooks/components.

## Verification commands

- Run `pnpm --filter @assistant/web build` for this subtree.
- Run root `pnpm run build` before closeout.
