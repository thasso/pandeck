# Web app shell — implementation reference

Relocated from `app/web/src/CLAUDE.md` (Task-274) so it stops costing agent
context on every visit. This is a descriptive snapshot of what the modules in
that subtree own; the rules an agent must not violate stay in that folder's
`CLAUDE.md`. Correct or delete a section here when the code moves on. Relative
paths in the body are relative to the original subtree.

## Purpose

React client source for routing, socket state, chat rendering, settings,
tasks/projects, calendar, and browser-side helpers.

## Module ownership

- `App.tsx` owns route selection, feature state wiring, and lazy page
  composition; the three-pane layout itself is owned by `components/shell/` per
  `../docs/ui-shell.md`. New-session model choices come from the selected
  credential profile's server-projected model list, never the
  global/default-account list; established sessions retain the global list for
  immutable model display. First send stays blocked until that projection is
  authoritative, and profile-load failures replace Quick Start with an explicit
  error + retry rather than silently falling back to pi/default. The same
  profile projection also feeds Settings as `accountModels`
  (`lib/credentialProfiles.ts` `accountModelOptions`), so configured agents are
  pinned to an account/model combination rather than the default account's
  catalog; the account list itself is passed alongside only to explain a
  degraded pin.
- A staged first send is OPTIMISTIC, and `App.tsx` owns both halves of that. The
  transcript on a staged route renders THIS browser's own `creq-*` prompt
  (`stagedMessages`, filtered from `state.optimistic` by the staged session id)
  instead of an empty list — an empty list meant `displayHasUserPrompt` stayed
  false for the whole round trip, so the quick-start hero and the send-blocked
  hint kept sitting on top of a prompt that had already been sent.
  `sendInFlight` is the explicit companion for the paths that echo nothing
  locally (the Knowledge/worktree review handoffs, whose session is created
  server-side): `armStagedSend` sets it together with `notifyStagedFirstSend`,
  and it clears when a prompt is actually visible, when the route lands on the
  created session, or when the server answers with an error — never on a timer,
  and never inferred from the transcript alone.
- "+ New worktree" ([Task-240](pa://task/240)) is staged as `pendingNewWorktree`
  beside `pendingWorktreeContext` and sent as `createWorktreeInProjectId` on the
  first prompt; the server creates the checkout before the session, so nothing
  downstream changes. `stageNewWorktree` carries the same Developer coupling as
  `stageWorktreeContext` and staging a real worktree clears the flag, but
  switching PROJECT retargets it instead of cancelling — a worktree that does
  not exist yet has no identity to lose, and cancelling would bounce the persona
  Developer→Assistant→Developer for a pick the user did not undo. Clearing the
  project does cancel it: there is then no repository to create it in.
- `displaySession.worktreeMissing` ([Task-321](pa://task/321)) is the mirror of
  the new-session `newSessionNeedsWorktree` rule for a session that ALREADY
  exists: the worktree it ran in is gone, so the server refuses every run and
  the chat surface renders `SessionWorktreeMissingBanner` above a fully DISABLED
  composer (not just a blocked Send — the banner owns the one action that
  unblocks it, `actions.acknowledgeMissingWorktree`). `sendPromptWithRuntime`
  carries the same belt as the other blocked reasons so a stale keystroke cannot
  reach the server. Nothing is applied optimistically: the server answers the
  acknowledgement with a fresh session state and list that clear the flag.
- `armStagedSend` is the ONE way a staged first send leaves, and it RECORDS that
  send in `stagedSend` until the URL lands on the session it creates: the
  bootstrap latch, the `knownSessionIds` snapshot the staged transcript weighs
  the viewed session against, the `resend` that re-runs it, and — for the plain
  `harnessSend` kinds — the held `input`. That snapshot is the sidebar list plus
  the id then viewed, captured exactly as `useSessionRouting`'s
  `notifyStagedFirstSend` captures `knownIdsAtArm`: the URL and the transcript
  must adopt the SAME created session, and a weaker test on this side is how the
  surface ends up showing a conversation the router correctly refused to follow.
  `armStagedSend` also retires the chat error channel
  (`actions.clearChatError`), because a dismissed banner leaves `state.error`
  set and the bootstrap narration would otherwise report the previous outcome as
  this one. Arming and recording are the same call on purpose: while they were
  two, the review handoffs (which echo no prompt of their own) armed without a
  record, and the staged surface adopted the previously viewed conversation's
  rows and identity.
- A FAILED first send may create no session at all — a worktree that could not
  be checked out, a model the account cannot run — while its prompt stays on
  screen as this browser's optimistic echo. That "no session at all" is the
  condition, not the failure: `newSessionShell`'s `retryable` is the one rule
  behind both the retry affordance and the re-issue routing, and it requires
  `stagedTranscript`'s `landed` to be false, because an error cannot say which
  send it belongs to while a created session can say that this one is over.
  Without that gate an unrelated error in the bootstrap window turned the next
  composer send into a second session. The surface therefore stays in first-send
  mode until a session exists — `lib/newSessionRuntime.ts`'s `routeComposerSend`
  is that decision, and it is a safety rule, not a cosmetic one: `prompt`
  targets the session the CONNECTION is viewing, so falling through would
  silently start a turn in whichever session was open before. The one detach
  frame, `sessionViewCleared`, is reserved for archiving/deleting a session: it
  clears the client chat shell without creating a replacement, a late frame is
  keyed by session id so it cannot clear a newer view, and the frame also
  arrives for a session this client was only still LOADING (superseded by its
  archive, or deleted — from any client). The reducer records it as
  `viewCleared`, and `App` leaves a route that names that session for
  `/sessions/create`, once, on arrival (`sessionRemovedScenario.test.tsx`), so a
  later deliberate open of an archived session is not bounced. Both the card's
  Retry and the next composer send re-issue the held send (the latter with the
  new text) under the SAME `clientRequestId`, so the visible prompt is replaced
  rather than duplicated and the unsent text is never parked in a composer draft
  that a navigation could drop. Re-issuing after a failure that DID create a
  session costs one empty session; letting the prompt fall through costs a turn
  in a conversation the user is not looking at, which is not recoverable. A
  review handoff has no `harnessSend` to re-issue, so the composer's next send
  falls through to an ordinary first send (which creates its own session and
  cannot misdeliver either) while the narration's own Retry re-runs the handoff.
  The live card is matched to its send by `clientRequestId`
  (`provisionCardOwned`) and stripped from every non-staged transcript
  (`sessionMessages`), so it cannot render over another conversation.
- Session metadata is claimed when a runtime is acquired, before any prompt, but
  that claim is not a conversation: ordinary pi and Claude SDK rows with zero
  native message entries stay out of the session list. In particular, archiving
  or deleting the viewed session detaches it and returns to the client-staged
  new surface; it never mints the prompt-less replacement sessions that used to
  survive restarts as **New chat** rows. Migration 0052 tombstones those
  historical zero-message pi bootstraps. A first send becomes listable as soon
  as its native prompt is appended; Claude SDK persists that user entry and
  invalidates the list at acceptance rather than waiting for auto-naming or a
  potentially long first turn to end. The explicit `createDraftSession` flow is
  the exception: its metadata purpose is `draft`, so the row remains reachable
  (with the existing bootstrap count of one for routing) while the user edits
  the as-yet-unsent prompt. The archived count uses the same listability rule as
  the archived rows it describes.
- While that send is out, the surface is an OPTIMISTIC SESSION SHELL
  (`lib/newSessionShell.ts`, Task-448): the header keeps the staged identity
  (provisional title, model, worktree/project, no fingerprint for an id that
  does not exist), a phone gets that header where an idle new-session screen has
  none, and one narration says what the bootstrap is doing. The staged
  transcript is `stagedTranscript`, which also owns the handoff: the created
  session's durable echo reconciles the optimistic row one commit BEFORE the
  armed advance moves the URL, so once the staged rows settle the shell adopts
  the live ones rather than blanking the prompt for a frame. It adopts them only
  on `landed` — the viewed session is absent from the arm-time snapshot, so it
  is the one this send created — never on the weaker "not the session we left".
  Any pre-existing conversation can drift into view mid-bootstrap, and adopting
  one would paint its rows AND its identity (`displaySession` →
  `displayCurrentId` → the header) under `/sessions/create` while the router
  correctly keeps the URL still. Where the evidence is missing the surface shows
  the staged rows it has and nothing else; the optimistic echo itself may not
  survive that event, because `optimisticForSnapshot` prunes an echo whose
  session is not the non-empty snapshot's — which leaves the staging surface
  empty behind its narration, never somebody else's conversation.
- Staging a Task ALWAYS resolves the worktree it is being worked in, through
  `lib/worktrees.ts`'s `worktreeForTask` and `App.tsx`'s one `worktreeIdForTask`
  wrapper — never a rule re-implemented per surface. `stageTaskContext` (the
  quick-start's Task row, the composer's context sheet) stages a derived
  worktree but never CLEARS one, since picking a Task must not undo a worktree
  the picker's own field set; `startSessionForTask` (the Task page and
  inspector) stages or clears, because it starts from nothing. Both go through
  `stageWorktreeContext` rather than the bare setter, so the Developer↔worktree
  coupling applies identically wherever a Task is staged. `sessionListRef`
  supplies the sessions for rule 2 so the callback stays stable across list
  broadcasts.
- Starting a session IN a worktree resolves the other direction the same way:
  `startSessionInWorktree` stages project, worktree AND the checkout's single
  Task through `lib/sessionHandoff.ts`'s `sessionContextForWorktree` (the rule
  the two review handoffs already share), so "new session" on a worktree card,
  its shelf row or the object dock lands with the context the work already has
  rather than a bare checkout. Ambiguity stages no Task, and the same
  `sessionListRef` sessions feed its session-claim rule.
- `navigateFromInspector` is the ONE way App navigates from inside the object
  panel (inspector relation openers, and the links its section children render —
  Task project row, calendar day report/task, the memory manager): on mobile it
  collapses the dock first, so the result is visible instead of hidden behind
  the sheet. The `Inspector` frame applies the same rule to its own
  relations/actions via `InspectorChromeProvider`'s `onAct`.
- `openBacklogRowLink` is the matching one-way-in for a Backlog row's second
  line (`components/TaskRowBody.tsx`): those links name a Task, a session, a
  worktree or a Project and each carries its own route, so App hands the list
  ONE stable handler for all four rather than four openers. It warms a session
  timeline when the path is a session's, because the row's gutter does — the
  chip and the button lead to the same place and must not arrive differently.
- On small screens the object dock is the object's single action home, so
  `App.tsx` stops rendering each page's header actions there and passes them to
  the inspector assemblies instead (see `components/CLAUDE.md`).
- `routePrimaryAction` is what the object on the current route leads with, built
  ONCE per route here (Task, Project, Worktree, Knowledge entry; null for
  everything else, session screens included — their primary act is the
  composer). It feeds the dock row's last slot, the wide page header's cluster
  and, through `shell/RoutePrimaryAction.tsx`, the panel's decision to hoist its
  own `primary`. Three places used to define the same action and the header had
  none, which left it reachable only through a panel the reader may have closed.
- Sending comments is ONE path per domain, owned here. A document's tray
  (Knowledge entry, host file) goes through `sendDocumentComments`, which moves
  it into the chosen session's composer (or the new-session draft) and follows
  it there; a refused move is returned to the tray to report in place. The dock
  action row's last SLOT carries **Send comments** (badged with the pending
  count) while a tray holds some, and otherwise the object's primary action —
  **Start session with this file** on a document. A WORKTREE screen's row
  carries **Submit review** through `submitWorktreeReview` and
  `worktree/worktreeReview.tsx`'s pending helpers. Its inspector action is
  domain-owned by `worktreeInspectorActions`; Add comment remains shell-owned.
  The worktree's comment roster itself lives ONLY in the object panel
  (`WorktreeReviewSection`) — there is no second roster on the page. Following a
  roster row is cross-pane: `openWorktreeComment` collapses the dock sheet on
  mobile and hands `WorktreeDetailPage` an `{ commentId, nonce }` token via its
  `openComment` prop, and the page (which is where the comments are loaded, so
  it alone can resolve which file a comment currently lives in) does the actual
  scroll-and-flash. There is a THIRD, differently-shaped review flow, and it is
  deliberately NOT a third instance of this pair — do not merge them: `/review`
  (and the session inspector's "Review this session's work") is the OPPOSITE
  DIRECTION of the same loop. "Submit review" means MY COMMENTS go to an agent,
  carried as a structured server-built comment bundle; `/review` means AN AGENT
  reviews the work, and it is `startReviewSessionForSession` — a plain
  new-session handoff whose only payload is one editable draft sentence naming
  the source session (`lib/sessionHandoff.ts`'s `buildSessionReviewPrompt`;
  nothing structured is staged or persisted for it). The Pull Requests view's
  Review (`startPullRequestReviewDraft`) is the same shape as `/review` and
  deliberately not a fourth mechanism: once `POST /api/pull-requests/checkout`
  reports the checkout, it stages that worktree, its project and the derived
  Task and puts `buildPullRequestReviewPrompt`'s draft in the composer WITHOUT
  sending it, so runtime, persona and the text stay the user's.
  `startReviewSessionForSession`, `startPullRequestReviewDraft` and
  `startWorktreeReviewDraft` resolve the Task/project/persona a review session
  inherits through `lib/sessionHandoff.ts`'s shared derivation rule (origin
  Task, then a single claiming Task, then the worktree's Task — ambiguity
  attaches nothing), so the Task context injection and the Task trace work in
  both directions; only the prompt assembly stays separate, because a comment
  bundle is structured context and the review instruction is one sentence. The
  two directions already compose in sequence, which is why they must not be
  combined into one flow. When `/review` runs from the chat composer,
  `runClientSlashCommand` lands that draft in the SAME `Composer` instance the
  command was typed into (the page swaps the transcript above it, not the
  composer itself), and `startStagedSession`'s `flushSync` commits the staging —
  draft effect included — inside the `onClientSlashCommand` call. A client slash
  command therefore returns with the composer already showing its prompt: the
  composer clears the command text BEFORE handing over and never after
  (`components/Composer.test.tsx` pins it), and any future client command may
  rely on that. Like every fresh staging entry point it stages
  `newSessionRuntimeDefaults` — Build, never the mode of whatever was staged
  before: `startStagedSession` takes `mode` as a REQUIRED (possibly undefined)
  option so each call site states it, only a restage for one axis (model,
  thinking, persona, account) passes the record's own mode on, and the
  route-identity effect strips the staged mode when the staging surface is left
  (a pi first send leaves `pendingStart` behind — the server mints its own id —
  so without that a Plan came back on the next landing). A fresh entry point
  that reaches the restage helpers instead of staging directly passes
  `{ fresh: true }` through `stageWorktreeContext` → `switchStagedAgentType`:
  `startSessionForTask` clears `pendingStart` and then stages the Task's
  worktree, and those helpers read the render's record — the one just cleared —
  so without the flag the `flushSync` restage wrote its Plan back after the
  clear and compared the persona coupling against the wrong persona.
- On small screens `inspectorOpen` means the object dock is EXPANDED, not that a
  pane is open: `App.tsx` decides which screens get a dock at all
  (`dockCarriesBack` — every object screen except Settings and Usage, which have
  nothing to inspect) and fills the dock's action row per route with
  `shell/ObjectDock`'s `DockAction`: back leading, then the object's primary
  action trailing ("Start session" — the same action the inspector leads with,
  which the dock then hoists OUT of the sheet's Actions list so it is not
  offered twice). Calendar resolves its own title inside its inspector, so its
  primary action stays in the sheet's list and its row carries back alone; a
  Knowledge ENTRY route now fills its row instead (see above), and the dock
  hoists the primary out of the sheet's list automatically whenever a row has
  actions. A TASK route's row also carries the status control (`TaskStatusIcon`
  as its face, cycling on tap): it is the thing you most often open a Task to
  change, and the page's own title block therefore shows the state without
  offering to change it — one control, in the action home.
- A SESSION screen's row is `components/SessionDockActions.tsx` — the bottom bar
  the composer used to collapse into, dictation included, and shaped like the
  composer it rests as: a bordered field bookended by two controls a side, so it
  always `fill`s the row. App supplies only the route-dependent halves of those
  clusters — one `contextSlot`, resolved in that order: the staged-context sheet
  while `showContextPicker` says a session has not been sent yet (a
  `contextSheetRequest` token bump, the same sheet the composer's `+` opens),
  else `dockSessionContext` (the tier order is `lib/sessionDockContext.ts`,
  tested there; App only maps it to navigation and reads the dirty flag), else
  `attachFromDock`. What has to cross between the row and the composer is
  `composerDraft` (the unsent draft on the field's face — the composer reports
  it only while hidden, so typing never reaches App), `attachComposerRef` and
  `submitComposerRef` (the paperclip's picker and the row's Send, live refs like
  `openComposerRef` — the draft itself never leaves the composer, so sending has
  to reach in), `dictationRequest` (the expanded composer's mic hands over
  rather than recording in place, so there is one recorder — a HELD request the
  row consumes and clears, not a token bump, because closing the composer is
  what mounts that row, so a "changed while mounted" token was always seeded
  with the new value and never fired), `dictationActive` (the recording lives
  inside the field, so the row keeps its controls, but `peek.expandBlocked`
  shuts the sheet — nothing may cover Stop), and `dictationTranscript` (the
  finished text, handed to the composer as a token prop and inserted at the
  caret it remembered). Peaks never cross: they live in a ring buffer the
  waveform reads itself, and routing them through App would re-render the
  transcript ~40x a second. `composerOwnsBottomEdge` then suppresses the dock
  entirely while the composer is up — the bottom edge is one slot, so the phone
  shows the card or the composer, never both. `openComposerRef` is a LIVE
  callback the composer assigns (not a token): the row's field has to focus the
  textarea inside its own tap or iOS keeps the keyboard down, and it collapses
  the sheet first because composing replaces the surface the sheet is covering.
  `draftAutoFocus` is desktop-only for the same reason the row exists: on the
  new-session screen an autofocus would throw the keyboard over the quick-start
  rows before anything is picked.
- Whether a mobile surface renders a page header at all is App's call, per
  `../docs/ui-shell.md`: a phone header has to say something the content does
  not. A Task route's header is `density="compact"` too, but its identity is the
  ID (`Task-123`, glyph copies it) rather than the title — the title moved into
  the page body so it can wrap in full, and that page's header is the same shape
  at every width. A Worktree route is the same shape too — the branch, with the
  glyph copying the checkout path. A Project route is the same shape and, being
  a short name, keeps it in that row behind the key (`PD - Pandeck`; the glyph
  copies the key) rather than pushing it into the body. That page's header is
  identical at both widths because ALL of its object actions moved to the panel
  (`ProjectInspector` takes `onSave`/`onArchive`/`onDelete` on desktop too,
  hence no `mobile` prop): rename is the only thing left in the row. On a
  session route it is `density="compact"`: one 44px row of persona glyph +
  title, no subtitle (the plan/tools counts it carried are in the dock sheet's
  Tasks and Tools sections, with the actual lists), and the glyph becomes the
  copy-session-id control that used to be a fingerprint in that subtitle.
  `chatHeaderHidden` drops the header entirely on the new-session route — the
  title restated a visibly new session, the subtitle described a session that
  did not exist yet (down to a Copy session ID for a draft), and back had
  already moved to the dock's row. Wide layouts keep every header, since the row
  also carries the controls the dock takes over on a phone.
- Back is defined ONCE (`backToSection`) and rendered in one of two places: the
  dock's action row where a dock exists, or the surface's own header via
  `screenBack`, which is therefore `undefined` exactly when the dock carries it
  — that is what keeps the two from both drawing a back arrow. `PageHeader` then
  falls back to the screen's own leading control or icon box, so an object
  screen with a dock shows its type glyph again.
- Every hook in `App.tsx` must sit ABOVE the `showLoadingShell` early return.
  App renders that shell until the first snapshot hydrates, so a hook added
  below it changes the hook count on the very render that hydrates and React
  tears the tree down (error #310, blank app) — a fresh browser profile hits it
  every time while a warm one may not.
- `App.tsx` also owns the small-screen screens model (`../docs/ui-shell.md`,
  Small Screens): `isSectionIndexRoute(route)` + the mobile flag decide whether
  the left panel renders as the browser SCREEN (`mobilePresentation: "screen"`,
  no dismiss) or the main pane shows an object screen, and it builds the ONE
  `PageHeaderBack` (`screenBack`) every main-pane surface renders. Back targets
  the SELECTED section's index route (`sectionIndexPath(sidebarSection)`), never
  `history.back()`; section selection stays UI state, so only the browser's
  visibility is route-driven. On mobile a nav-bar tap navigates to the section's
  index route, and reaching the browser screen closes the object dock (a browser
  screen has no main-pane object to inspect). No route ever forces the sidebar
  open and no navigation "closes" it: the pre-Task-194 `sidebarRouteForced` pin
  on `/sessions` and the `/tasks`→`/`, `/worktrees`→`/` navigate-away redirects
  are gone, so every section index route stays addressable. Index routes reveal
  their section and, on desktop, open the sidebar panel (which is also what
  restores the browser when a phone rotates into the three-pane layout). The
  panel toggles only exist on desktop, in what is left of the app header.
- `main.tsx` and `index.css` own React bootstrapping and global styles.
- `index.css` is the SOLE owner of typography (Task-184): the two system font
  stacks (`--font-sans`/`--font-mono`), the six semantic size roles and their
  paired unitless line heights (`text-micro/caption/body/prose/heading/title`,
  defined as `calc(rem * var(--text-scale))`), the `--text-scale` mapping, the
  scaled `body` baseline, editable-control sizing, Markdown/Shiki/JSON/ANSI
  typography, the code-block gutter/wrap classes (`cb-numbered`/`cb-wrap`), the
  `.tool-code*` native-tool-body shell (deliberately NOT nested under `.shiki`,
  whose blanket `span` colour rule would beat the per-row diff colours), and the
  supported Pierre host custom properties. Components SELECT roles but never
  define font-size/line-height values. First-party production code must use only
  the six role utilities — no arbitrary (`text-[12px]`) or generic (`text-sm`)
  Tailwind sizes, no direct `font-size`/inline `fontSize`, no component
  `leading-*` overrides. `typographyAudit.test.ts` enforces this in the normal
  test run.
- Text size is a browser-local preference (`usePrefs.ts` `textScale` ∈
  100/110/120/130, default 100, normalized via `normalizeTextScale`), persisted
  in `localStorage["assistant.prefs"]`, applied as the root `data-text-scale`
  attribute before first paint (bootstrap in `index.html`) and on change
  (Settings → Appearance). It scales typography ONLY — not spacing, geometry, or
  persisted pane widths — and has no cross-tab `storage` listener (other tabs
  adopt it on reload).
- The sidebar's nav-bar order is a browser-local preference (`usePrefs.ts`
  `navSlots`, defaulting to `DEFAULT_NAV_SLOTS` and normalized on read by
  `normalizeNavSlots`: unknown ids drop, and a slot the user has never seen is
  inserted at its DEFAULT position rather than appended, so a newly added action
  is not born behind More), edited in Settings → Appearance. It is local rather
  than server-backed because the useful order differs between a phone overlay
  and a resizable desktop panel. That bar carries the app-level ACTIONS as well
  as the sections (`NAV_ACTIONS`: New Session, the Personal Assistant, Usage):
  `App.tsx`'s `runNavAction` just navigates and leaves the selected section
  alone, and the app header they used to live in is gone on small screens
  entirely (`header={mobileLayout ? undefined : <Topbar/>}`, and the shell then
  owns the top safe-area inset).
- Where the transcript SITS is not App's business, with one exception: App owns
  `pinTranscriptToBottom`, the token that says this browser submitted (every
  path through `sendPromptWithRuntime`, plus answering an agent question), and
  the transcript follows its own answer to the end from wherever the reader was.
  It is a token rather than something the transcript could notice by itself,
  because an attachments-only prompt echoes no optimistic row. A pull-request
  card's Update-with-main is the deferred case: the submit it may turn into is a
  rebase prompt that lands seconds later, so `runPullRequestCardAction` records
  the intent per card in `rebaseHandoffPending` and spends it when that card
  reports `rebaseHandedOff` — the clicking browser only, and only if the rebase
  actually reached the agent (`docs/pull-requests.md`). Everything else —
  following streamed content, remembering where reading stopped, restoring it on
  return — belongs to `hooks/useTranscriptScroll.ts`; `previewInteracted`
  survives only because it also gates the MESSAGE merge
  (`preservePreviewMessages`), which is a different question from where the view
  rests.
- The chat transcript's display flags live in `components/transcriptView.ts` as
  ONE `TranscriptViewPrefs` object; `App.tsx` memoizes it and applies changes
  inside `startTransition`. Do not thread these as separate booleans again —
  every message row is memoized, and a long transcript pays per-prop comparisons
  and interruptible-work loss for it.
- EVERY prop `App.tsx` hands the transcript must be referentially stable while
  its content is unchanged, and that is a performance CONTRACT, not a nicety.
  Message rows are memoized and `Markdown` is memoized on its props; breaking
  either re-runs the whole remark → rehype → sanitize pipeline for every message
  on screen — measured at ~0.8 ms per body on a warm desktop, so a 200-message
  chat is ~160 ms of main-thread work, several times worse on a phone. The
  session list is rebroadcast up to ~4x/second while any agent runs, with
  brand-new row objects every time, so a prop derived from it will churn unless
  gated. `paObjectReferences` (here) and the transcript's `sessions` (in
  `components/MessageList.tsx`) are therefore memoized on content keys from
  `lib/transcriptKeys.ts`, and callbacks like `openPaObject`/`openTaskById` are
  `useCallback`s rather than inline arrows — an inline arrow defeats every
  memoized row unconditionally, on every App render. Adding an unmemoized prop
  to `<MessageList>` silently undoes all of this: nothing breaks, the chat just
  gets slow whenever anything else in the app moves.
- Broadcast topics come from `lib/broadcastTopics.ts`, and App only supplies the
  surface state: the main pane's ROUTE always subscribes, the selected sidebar
  SECTION only while `sidebarPanelOpen` (its browser is on screen). Section
  selection deliberately survives navigating to an object, so deriving topics
  from it alone left a phone in a conversation subscribed to
  Tasks/Projects/Worktrees with no sidebar rendered — the exact traffic the
  subscription protocol exists to stop. A Projects index/browser subscribes only
  to Projects + Worktrees; selecting a Project adds Tasks + Workflow for the
  embedded Task section. App passes the rendered settings section too, which is
  the only thing that subscribes `skills`.
- `useAssistant` keeps the canonical Project registry as lean summary rows plus
  revision sidecars, and full documents as a bounded per-id `LoadState` cache.
  Summary events reconcile one row at a time; a newer summary refreshes only
  that id's retained detail, while route keys prevent editor/collapse state from
  crossing from one Project to another. Failed writes recover only their touched
  summary ids and the affected open detail; attempted editor drafts never enter
  the authoritative detail cache. Canonical full snapshots reset digest/sequence
  bookkeeping, while filtered list replies do neither.
- PR/CI is the one piece of app state that does NOT come over that socket: App
  polls the per-worktree map once for the whole app
  (`hooks/useWorktreeHosting.ts`) and hands it to every two-line Backlog list,
  and polls the pull-request inventory once (`hooks/usePullRequestInventory.ts`)
  for the Pull Requests browser and its detail page. It answers the same surface
  question as topics do, through `lib/worktreeHosting.ts`'s `hostingSurfaces` —
  app-level state is not a licence to poll a provider for a window parked on a
  conversation. App supplies what only App knows: whether a project's PAGE is
  open (the projects index has no Tasks section) and whether the sidebar's Task
  rows have a second line at all (`taskRowsHaveMeta` over
  `SIDEBAR_BACKLOG_DENSITY` and the view — since that browser went two-line at
  both sizes, its answer is yes whenever the Tasks section is the one on
  screen).
- Uncommitted changes reach those same rows the other way round — they ARE
  socket state — but never as `state.worktreeStatuses`. App derives ONE list
  first: the worktrees the loaded Tasks have work in (`taskWorktreeIds`, while
  `hostingSurfaces` says a two-line Backlog is on screen). That list is both
  what App holds git-status watches for (`hooks/useWorktreeWatches.ts`) and the
  scope of the dirty set it hands the Backlog (`hooks/useDirtyWorktrees.ts`), so
  a push about file counts, a moved HEAD, or a worktree no row shows stops at
  the memoized list instead of repainting every row. The watches are App's
  rather than `Sidebar`'s because the SAME rows are also on a project page: a
  phone with the sidebar closed would otherwise show markers nobody was keeping
  current.
- App holds THREE such watch demands — the Backlog's worktrees, the open
  worktree route, and the worktree the viewed session runs in — and every one of
  them goes through `hooks/useWorktreeWatches.ts` onto the shared refcounting
  registry, as do `Sidebar`'s. The Projects browser reports its actually
  rendered Worktree rows back to `Sidebar`: collapsed descendants are neither
  leased nor included in its status projection, and relation sessions are
  content-stabilized. They overlap constantly (the session you are in is usually
  a Task's worktree and is usually listed in a browser), and the wire cannot
  tell two demands apart: whichever surface released first used to end the watch
  for the rest. Never call `actions.watchWorktree` from a surface —
  `worktreeWatchAudit.test.ts` fails on it.
- The left pane is MEMOIZED and App keeps it that way. `Sidebar` re-renders only
  when its own props move, so App hands it stable `useCallback` handlers
  (`openSession`, `openCalendarView`, `openProject`,
  `openKnowledgeEntry`/`openInvalidKnowledgeEntry`/`openKnowledgeFile`,
  `openSettingsSection`, …), memoized `projects`, and `backlogState` — the
  narrow `hooks/useBacklog.ts` slice — instead of the whole `UIState`. Without
  that, every streamed transcript token (rAF-batched, so up to ~60/s) rebuilt
  the Backlog's ~220 Task rows, measured at 6.3 ms per rebuild on a warm
  desktop. Adding an inline arrow or a whole-state prop to `<Sidebar>` silently
  restores that cost.
- The same rule now covers the SIDEBAR's session rows, which are memoized on a
  content key (`lib/sessionRows.ts`, `components/CLAUDE.md`): `openSession`,
  `archiveSession`, `confirmDeleteSession` and `openTaskById` are `useCallback`s
  that read the session list through `sessionListRef` instead of depending on
  `state.sessions` — a dependency on the list would give every row a new handler
  identity on each broadcast, which is exactly what the memo exists to survive.
- The Pull Requests browser does NOT read that hot session list: its rows come
  from the polled inventory, so a session broadcast cannot invalidate one. Its
  rows are still `memo`ized with id-taking handlers, on the same rule every
  memoized row follows.
- `uiLoadScenario.test.ts` is the repeatable load scenario the performance work
  is defended by: ten parallel streaming sessions and a 2000-entry transcript,
  driven through the REAL reducer and the real identity keys. Every assertion is
  a COUNT — transcript rows replaced per streamed token, sidebar rows
  invalidated per session broadcast, rows mounted for a long transcript, cache
  writes per broadcast burst — never a duration: those counts are what each fix
  actually moved, they are the same on a laptop and on a throttled phone, and a
  wall-clock budget would only go flaky on a loaded CI runner. Add to it when a
  new surface starts reading a hot slice; `components/PerfHud.tsx` is the
  interactive counterpart for numbers a test cannot take (real bytes on the
  wire, real commits).
- `transcriptRedrawScenario.test.tsx` asks the same question one level down, of
  the whole mounted app rather than the reducer: what the browser is actually
  told to CHANGE. It boots `App` against a scripted socket, opens a 40-row
  transcript, and counts DOM mutations inside rendered rows — zero for a session
  broadcast that only re-sorts the list (the steady state while any agent runs),
  and only the streaming row for a token delta. A mutation inside a row throws
  away what that DOM held: the horizontal scroll of a wide code block being
  read, a selection, a lazily highlighted `CodeBlock`. Restoring it afterwards
  is not the fix — the two ways it was being thrown away were `Markdown`
  rebuilding its element types (`components/Markdown.tsx`) and the reference
  keys treating a re-sort as a content change (`lib/transcriptKeys.ts`). Its
  second half counts RE-RENDERS, through the app's own `lib/perfStats.ts`
  counters (the ones the dev HUD reads, so a developer watching the HUD and this
  test are looking at one number): an unrelated broadcast, and a streamed token,
  re-render neither the composer nor a single `TurnStatsRow`. Both used to. The
  composer is memoized for it, which makes each of its ~35 props a stability
  contract — only four were not already stable, and `onSend` is the one that
  travels over a ref because a send reads too much of the render to enumerate.
  The stats rows are memoized against entries that `MessageList` holds across a
  recompute (`reuseStableTurnEnds`), because `accumulateTurnStats` rebuilds a
  `Turn` for every completed turn on every streamed token. Its "link references"
  pair covers the other direction: a session being NAMED — which the server does
  from the first prompt of every session anyone starts — re-rendered all 120
  rows of the measured transcript, because the link reference lists were built
  from the whole session/Task/project/worktree inventory. They are narrowed to
  what the rendered text mentions (`lib/transcriptKeys.ts` documents the two
  scans), and the second test names a session in a message so a filter that
  dropped everything cannot pass as a fix. Measured in a real browser against
  the running server, a streaming turn costs one `App`, one `MessageList` and
  one `MessageRow` render per arriving event, and nothing else; the composer
  re-renders only when `contextInfo` moves, which is its own data.
  `components/PerfHud.tsx` (Ctrl/Cmd+Shift+P in dev) is how to read that live.
- `hooks/`, `lib/`, and `components/` have child contracts.

## Contract notes and rationale

- `useAssistant` is the central reducer/effect layer for WebSocket protocol
  state; avoid duplicating protocol state elsewhere.
- Use shared protocol/runtime/session types rather than local wire duplicates.
- Clean up timers, subscriptions, and browser event listeners in React effects.
- Routes are canonical per `app/web/docs/ui-shell.md`: one shape per object type
  plus section index routes (`/sessions`, `/tasks`, `/projects`, `/worktrees`,
  `/knowledge`, `/calendar`, `/settings` — a bare `/settings` is the INDEX, not
  a shorthand for the first section), no aliases. An index route must render a
  real main-pane surface with a page header rather than falling through to the
  chat surface: the router does not own the chat URL there, so a prompt sent
  from it would leave the address bar behind. Path building/parsing lives in
  `hooks/useSessionRouting.ts` and `lib/sessionRoutes.ts`; the server learns a
  deep-linked session only via the WebSocket `sessionId` query parameter. The
  cached transcript in `lib/sessionPreviewStore.ts` is read ONCE, for the route
  the app booted on, and `App.tsx` holds that route's identity in a ref it
  SPENDS (`spendBootRouteIdentity`) the first time the route changes — a ref
  rather than state because a frame of lag there is a frame of the wrong
  transcript. Every session reached by in-app navigation, the boot one included,
  therefore clears the stage and waits for its snapshot, which is R3 and is
  written up in `app/web/docs/loading-states.md` § The chat stage. While that
  boot preview is displayed, `App.tsx` preserves its stable prefix but merges
  any newer in-memory transcript rows via `lib/sessionPreview.ts` so a stale
  cached prefix never hides live results. Cached previews and the merge exclude
  transient rows (`isTransientMessageId`: the streaming pseudo-row `"live"`,
  optimistic `creq-*` prompts) — the streaming id is CONSTANT across turns, so a
  mid-turn preview anchoring on it would truncate the merged transcript to the
  stale prefix for the whole next turn.

## Working notes

- Preserve optimistic session/prompt reconciliation behavior when changing chat
  flow.
- Keep UI chunks reasonable by lazy-loading heavy pages/components.

## Verification commands

- Run `pnpm --filter @assistant/web build` for this subtree.
- Run root `pnpm run build` before closeout.
