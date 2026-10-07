# Web components — implementation reference

Relocated from `app/web/src/components/CLAUDE.md` (Task-274) so it stops costing
agent context on every visit. This is a descriptive snapshot of what the modules
in that subtree own; the rules an agent must not violate stay in that folder's
`CLAUDE.md`. Correct or delete a section here when the code moves on. Relative
paths in the body are relative to the original subtree.

## Purpose

React components for the assistant UI: shell chrome, chat messages, composer,
settings, backlog/tasks, project pages, rich tool cards, and reusable widgets.

## Module ownership

- `PageHeader.tsx`'s trailing cluster is shell-owned on wide layouts: Add
  comment (disabled until the surface has a target) and then the primary SLOT —
  the route's primary action (`shell/RoutePrimaryAction.tsx`), or Submit review
  badged with the count while comments are pending. A phone renders none of it
  (`hidden md:flex`): the object dock's action row draws the same pair there.
- `Composer.tsx` owns both the prompt draft and the separate, transient
  chat-comment draft. `MessageList.tsx` captures transcript anchors and hands
  them to that one composer; it never renders a floating comment editor. On
  phones the dock's Send slot becomes Comment while a selection is live, with
  recording taking precedence over the selection field. Comment mode covers an
  EXISTING pending comment too — selecting one (`chatComments.activeCommentId`,
  set by the chip's edit action or by tapping its highlight in the transcript)
  loads it into the same field — and while it is on, the prompt's own controls
  are not rendered: no attachments, staged context, runtime strip, branches,
  context meter or Add comment, because a comment carries none of them. The
  trailing cluster then reads cancel, delete (an existing comment only) and
  save, and Enter/Shift+Enter behave as they do for a prompt. The measured
  `data-composer-fit` boxes stay mounted through it so the runtime fold does not
  re-decide itself on the way in and out.
- `ComposerLedge.tsx` is the composer's RESTING strip: a shelf on the card's top
  edge for session state that stays put while the conversation goes on, where
  `ChatDockPanel` is for a control opened on demand and dismissed. Inset like
  the dock panels and drawn behind the card the same way, but in normal flow
  rather than absolute, so it pushes the composer up and the transcript's inset
  accounts for it. `Composer.tsx` renders whatever its `ledge` prop holds in it,
  `joined` to the card while the card is visible and standing alone as the
  bottom edge while a phone has hidden the card over the dock's action row. It
  has no close button because it does not go away: the host mounts it only while
  there is something to say. It holds a STACK of strips, hairline-separated
  (`divide-y`), so two shelves never read as two cards floating over the
  composer: `SpawnedSessionsLedge.tsx` on top and `BackgroundWorkLedge.tsx` on
  the bottom edge, in that order deliberately — a session that starts delegating
  must not push the background line the user was already reading. See both
  below.
- `ChatDockPanel.tsx` owns the composer-width panel that slides up from the chat
  box (title bar with optional compact actions, minimize, close, Escape). It is
  anchored (`bottom-full`) to a box in `Composer.tsx` that holds only the ledge
  and the card, never to the whole shell: the shell also reserves the fixed
  send-blocked hint slot above the card, and a panel anchored above THAT sat a
  slot's height away from the card on a phone, which is exactly the join it
  exists to make. It takes focus itself one frame after opening, because it is
  usually the surface just opened; a panel opened as CONTEXT for the composer
  below it passes `focusOnOpen={false}`, which is what the KB entry viewer's
  docked comment composers do. Without that the panel steals the caret from the
  field a frame after it was focused — invisible on a fast machine, and on a
  phone it closes the keyboard the edit/reply action just raised.
- `ChatCommentChip.tsx` is the LIST of comments waiting to ride with the next
  prompt: a count in the header, and expanded, one row per comment — one line of
  the comment (never the quote, which is highlighted in the transcript and is
  what the row navigates to via `onReveal` → `App`'s `messageFocus`), the whole
  text on hover, and ghost edit/remove actions. Edit hands the comment to the
  composer rather than opening an editor here; a second place to write the same
  comment is one too many. **Remove all** lives at the BOTTOM behind a confirm
  step: as a bare ✕ in the header it sat one tap from the control that collapses
  the panel, and it destroys work that no single row can bring back.
- Top-level component files own feature pages/cards used directly by `App.tsx`
  and message rendering.
- `MarkdownFile.tsx` owns how a Markdown FILE renders in a document viewer (host
  file, artifact, worktree preview): `lib/markdownFrontmatter.ts` splits the
  frontmatter off on the file's own line numbers, a compact header shows it, and
  the body goes to `Markdown` with the caller's props unchanged.
- `Markdown.tsx` owns shared chat/prose Markdown rendering. `density="compact"`
  is the same prose one size down (`.prose-compact`) for text that sits INSIDE
  another surface rather than owning the column — what `common/CommentBody`
  renders a comment at. It also carries title-inferred `pa://` app-object links
  from compact reference metadata, an optional `onResolveUrl` hook for rewriting
  relative link/image URLs (e.g. KB entry-local `assets/...` paths), and opt-in
  source-line stamps for rendered KB selection anchoring; chat rendering leaves
  those stamps off. Raw HTML is rendered app-wide via `rehype-raw` and then
  sanitized via `rehype-sanitize` (GitHub default schema widened only to keep
  the app's internal link schemes `pa`/`pi-session`/`pi-workspace-file`) — so
  content may use inline HTML like the history diff's `<ins>`/`<del>` marks
  while scripts, event handlers, and unknown-scheme URLs are stripped. Do NOT
  disable the sanitizer or render untrusted HTML by another path. A `chart`
  fenced code block routes to the lazy `common/ChartBlock.tsx` Chart.js renderer
  (Task 139) — a constrained bar/line spec with an always-available accessible
  data table, degrading to a plain data block on a malformed/oversized spec. A
  Markdown LINK whose source is a file the app serves
  (`/api/files/<absolute path>` or `/api/session-artifacts/…`, the URL forms
  `config/prompts/chat-files.md` tells agents to write) stays a link into the
  in-app viewer, and an IMAGE stays a chrome-free embed: syntax states the
  intent, so neither becomes a card. Cards come from structured tool output —
  `show_files` (`tools/registry.tsx` → `ServedFileCard`) — loaded from the
  origin+token URL, since a bare API path would resolve against the web origin
  without a token. An image enlarges into `common/ImageLightbox.tsx` on click;
  an HTML document runs in `SandboxedDocument`; a Markdown or text file offers
  the `/files/...` viewer route (`docs/served-files.md`). Every other image is
  left exactly as authored, so KB entry assets and external images are
  unaffected (Task-636). The element types it maps (`MARKDOWN_COMPONENTS`) and
  its `urlTransform` are fixed at module scope, and everything per-instance —
  the session/file/`pa://` lookups and the open handlers, the latter behind a
  ref so an inline caller arrow costs nothing — travels through
  `MarkdownRenderContext`; the rendered `ReactMarkdown` element is itself held
  until `text` or the remark plugins change. Together those make a re-render a
  reconciliation of the existing DOM rather than a rebuild of it, which is what
  a wide code block's horizontal scroll, a live selection and the lazily mounted
  `CodeBlock`s inside it depend on.
- The Knowledge Base has no browser of its own: the `/knowledge` route and the
  right panel's Knowledge tab draw `worktree/WorktreeDetailPage.tsx` for the
  checkout `knowledge` (`lib/knowledgeCheckout.ts` builds its record), with
  `lineComments={false}` and `markdownPreviewFirst`. `KnowledgeInspector.tsx` is
  the route's inspector: the uncommitted-file count and "Commit changes…".
- `KnowledgeEntryToolCard.tsx` renders the `kb_show` card: the file an agent is
  pointing at, with the two ways to read its `index.md` (the Knowledge panel, or
  the `/knowledge/files` route). It reads its open targets from
  `KnowledgeOpenTargets.tsx`, a context the shell publishes, because the
  transcript renders in both the main pane and the Personal Assistant panel and
  neither threads Knowledge navigation through `MessageList`. The side-panel
  target is absent on small screens, where that panel does not exist, and the
  card then offers the route alone.
- `TaskStatusIcon.tsx` owns the Backlog's circular status glyph
  (`TaskStatusIcon`) and the three status labels (`TASK_STATUS_LABEL`). Its
  `claimed` flag paints the SAME shape amber when an agent has suggested a
  status: a pending suggestion is a statement ABOUT the status, so it belongs on
  the glyph rather than beside it — the shape still says where the Task stands
  and the colour says that it is disputed. That is what keeps a suggestion
  visible in the tree view, which cannot ask the question (the Focus view's
  review bucket does) but must not hide it either, and it cost the row no new
  item so soon after every trailing badge was removed. ONE implementation,
  because it is read as a state in the Backlog rows, the Task detail's title
  block and the object dock's status action alike — it was duplicated in two
  files — and because it doubles as the face of the control that cycles status,
  so what you look at and what you press are the same thing. It lives outside
  the lazy Task page on purpose: `App.tsx` needs it for the dock's action row.
- A Backlog ROW is status glyph · title, with the `#id` and what is going on
  with the Task on the line underneath. `TaskIdBadge.tsx` LEADS line 2 in every
  two-line view: monospace and `tabular-nums`, so the ids read as a left-hand
  column you scan rather than a value that moves with the title, and first
  because line 2 clips from the right and the id is the one item on it that may
  never be what clips. Line 1 is then the title and nothing but FIXED-width
  controls (a hover Archive button, the gutter), which is what makes the title
  as long as the row is wide — on the rail, where it was truncated to a few
  words, that is most of the change. A `tight` single-line row is the one shape
  that keeps the id (and the project chip) up beside the title, having no second
  line to move them to. The id earns its width where a number nobody acts on
  would not: it is the handle you type into a prompt, a commit message or a
  `pa://task/124` link, so a list that hides it makes you open a Task to find
  out what to call it. Its tooltip carries the canonical `Task-124` form the
  detail header copies, and given a navigator it is also a real LINK to the Task
  — an `href`, so it can be opened in a tab or copied. `BacklogTreePane.tsx`
  dropped the trailing metadata cluster it used to carry — the `n/m` subtask
  counter (the children are already right there, indented, and the count
  restated the tree), the attached-session count (the one item on the row that
  led nowhere), and the hover `+` that started a session (an invisible control
  on touch, duplicating the Task inspector's own "Start a new session").
  `BacklogToolbar.tsx` likewise carries no open/done counts: they were
  full-Backlog totals the filters did not change, which needed a tooltip to
  explain. What a row shows must be what you act on; a number nobody acts on
  costs the title its width, and on a phone that is the only thing worth
  reading.
- How much room a row gets is the HOST's decision, not a viewport read:
  `BacklogList.tsx` takes a required `density` (`BacklogDensity` in
  `lib/backlogTreeModel.ts`) and hands it to every view. `comfortable` — two
  lines, ~52px, every secondary control a full-height thumb target — is now what
  every Backlog surface but one renders: the Backlog page, the Project page's
  Tasks section, and the SIDEBAR at both sizes (`SIDEBAR_BACKLOG_DENSITY`). The
  rail was `tight` and that single 28px line spent a narrow column on the id and
  the project chip while truncating the title to a few words; the rail is not
  short of HEIGHT, so the phone's row is the better trade there too, and the
  reveal-on-hover it replaces was never available on touch anyway. `tight`
  survives for the composer's Task picker alone: no secondary affordance to hit,
  and no room for a second line per Task in the field it sits in. The TOOLBAR is
  a separate question (`toolbarDensity`, defaulting to `density`), because a row
  of filter chips is short of WIDTH rather than height — the rail keeps its
  compact chips above two-line rows, or they wrap into four lines. Density
  therefore still follows affordances rather than the breakpoint: the old
  `compact` boolean stood for two independent things — how WIDE the host is and
  how COARSE the pointer is — and both questions are now asked separately. At
  `comfortable` the chevron becomes a narrow full-height gutter with its glyph
  pinned to the FIRST line (`Tree`'s `rowAlign="stretch"`, the only change the
  two-line layout needed there — the row's HEIGHT stays the body's business),
  and the status control a full-height box aligned to that same line: the two
  read against the title they belong to rather than floating between the lines,
  and they are apart both ways round. `TaskRowBody.tsx` is the shared inside of
  a row — title line, then the id and `lib/taskRowMeta.ts`'s facts — used by the
  tree and by Focus so the two cannot drift. Its compact Workflow glyph is
  accent-toned for an active run and warning-toned when any run is paused; its
  words remain in the accessibility label/title without hover. Line 2 lays its
  chips out in priority order and CLIPS from the right, and it is UNCONDITIONAL
  on a two-line row: it carries the id, so it is never blank, and on a tree row
  a Task with nothing else to report states its status and age instead, because
  a list of rows alternating between one and two lines is harder to hit than a
  list that is simply taller. Focus keeps the opposite rule for the FILLER only
  (below).
- Everything on line 2 that names an object LEADS to it, through the host's one
  `onNavigate` (App's `openBacklogRowLink`, which warms a session timeline the
  same way the gutter does): the id to the Task, the session chip to its
  session, the branch glyph to its worktree, the dirty dot to that worktree's
  changes, the project chip to the Project, and the delivery chip off-site to
  the pull request itself. They are plain `<a href>`s — openable in a tab,
  reachable by keyboard — that stop the CLICK so following one does not also
  select the row, and deliberately do NOT stop the press: the tree's rows are
  swipe surfaces and drag activators, and a chip that swallowed `pointerdown`
  would carve a dead strip out of both across half the row's height. A surface
  with no navigator (the picker) states the same facts as plain text rather than
  rendering anchors that would leave through a full page load. What does NOT
  link is as deliberate: the suggestion, the plan, the deadline and the priority
  name no object — a date is a value, not a place — and the Workflow glyph names
  a RUN that has no route of its own, since a run's card lives on the Task page
  the id already reaches and `WorkflowIndicator` carries two booleans rather
  than an id (linking it would mean widening that slice to reach a route that
  does not exist). All of them share ONE click rule, `lib/rowLink.ts`: stop the
  click so the row does not act on it, leave every modifier click to the
  browser, otherwise `preventDefault` and hand the path to the host. It is a
  pure function over the fields a `MouseEvent` has, tested DOM-free, because a
  rule spelled out per link is a rule that gets fixed in one copy.
- The DELIVERY chip is line 2's one fact that neither the Task nor its session
  can tell you: where the branch stands with its pull request and its checks,
  reached through the session's worktree and the app's hosting projection
  (`hooks/useWorktreeHosting.ts`, ranked by `lib/worktreeHosting.ts`). It takes
  the WORKTREE GLYPH'S place rather than joining it — a PR is a stronger
  statement of "there is code" than a branch, and the line clips — and the glyph
  stays for a branch whose hosting says nothing OR is not known, since an absent
  projection is unknown and never clean. Its words are the shared delivery badge
  labels (**CI failed**, **Review**, **Merged**, **CI**), because a row that
  says one thing and a card that says another about one branch is a UI to be
  learned twice; a PR that asks nothing is stated as its NUMBER, which is the
  only detail a two-word chip has room for. Which PR, how many checks and how
  many unresolved threads go in the tooltip, and the chip itself opens that pull
  request (or, for a branch with no PR, the checks' own page) in a new tab. Only
  a row with a second line can state it, which since the sidebar went two-line
  leaves the composer's picker as the one surface that cannot — the same
  question `hostingSurfaces` asks before letting the app poll for it
  (`taskRowsHaveMeta`).
- UNCOMMITTED CHANGES ride on whichever of those two chips the row drew, as a
  warning-toned DOT with "Uncommitted changes" in its tooltip, leading to that
  worktree's CHANGES view — the one place its claim can be read, and the only
  route to the worktree left on a row whose branch glyph a PR chip took (a
  negative margin buys the 6px dot a hittable box without moving the line). A
  dot, not the inbox's **Uncommitted** badge, because this fact subsumes nothing
  — a branch can have an open PR and unsaved work at once — so it has to fit
  beside a chip that is already there on a line that clips. It reads a set of
  dirty worktree ids (`hooks/useDirtyWorktrees.ts`), never the statuses record:
  the record is rewritten by every watcher push, and this list is memoized. A
  worktree the set does not name is unknown rather than clean, and the set is
  scoped to the worktrees these rows can mark, so nothing else that goes dirty
  repaints them. App holds the matching git-status watches for as long as such a
  row is on screen — a row with no second line makes the app neither poll nor
  watch.
- The two-line row's right gutter holds exactly ONE action, and it is
  state-dependent: open the session started from this Task, or start one for a
  Task that has none (`taskStartSession`, so it is offered only when the browser
  holds a live, unarchived session to open — and `lib/sessionRows.ts`'s
  `backlogSessionsKey` is what keeps that answer fresh: the Backlog reads a
  GATED copy of the session list, and the previous gate, keyed on running ids
  alone, would have let a row keep offering a session deleted while idle).
  Because the gutter both names the session and leads to it, line 2 drops its
  own Session chip where the gutter renders — the line clips from the right, so
  stating one fact twice is paid for by the project chip. ONLY that chip goes:
  the worktree glyph stays, because "there is code" is a different fact from
  "work was started" and the gutter states only the second (`taskRowMetaEmpty`
  counts `worktreeId` for exactly this reason — without it an actively-worked
  row with no dates fell back to "To do · 2d" and lost the glyph). One action,
  because two stacked targets in a 52px row are 26px each — `ActiveSessionCard`
  affords two because each gutter control keeps its own 36px or 44px floor and
  the card grows around them, which a Task row fixed at two lines cannot do — so
  archiving keeps the swipe, the hover button and `e` rather than taking the
  slot. The gutter is present on every task row of a surface that has it (both
  handlers or neither): a gutter on some rows and not others is the ragged right
  edge the two-line row exists to fix. There is deliberately no flip card here
  as on `ActiveSessionCard`: the row is already a selection click, a drag
  activator and a swipe surface, a rotator would be a fourth interaction on one
  box, and the actions face measures 43% of a card's DOM on a list memoized
  against ~226 Tasks. Keyboard: Enter belongs to whatever is FOCUSED, so
  `common/Tree`'s row handler leaves it alone when the keydown came from a
  control inside the row (it used to `preventDefault` unconditionally, which
  cancels the browser's implicit click and would have made the row's own primary
  action select the row instead), and the row registers itself as @dnd-kit's
  ACTIVATOR node so a Space on one of those controls activates it rather than
  picking the row up. The accepted cost is tab stops: a `comfortable` row
  carries two or three controls (status, the hover Archive, the gutter) plus
  line 2's links, so a long Backlog is a long tab sequence — the same trade
  every rich row in this app makes, and the reason each of those controls also
  has a key or a gesture that does not need it.
- The Backlog list is ONE surface with a VIEW switcher, not one list with a sort
  control. `BacklogToolbar.tsx` holds that switcher in the slot the open/done
  counts vacated, and the two views differ in more than order — which is why it
  is a switcher: **Backlog** is `BacklogTreePane`, the hand-arranged hierarchy
  that drag reorders, reparents and reassigns (`sortOrder` is the truth there,
  and the By-Project toggle belongs to it alone, so the toolbar hides that
  toggle in any other view); **Focus** is `BacklogFocusList.tsx`, which sorts
  ITSELF from `lib/backlogFocus.ts` and therefore has no drag at all — offering
  both would make every drop silently snap back. Its first bucket, **Confirm?**,
  is not about time at all: it holds the Tasks an agent has suggested a status
  for — done, or handed back unfinished — answered on the row itself by two
  buttons (accept / disagree) because it is a yes-or-no and making it a trip
  into the Task detail is exactly what leaves these sitting for days. The row
  says WHICH suggestion it is ("says done" / "says not done", the agent's reason
  in its tooltip), since the two ask different questions and the amber glyph
  only says one is pending. A row stands ALONE in Focus, so it gets two lines:
  the title takes the first and `TaskRowBody` carries the id and answers why the
  row is here on the second (a **Working** spinner while a session started FROM
  this Task is streaming — observed via `lib/taskActivity.ts`, never reported by
  an agent — else that session, the worktree it runs in, then the planned day,
  the deadline, priority when it is not the default, project key). Focus differs
  from the tree's `comfortable` rows in ONE thing: a Task with nothing to report
  keeps its id and stops there rather than falling back to status and age —
  these rows are read as a GROUP, where the same filler down every row is noise,
  while a tree row's height is a thumb target that may not alternate. The row is
  a plain CLICK SURFACE whose TITLE is the anchor to the Task (`TaskRowBody`'s
  `onOpenTask`), rather than the `<button>` that used to wrap the whole body or
  the session shelf's `role="button"` row: line 2 carries links now, and both of
  those swallow them — a `<button>` may not contain an anchor, and
  `role="button"` makes every descendant PRESENTATIONAL, so the chips would be
  announced by nothing. The anchor is what the keyboard reaches, what names the
  row, and what a modifier click opens in a tab; the surface around it keeps the
  whole two-line block tappable, and every control inside stops the click so
  cycling a status or answering a suggestion never also opens the row
  (`BacklogFocusList.test.tsx` holds each of those). The two dates are SEPARATE
  chips with separate glyphs (`CalendarCheck` for the plan you chose, `Flag` for
  the deadline imposed on you) because they are separate facts; only a missed
  deadline is danger-toned, and a plan equal to its deadline shows once.
  Priority appears ONLY when it is not `normal`: the wire field is optional and
  most Tasks never had one set, so printing the default would spend the line
  restating the absence of information. Focus NEVER shows a `done` Task,
  whatever the status filter holds — finished work is not work, and a
  struck-through row under TODAY was noise at the top of the one view meant to
  be scannable; it also makes the client agree with the server, whose
  `scheduled`/`due` filters exclude done for the same reason. A Task carrying an
  UNANSWERED status suggestion is the one exception, and it bypasses the status
  chips with it: an agent saying a finished Task is not actually done is a
  question rather than work, that rationale does not reach it, and Focus is the
  only surface that can answer one. The toolbar therefore offers Focus only the
  `todo`/`doing` chips (`BacklogStatusFilter`'s `options`, which narrows what is
  OFFERED without touching the persisted set), since a chip that changes nothing
  is worse than no chip — and the list filters through `statusFilterFor` over
  exactly those options, so empty-or-all means NO filter WITHIN them: reading
  the raw set meant turning both visible chips off left `{done}`, a strict
  subset of all three, and Focus went blank. **Inbox** is
  `BacklogInboxList.tsx`, the triage queue for Tasks that ARRIVED rather than
  being typed (`lib/backlogInbox.ts`) — three lines per row, because deciding
  about something you did not write needs its origin and its first sentence, not
  just a title. It has exactly ONE control, dismiss: every other way of
  processing a Task (open it, give it a date, change its status or project)
  already counts as triage server-side, so the queue empties as a side effect of
  doing the work rather than needing a second gesture. Its chip carries an
  attention DOT rather than a count — whether anything waits is the actionable
  fact, and counts are what this toolbar was stripped of. The Inbox honours the
  project filter (you may be triaging one project's intake) and renders NO
  status control at all: its own rules cover status, and dead chips there would
  still rewrite the persisted filter the next view honours. `prefs.backlogView`
  persists the choice browser-locally; a surface scoped to one project
  (`fixedProjectId` — the Project page's Tasks section, the composer's task
  picker) is a PICKER rather than the Backlog, so it shows no switcher and is
  pinned to the tree.
- Archiving a Task has three entrances into `BacklogTreePane.tsx` and one set of
  rules behind all of them (`docs/tasks.md`, `lib/taskArchive.ts`): the tree's
  `e` row action, a RIGHTWARD swipe with a finger (`Tree`'s `rowSwipe`, offered
  per row — not gated on the mobile breakpoint, since `SwipeRow` already ignores
  every pointer that is not one) and — because a gesture nobody can perform with
  a mouse is not an affordance — an Archive button on the pointer side of the
  same rows, in the desktop layout where there is width for it. That button
  HOLDS its box on every row that offers it rather than appearing on hover,
  since a control that materialises under the cursor shuffles the badges
  sideways as you read down the list. Only rows that would succeed get either
  quick affordance; the `e` key and the inspector keep working everywhere and
  refuse out loud. The swipe also owns the row's DEPARTURE, which is why
  `onArchive` answers with the ids it archived (`null` on a refusal): an archive
  takes the row's finished subtasks with it, so the pane holds every one of
  those rows in a `useLeavingRows` GROUP led by the swiped id, and releases the
  group on the one exit `SwipeRow` reports. Without that hold the rows would be
  unmounted mid-flight — the Task list answers an archive in a frame or two —
  and the reflow would be the abrupt removal the animation replaces; without the
  group the subtasks would blink out a frame ahead of the parent still sliding.
  A held row keeps the INDEX it was taken from (a list nobody has dragged has no
  `sortOrder`, so appending would send it to the bottom on its way out), is not
  selectable and cannot be dragged, and a backstop timer per group releases it
  for the endings that never report one, like a filter change unmounting the row
  mid-exit. The swipe leaves the user's persisted collapse state alone: the
  subtree is leaving with the row, so there is nothing to open.
- The row's OTHER side deletes, and the two are gated independently: the quick
  archive is offered only where it would succeed (a finished Task whose whole
  set passes), while delete is offered wherever the `#` key is, on any Task — so
  a row routinely carries one side and not the other. Delete owns no departure
  at all. It commits to `useBacklog`'s `deleteTasks`, which ASKS
  (`lib/taskDelete.ts` names the subtree in the question), so its `run` answers
  nothing, the row springs home, and the rows leave only when the answer does.
  Animating them out on the gesture would show the deletion happening while the
  question was still on screen. The directions are not interchangeable either:
  archive is the frequent recoverable one and takes the side a right thumb
  reaches most easily, delete faces the other way so muscle memory cannot
  confuse them, and its panel is `danger`-toned from the first px rather than at
  the threshold.
- The failure an OBJECT is carrying renders as one `ErrorNote` above its
  content, with a Dismiss: `TaskManagementPage.tsx` above the open Task's title
  block, and `ProjectDetailPage.tsx` at the top of the project's detail body. It
  is for the writes no control on the page tracks (archiving a Task); a tracked
  write is refused on its own control, and the two are never both shown for one
  failure (`docs/messaging.md`).
- `TaskManagementPage.tsx`'s detail splits identity from content, at every
  width. The header is ONE compact row: the Tasks glyph (which copies
  `Task-123`) and the id. The title and status moved into the top of the
  scrolling body (`TaskTitleBlock`), where a title WRAPS in full instead of
  truncating at ~30 characters and where renaming is a visible target — the
  header's pencil was `revealOnHover`, i.e. an invisible button on any touch
  device. Status appears ONCE per viewport: the title block's chip cycles on a
  wide layout, and on a phone the block shows no status at all because the
  dock's action row shows the state in the glyph you press to change it
  (`App.tsx` builds that row). A done Task still reads as done in the block —
  the title is struck through. The subtask progress moved into the title block,
  where it is metadata among metadata. Its Description body is NOT in the Task
  list payload (those are summaries — see `../hooks/CLAUDE.md`): the page
  fetches the open Task through `requestTaskDetail` and passes the whole cached
  `TaskItem` down as `detail`. `undefined` means "still on its way" and is
  deliberately distinct from `""` — in that state the section shows a
  placeholder (the row's `descriptionPreview`) instead of its empty-state text,
  and the edit pencil is ABSENT, because the editor is `allowEmpty` and an empty
  editor must never be savable over a body that had simply not loaded. Its
  `CollapsibleSection`s are ONE pattern: the body is FLUSH with the page column
  (title, section labels, description prose and comments all share one left
  edge, and only the chevron marker sits inside it — an indented paragraph reads
  as a nested level the section does not have), and editing a prose body is
  triggered ONLY by that section's ghost pencil in the header's `trailing` slot.
  No prose body is itself a click target: a full-width button fought selecting
  text, following `pa://` links and scrolling on touch, and needed inner padding
  that broke the column. Between `TaskTitleBlock` and Description, runs stack
  newest-first: `WorkflowRunCard.tsx` renders each non-terminal run's phase,
  activity, iteration, visible pause reason, the stopped step's own
  `blockedReason` under it (skipped when it repeats the banner or the next
  action), reviewed commit, the latest assessment's
  summary/findings/observations, the coordinator's newest accepted review
  decision (deliver or another pass, after which pass, its rationale and focus),
  one button per review pass beside the other role sessions, and the next action
  plus pause/resume/retry/cancel tap targets. A cancelled card adds **Delete
  run…**: one permanent-history confirmation with independently selectable,
  default-on worktree/branch deletion and workflow-session archival. A refused
  worktree cleanup leaves the card in place. `repeatedAttempts` turns the
  control into "Retry again" behind a confirmation and adds what another retry
  would DO — re-run the same assignment, which a repair outside the run or an
  agent step's fresh session can still end differently. The count itself stays
  the pause reason's, which the banner already renders, so this line follows the
  same "only where it adds something" dedup as `blockedReason`. Session buttons
  navigate through the screens model; cancel confirms that sessions, worktree
  and PR remain. Terminal runs collapse to subdued lifecycle/date rows.
- `ProjectDetailPage.tsx` is the Project's CONTENT, in use order: description,
  its Tasks (`renderTasks`, a render prop because the list is the lazy
  `BacklogList` and needs App's socket state — the page only decides where it
  sits), its Worktrees, then the repository state you rarely touch. Tasks and
  worktrees are NOT also in the object panel: the panel is for what the page
  cannot show, so a project's panel is Related projects, the sessions its tasks
  pulled in, Local paths, Settings and Actions. Each worktree is a memoized row:
  branch plus dirty line delta and actions on line one, then the shared
  three-axis summary only when an axis has something to say, so an in-sync row
  stays one line. The row renders the status projection's live branch and takes
  ids in its stable host callbacks; a watcher update therefore redraws only the
  worktree it changed. One coarse host-owned wall clock keeps remote-ref
  staleness honest on quiet rows; row memoization folds each tick to the
  rendered stale/fresh bit, so only a row crossing that boundary redraws. A list
  SCOPED to one project passes `showProjectBadge={false}` (the chip would repeat
  that project on every row, costing title width on a phone) and does not count
  the scope as a clearable filter, so an empty project reads "No tasks yet"
  rather than offering to clear filters it does not have.
- `ProjectDetailPage.tsx`'s header is the Task detail's row applied to a
  Project, at every width: the glyph copies the KEY, and the identity reads
  `KEY - Name` (mono muted key, `-`, the name). A Project's name is short, so
  unlike a Task's title it stays IN that row instead of moving into the body —
  which makes rename the row's ONLY action, at both widths. Everything else left
  the page: key, color and the worktree-root override are rare enough to be
  panel settings (`ProjectSettingsFields.tsx`), the local-path mappings are a
  panel section (`ProjectLocalPaths.tsx`), and status stopped being a dropdown
  at all — archive/restore/delete are `ProjectInspector` actions, like every
  other object's. So the page is identity then CONTENT — description, the
  repository's state, the worktree list — and holds no form controls at all: no
  chips row above the description, no `<select>` grid, no explainer paragraphs
  for fields that live elsewhere. `archived` renders as a read-only pill in the
  header when true and never otherwise: it is a state worth seeing with the
  panel closed, not a control.
- `ProjectDetailPage.tsx`'s **Repository** section states WHERE the project is
  checked out and offers only the action that state allows. Two states: not
  cloned = an editable URL row plus one `Clone` button; cloned = read-only
  `Checkout` + `Origin` rows whose only action is deleting the clone. There is
  NO update/pull — that is the worktree surface's job (`worktreeSync`
  `pull-rebase`), which is also why the URL is not editable once a checkout
  exists: re-pointing a checkout that worktrees hang off it is how work gets
  lost, so the flow is remove, then set a new URL. The remove control appears
  only when no spawned worktrees remain (the server refuses either way); while
  they do, the section says so in one caption instead of showing a disabled
  button nobody can explain. Outcomes are toasts (`App.tsx` converts
  `provisionOutcome`), so the section has no alert box, no dismiss ✕ and no
  progress paragraph duplicating the button's spinner.
- `ProjectSettingsFields.tsx` owns the Project's key, color and worktree-root
  editors as inspector rows, and the palette expands IN PLACE rather than in a
  popover — it renders inside a scrolling panel that is a bottom sheet on a
  phone, where an absolutely positioned menu is clipped. The worktree root is a
  full-width row (label above value) because it is an absolute path in a ~320px
  panel, and its empty state NAMES the fallback ("Settings → Worktrees root")
  instead of needing the explainer paragraph it had on the page. It also owns
  `normalizeProjectKey` and the project color palette, which moved out of the
  (lazy) Project page when its chips row went away.
- `ProjectLocalPaths.tsx` owns the panel's **Local paths** section: the extra
  folder mappings, shaped like the Task inspector's Links (row per path, path
  click-to-edit, `+` opens one draft input). `kind`/`match` are chips that CYCLE
  on tap rather than `<select>`s — the app's other state controls are
  tap-to-change glyphs, and two dropdowns per row was the loudest thing on the
  Project page. `notes` is no longer editable (nothing reads it; the wire field
  stays for agents). The draft commits on blur so a phone tap-away does not
  discard typing, which makes the header's cancel a RACE it must win: a
  `pointerdowncapture` guard on that button lands before the input's blur and
  suppresses the commit. `hidePath` keeps the managed clone out of the list,
  since the page's Repository section states it.
- `common/dialogs.tsx` owns the app's modal chrome (`DialogOverlay`,
  `DialogHeader`, `DialogAction`, `DialogCancelButton`) and the single
  confirmation surface built from it. `ConfirmDialog` is the declarative half —
  title, body, optional single field, caller-owned `busy`/`error`, extra gates
  as children (the worktree removal's "also delete the branch" and force
  checkboxes) — and `DialogProvider`/`useDialogs` the imperative half, awaiting
  a `confirm` or `promptText` from an ordinary handler. `main.tsx` mounts the
  provider once around `App`; its context value never changes, so opening a
  dialog re-renders the provider alone, and the two members stay referentially
  stable for the memoized rows whose handlers close over them. Native
  `window.confirm`/`alert`/ `prompt` are banned app-wide because the Tauri
  shell's WKWebView never shows them (`src/nativeDialogAudit.test.ts`);
  `WorktreeDialogs.tsx` builds its clean/removal guards on `ConfirmDialog` and
  its form dialogs on the same primitives, so all of them share one idea of
  chrome, focus and busy state.
- `common/CommentComposer.tsx` owns the app's shared comment-entry silhouette
  for unanchored and anchored comments: an optional host-supplied anchor header
  over one growing field, with optional text refinement and dictation controls
  in the row before Send. Refinement uses `lib/refineText.ts`, while dictation
  uses the same single-owner `useDictation` recorder and `DictationControls`
  recording UI as chat; a transcript returns to the captured caret and never
  auto-submits. By default it owns and clears its draft after submit; a host
  that supplies both `value` and `onChange` owns that draft instead, and submit
  deliberately leaves the controlled value intact (for example, until a
  persisted mutation is acknowledged). Hosts opt into capabilities and supply
  context/availability only — the component owns no anchor, transport, or domain
  state. Enter submits and Shift+Enter breaks the line — the chat composer's
  rule and its touch exception (`hooks/useTouchComposerMode`), because writing a
  comment is the same act as writing a prompt and two different Enters in one
  app is a coin toss; Cmd/Ctrl+Enter still submits, and the Send tooltip states
  the rule.
- `TaskComments.tsx` owns the presentational Task activity-trace list + composer
  (Markdown bodies, author-kind badge, chronological oldest-first, append-only —
  no threading/resolve/edit). Its composer is the shared
  `common/CommentComposer` (also used by a Knowledge entry's comments): ONE row,
  send INSIDE the card, growing with the text up to a cap — it is the same act,
  and it was the last text entry in the app that looked like a form field with a
  button parked beside it, and Enter submits with Shift+Enter for a newline,
  exactly as the chat composer does. Bodies render through the shared
  `common/CommentBody` (Markdown, `compact`), the same renderer the diff and
  Knowledge threads use. Comments are ruler-separated rather than cards,
  collapse individually to their header, and agent authors link to their
  originating session when `sessionId` is present. `TaskManagementPage.tsx`
  mounts it in the Task detail's **Activity** `CollapsibleSection`. It renders
  the per-Task `LoadState` honestly, watches and revalidates on open, unwatches
  on close, retains comments during refresh or failure, and keeps a comment
  draft until correlated add success.
- `TaskManageToolCard.tsx` owns the in-chat card for a `task_manage` result: the
  Tasks a turn created or changed, as chips that open them, plus the confirm
  button for a pending status suggestion. It is registered in `tools/` and
  described in `docs/reference/web-tool-cards.md`; the Backlog surfaces stay the
  place a suggestion is DISMISSED.
- `TaskPlanningSection.tsx` owns the Task inspector's **Planning** section —
  priority, `scheduledFor` ("Planned for") and `dueDate` ("Due") — and
  `TaskContextSections.tsx` renders it FIRST, above Project. It exists because
  all three fields were wire-only: agents wrote them and no human surface could,
  which made a Backlog sorted by priority a sort over a column nobody could fill
  in. The two dates are separate controls with separate glyphs and a one-line
  explanation each, since the entire point of having both is that a plan you
  chose is not a deadline imposed on you; only the PLAN gets Today/Tomorrow
  quick picks, because those are the answers you actually give when deciding
  what to work on, while a deadline is a date someone hands you and a shortcut
  would be a guess. The date field gets its OWN row with the quick picks beneath
  it: sharing one squeezed a native date input to ~85px in the ~320px panel and
  clipped the year, and a date control that cannot show its own date is not a
  control. Clearing sits with those picks rather than behind a separate control
  — un-planning is as ordinary as planning — and the collapsed section summary
  states plan · due · non-default priority in the same order of importance the
  Focus row uses, so the two surfaces cannot describe one Task differently.
- `TaskContextSections.tsx` owns the Task inspector's Planning (delegated),
  Project, Jira-ticket, and external-link sections. Linked Jira rows use flat
  ruler-separated relation styling and enrich each stored key with its live Jira
  summary through `lib/jiraApi.ts`; unavailable Jira metadata degrades to the
  key alone.
- The right object panel is a single Details inspector (no embedded agent). On
  desktop, `shell/RightPanelTabs.tsx` hosts it as the **Inspector** tab
  alongside the other closeable panel surfaces; `+` opens the available-panel
  home, which remains visible when every tab is closed. A tab's surface is built
  on first SIGHT (`visible` + active) — an open tab restored from
  `sessionStorage` behind another, or with the panel closed, has never been
  looked at, and these surfaces fetch and subscribe on mount — and stays mounted
  from then on. `PanelDefinition.mountsWhenHidden` exempts the Inspector, which
  publishes the header's overflow actions from inside the panel and is why
  `App.tsx` keeps this host mounted with the panel shut. Its **Personal
  Assistant** tab owns an independent connection to the server-owned permanent
  conversation, so it can remain open beside the routed main session; its
  **Knowledge** tab (`shell/KnowledgePanel.tsx`) renders the Knowledge Base
  checkout's `WorktreeDetailPage` (narrow, embedded) inside its own
  `RoutePrimaryActionProvider`, keeping its location as panel state. Its
  **Worktree** tab (`shell/WorktreePanel.tsx`) renders that same
  `WorktreeDetailPage` for the worktree the OPEN SESSION executes in, in the
  same two providers, with `narrow` for the column's width and `embedded` so the
  panel copy neither publishes the shell's document navigation nor restores its
  scroll — those belong to the page the URL addresses. Its `navigate` intercepts
  the page's own `worktreePath` links into panel state and passes everything
  else to the main pane. An `openRequest` prop opens and activates a tab on
  behalf of something else in the app (the `kb_show` card). Mobile bypasses that
  host entirely and keeps the direct Inspector dock. An inspector whose object
  has not arrived passes `loading` to reserve body sections. The "No related
  objects yet." `EmptyBox` waits for an actual answer
  (`app/web/docs/loading-states.md`). `KnowledgeInspector` fetches through the
  keyed `useFetchState`, so entry→entry switches show the NEW object's
  placeholder while a same-object refetch (a commit token, an expanded history
  diff) keeps the panel up and a failure keeps it under a retryable `ErrorNote`.
  `objectInspectors.tsx` owns the per-object inspector assemblies
  (Task/Project/Worktree/Knowledge/Session). On wide layouts `Inspector`
  publishes their secondary actions through `RoutePrimaryAction`'s route chrome
  context: `PageHeader` renders them in its shared `…` menu and `ChatHeaderMenu`
  combines them with transcript options. Primary actions remain visible in the
  page header; the mobile dock has no header `…`, so it retains the full Actions
  section. `App.tsx` routes the "Start a new session" action with context
  pre-staged as chips
  (`startSessionForTask`/`startSessionForProject`/`startSessionInWorktree`/`startSessionForFile`).
  A document's comment tray goes through `sendDocumentComments`, which moves it
  into the chosen session's composer (or the new-session draft) and navigates
  there. Because the dock is the object's ONE action home on small screens, each
  assembly takes the controls its page header drops there: `SessionInspector`
  (its **Profile** section — the immutable account binding plus the model and
  thinking level the session runs on, as `InspectorFacts` —
  `onOpenWorktreeChanges`, `view` → the View section). Its Tasks group shows
  five rows before a "Show more", so the sections under it stay reachable.
  Otherwise each is optional and passed only on mobile; the wide layout keeps
  its header controls. `ProjectInspector` is the exception that proves the rule:
  its `onSave`/`onArchive`/`onDelete` are passed at BOTH widths, because a
  Project's page keeps nothing but identity — archive, restore and delete are
  actions there, and its remaining config is two panel sections — **Local
  paths** and a collapsed **Settings** (`ProjectLocalPaths.tsx`,
  `ProjectSettingsFields.tsx`). Restore exists BECAUSE archiving moved here: the
  Projects browser hides archived projects, so a directly-opened archived
  project's panel is the only way back to active.
- `WorkflowRunStartSheet.tsx` owns the Task's **Run workflow** start flow
  ([Task-366](pa://task/366), `docs/agent-workflows.md`), opened by
  `TaskInspector`'s "Run workflow…" action (passed by `App.tsx` only for Tasks
  with a Project; the server owns the real git-backed refusal, shown inline). It
  rests as a compact CONFIGURATION SUMMARY, not a wizard: one collapsed line per
  runtime (`roleSummary` — model · account · thinking), and exactly one row
  expands at a time into the new-session runtime controls
  (`common/RuntimePicker`: metered provider-account cards, an account-scoped
  model row, the stepped thinking slider). The rows are the **Coordinator**
  runtime plus independent implementer, reviewer, fixer, and verdict candidate
  sets (`WORKFLOW_ROLE_SET_BOUNDS`). Implementer/reviewer keep at least one row;
  fixer/verdict may be empty to preserve implementer fallback and skip post-fix
  judgment respectively. Each candidate also exposes a free family string and
  bounded optional selection notes. Per-role add/remove controls enforce each
  set's own 0/1..6 bounds and collapse a removed positional row. Switching a
  row's account carries the model/thinking over through
  `lib/newSessionRuntime.ts`'s `carryOverRuntimeSelection`, the same rule the
  new-session provider row uses. Run limits are bounded discrete sliders
  (`WORKFLOW_RUN_LIMIT_BOUNDS`) with the number visible and the spoken value on
  the input. There are exactly TWO — discovery passes and fix iterations — and
  they constrain nothing about each other (`applyWorkflowRunLimits` in
  `app/shared/workflow.ts`); the sessions a run opens follow from them, so there
  is no third number that could contradict the first two. "Reset to recommended
  defaults" puts the whole form back, including the base recommendation: the
  nearest Task ancestor with an active same-Project worktree, otherwise main.
  The parent walk is cycle-guarded and the base choice is never remembered.
  Runtimes and limits are prefilled from `prefs.workflowRoleRuntimes` /
  `prefs.workflowRunLimits`, restored per row — including each role set's
  remembered candidate count — and clamped (`initialRoleStates`,
  `normalizeWorkflowRunLimits`) so one disappeared account or model does not
  reset the rest; only STARTING writes them back (`rememberedRuntimes` →
  `onRemember`), cancelling never does. Prompt overrides stay per-run under the
  Advanced disclosure — never remembered, so Task-specific instructions cannot
  leak into the next Task — with a visible badge when one is set. Above all of
  it stays the ALWAYS-VISIBLE plain-text authorization summary of what starting
  permits and what it never does. The visible surface is the portal-free
  `WorkflowRunStartLayer` (render-tested at both breakpoints): a FULL-SCREEN
  flow on small screens per the `ui-shell.md` screens model, a bounded centered
  dialog (`max-w-xl`, `max-h-[85vh]`) on wide layouts. Start sends
  `startWorkflowRun` with a fresh `requestId` and follows its own entry in
  `state.workflowRunStarts` (naming → creating → submodules) inline; `started`
  closes the flow with a toast, `failed` renders the error and re-enables Start,
  and the flow clears the entries it consumed (`clearWorkflowRunStart`). While a
  start is PENDING the surface is not dismissible (`canDismissWorkflowStart`:
  backdrop, Escape, X and Cancel all go away — dismissal would not cancel the
  run already being created, so no control may claim to); the one exit is the
  explicit "Run in background", which hands the request id to `App.tsx`'s
  background SET (several starts may be backgrounded at once), whose settlement
  effect (`lib/workflowStart.ts`) toasts each request's own outcome and drops
  its entry. While the sheet is open `App.tsx` declares the `usage` topic for it
  (`topicsForSurface`'s `meteringOverlayOpen`), so its account cards carry live
  meters; usage is display-only and never travels to the coordinator.
- `common/RuntimePicker.tsx` owns the shared runtime quick-pick controls — "who
  runs this, on which model, thinking how hard" — so the new-session landing and
  the workflow start sheet ask that question identically: `QuickRow` (the
  labelled snap-scroll `listbox` that scrolls its `data-quick-selected` item
  into view) and `QuickPill`, `ProviderAccountRow` (account cards with the
  fixed-height `UsageCycleMeters` slot and its once-a-minute `useCoarseNow`
  clock), `ModelQuickRow`, `ThinkingSlider`, and the `DiscreteSlider` both
  sliders are built on (native `range` over a stopped track, so
  drag/tap/keyboard come for free; `aria-valuetext` carries the spoken value
  because the raw index means nothing). Callers own only what is offered and
  what a pick does.
- `MemorySettingsSection.tsx` owns the canonical **Memory** Settings section:
  independent use/load, learning-mode (Off/Adaptive/Every turn — experimental),
  maintenance, budget, processor model, and global calls/hour + cost/day ceiling
  controls, plus a post-hoc memory manager with real prev/next pagination,
  filters (text, state, project id, persona, kind, pinned, active-now), per-card
  lineage (predecessor/superseded-by, fetched on demand into its own per-id
  slot, which renders as `Skeleton` lines while it arrives) and provenance
  (source kind + originating session link), and scope/time editing
  (project/persona/temporal mode + window start/end + recurring
  weekday/timezone) alongside correct/pin/archive/restore — a text change
  supersedes (correct), a scope/time-only change is a non-semantic edit.
  Changing temporal MODE resets mode-incompatible fields
  (`normalizeTemporalForMode`) so e.g. window→persistent cannot leave a stale
  `validUntilMs` that would still silently expire the card. A typed timezone is
  tracked as separate raw text (`tzText`) from `draftTemporal.timezone`, which
  only ever holds a validated last-known-good value — `lib/timezone.ts`'s
  `resolveTimezone` is the ONLY thing datetime inputs may pass to
  `Intl.DateTimeFormat`-backed conversion, since that throws synchronously
  (crashing the render) for an invalid IANA string; Save is disabled and an
  inline error shown while the typed zone is invalid, BUT ONLY when the current
  mode actually uses a timezone (`lib/timezone.ts`'s `temporalModeUsesTimezone`:
  window/recurring) — a leftover invalid `tzText` from a prior window/recurring
  edit must never permanently block Save after switching to
  persistent/until-changed. The read-only per-card temporal label
  (active/expired/upcoming) also renders in the card's (or configured) timezone,
  using BOTH `validFromMs`/`validUntilMs` bounds, not just the until bound. It
  never uses candidate/approval/pending-review terminology — automatic
  operations are already applied. `LoadedMemorySection.tsx` owns the Session
  Details inspector's "Loaded memory" `InspectorSection`: it renders the
  persisted effective-load audit (Injected/Reused/Cleared/none/Failed, exact
  per-card text/scope/reason from the audit — never recomputed client-side),
  defaults to the latest turn with bounded prev/next navigation among recent
  batches, distinguishes
  loading-disabled/draft/not-yet-loaded/no-eligible-memory/failed states, and
  reveals per-row pin/unpin/correct/archive/restore actions only once that row's
  CURRENT live card is fetched on demand (never guessed from the historical
  snapshot), plus a link to the full Memory settings/management surface (inside
  the section body, not its header). It rests COLLAPSED behind a cards-of-budget
  counter ("3 of 20", `settings.memory.maxCards`): that count is the question a
  session panel usually asks of memory, and the audit itself is the follow-up. A
  draft session (which can have a DEFINED but staged/optimistic `sessionId`,
  e.g. `pending-pi-session`) is detected via an explicit `hasAcceptedUserTurn`
  prop from `App.tsx` — never by `sessionId === undefined` alone — and never
  issues a load-audit fetch; it renders the ACTUAL staged scope (`stagedScope`:
  persona, directly-attached project id, or — for a staged Task attach — the
  Task's OWN `projectId` resolved by `App.tsx` from the authoritative task list,
  rendered as "global" when the Task genuinely has no project and only as
  "resolves once sent" when the Task cannot be resolved client-side at all), not
  just the Task's title. Both read/mutate through `hooks/useMemory.ts`, whose
  lineage state is keyed by memory id (`lineageById`, request-correlated) rather
  than a single shared slot, so independently expanded rows across the manager
  and the inspector cannot clobber each other.
- `SessionContextSections.tsx`'s `PeerPromptsSection` renders durable
  peer-prompt history as CONVERSATIONS, not records: one flat thread per peer
  (no nested cards), the peer's name linking to that session, and each message a
  chat bubble — the reader's own side right, the peer's left, so nothing has to
  be labelled "sent" or "received". A bubble shows a whitespace-collapsed
  excerpt (`PEER_PROMPT_EXCERPT_CHARS`, two lines) plus state and time, and IS
  the link to the other party's copy of that message: an `<a href>` at the peer
  session for the ordinary browser gestures, with a plain click resolving the
  precise jump (`onRevealMessage` → `useAssistant`'s reveal, busy while it
  resolves). Everything else the record carried — the audit trail, the linked
  Task, "Response requested" — is gone; only a failure reason stays, because it
  lives nowhere else in the UI. The section is `defaultOpen={false}`: it is
  reference material about work that already happened. `ActiveSkillsSection` in
  the same file renders `SessionState.activeSkills` joined with
  `skillInvocations` as a compact, read-only list in three states — loaded
  (count and last load), available (mounted, body not in context), not mounted —
  ordered in that sequence. It remains present for an empty coding-session
  freeze ("None available") and exposes no toggle or other settings control.
- `BackgroundProcessesSettingsSection.tsx` owns the **Background processes**
  section (settings section id `background-processes`, under Developer workflow)
  for [Task-467](pa://task/467)'s `BackgroundWorkSettings`: `enabled`, the
  background-owning session cap (7, 1–20), the process lifetime (60 min, 5–1440)
  and the Claude empty-host grace (30 s, 0–300), each offering exactly the range
  `BACKGROUND_WORK_SETTINGS_RANGES` permits and each stating its own
  frozen-value consequence — disabling denies new admissions and kills nothing;
  a lower cap evicts no owner that already holds a slot; a lifetime edit moves
  no existing deadline. A closing block states the three facts the numbers do
  not: PA enforces the owner cap BEFORE Claude executes a background tool (it is
  not a Claude account setting), a persistent monitor survives turn idle but
  stays deadline-governed, and NOTHING resumes after a server restart.
- `PeerRuntimesSettingsSection.tsx` owns the **Peer sessions** section (settings
  section id `peer-runtimes`, under Developer workflow). Its loop-guard control
  edits `AppSettings.sessionPeerPromptMaxHops` within the shared 1–200 bounds;
  the default is 50 and the copy explains that a human prompt closes the causal
  chain. The same section owns the [Task-595](pa://task/595) ordered list of
  exact account/model/thinking rows agents may start ordinary peer sessions on
  without an approval card. It reuses `AgentModelFields` for the runtime itself
  — with `accountFallback={false}`, because that component's pinned-account
  notice promises a degrade to the automatic account which is true of an
  ordinary settings slot and false here, where the server REFUSES the row, and
  with the thinking level under `thinkingSelection="exact"`. That mode exists
  for a surface where the model/level PAIR is the record: a level outside the
  vocabulary OR outside the selected model's ladder shows as NO selection (the
  `placeholder`, here "Pick a level") instead of its clamped neighbour, and
  changing the model carries the level only when the new model really supports
  it. The default `"clamp"` — every ordinary settings slot, which names a
  preference the runtime may lower — is unchanged. Both halves matter here:
  displaying the neighbour would show an approval the human never made beside a
  warning that the row cannot run, and emitting it on a model change would
  PERSIST that approval. `AgentModelFields` therefore takes
  `thinkingLevel: ThinkingLevel | undefined` and omits `thinkingLevel` from its
  change payload rather than inventing one. It adds a name, user-selectable
  coarse cost (`low`/`medium`/`high`/`unknown`), a bounded optional description
  explaining when an agent should select the row, an enable switch and removal:
  no roles, projects or budgets, because the coordinating agent writes the role
  in its own prompt. Family comes read-only from `peerRuntimeFamilyOf`; cost and
  description are persisted with the approval and exposed by `session_spawn`
  profiles. An enabled row that cannot run says so via
  `peerRuntimeUnavailableReason` and STAYS in place: repairing or hiding it
  would hand agents a runtime the user never approved. The copy states plainly
  that approval permits paid sessions on exactly that runtime.
- `SkillsSettingsSection.tsx` (settings section id `skills`, `docs/skills.md`)
  shows the user-owned library and which of its skills are globally on:
  available skills with name, description, source `SKILL.md` path and a toggle,
  then the folders that need a fix. Diagnostics are a first-class list, not a
  footnote — a hand-authored library fails by producing a folder that quietly is
  not a skill, so each one is shown with its source folder and the scanner's
  reason, and with NO toggle, since a broken folder has no valid declared name
  to enable. It renders `LoadState` from `useAssistant`'s one canonical skills
  slot and nothing of its own: a first scan draws `PaneLoading`, a re-open keeps
  the rows under a `RefreshIndicator`, an `EmptyBox` appears only for an
  authoritative empty scan (and says something different when every folder is
  broken), and a failed scan adds an `ErrorNote` beside whatever was last read.
  The toggles keep no state of their own either ([Task-613](pa://task/613)):
  each renders `isSkillEnabled(settings.skills, …)` and calls
  `onToggleSkill(name, on)` — `useAssistant`'s `setSkillEnabled`, the one
  non-optimistic settings path — so a click that was never persisted cannot
  leave a skill looking enabled. It deliberately does NOT compose the
  whole-section replacement: that map has to be built on the one last SENT while
  a save is in flight, which only the hook holds, and a skill momentarily
  missing from the scan keeps its stored entry either way. It reuses the generic
  `Tree`, `PageHeader`, `CodeBlock`, `Markdown`, and `common/load.tsx`
  primitives. Opening a row reads that skill's `SKILL.md` and recursive
  supporting-file tree into a detail pane below the list
  ([Task-614](pa://task/614)): the body is NOT in the list, it is
  `fetchSkillDetail` through `useFetchState` KEYED BY THE SELECTED NAME, which
  is what makes R3 structural here — switching rows drops the previous document
  during render and a late answer for it is discarded, so one skill's
  instructions can never be read under another skill's heading. The row's
  metadata is the button (a whole-row target would nest the toggle's checkbox
  inside a control); the body renders through the shared sanitized `Markdown`,
  never raw HTML; a truncated body says how much of the file it is showing; an
  `invalid` answer renders the scan/read race's reason as content rather than as
  an error; and a new scan rereads the open skill in place, keeping it on screen
  (R2) so browse and injection cannot disagree about the file. File selection is
  independently keyed by name + relative path: Markdown is sanitized, text/code
  is highlighted, images use the bounded raw URL, and binary/unsupported files
  get raw/download actions only. First load, file switches, refresh failure,
  binary detection, and body/tree/preview truncation each render their own state
  rather than borrowing the previously selected file's content.
- Configured agents choose an ACCOUNT/MODEL COMBINATION: `AgentModelFields.tsx`
  (its own module, because both `SettingsPage.tsx` and
  `MemorySettingsSection.tsx` render it) takes `AccountModelOption`s, so
  `ModelSelect` groups by account and the pick writes both the model and its
  `credentialProfileId` into the settings slot; a slot whose pinned account is
  disabled or removed renders an inline degradation notice instead of silently
  reading as another account's model. The account list rides a
  `CredentialProfilesContext` rather than every section's props, and the Models
  section (visibility/order) stays account-independent and global.
  `settingsSections.tsx` owns the grouped Settings browser: General is
  Appearance → Profile → About; Models & providers is Models → Claude SDK →
  OpenAI → OpenAI-compatible; the remaining sections are grouped by Assistant
  behavior, Developer workflow (Worktrees → Skills → Peer sessions → Commit
  agent → Pull request agent), Tasks & automation, and Integrations.
  `SettingsPage.tsx` keeps profile management provider-specific: Claude SDK can
  be enabled/disabled and manages only Claude profiles, while OpenAI has its own
  page and manages only OpenAI/Codex profiles. Every profile row has an
  availability switch, including the protected defaults: disabling keeps
  credentials and existing session bindings intact but removes that account from
  new-session and Usage choices. Each card carries a **Used by** block
  (`CredentialProfileUsageBlock`, from `CredentialProfileSummary.usage`): pinned
  settings slots as buttons deep-linking to their section, bound-session count,
  and whether it is the automatic account plus where that would move. Disabling
  is therefore confirmed with `disableAccountImpact`'s exact consequences
  (enabling stays instant), and deleting reports which slots return to
  automatic. `CredentialProfileCard` keeps mobile actions in two non-overflowing
  tiers: name/status with icon-only Pencil/Trash actions at top right for
  mutable profiles, then availability switch + compact icon-labelled
  Connect/Reconnect; protected defaults simply omit edit/delete.
  `CredentialProfilesSection` offers Connect/Reconnect outside the displayed
  device-code phase and polls that phase; a changed profile-local credential
  completes the visible flow even if pi's post-login model refresh is still
  settling. Existing on-disk credential presence remains only a readiness hint
  and must never hide reconnect recovery after token expiry or provider
  rejection.
- `MessageList.tsx` renders a bounded WINDOW of the transcript
  (`lib/transcriptWindow.ts`): the newest 120 rows on arrival, plus a "Load N
  earlier messages" control that adds 240 more. That control consumes the rows
  the client already holds FIRST and only then asks the server for older ones
  (`onLoadOlderMessages` → `loadTimelineRange`), because the transcript itself
  is a windowed suffix now — the render window feeds on what the wire window
  sent, and each fetch grows the render window by the same step so the arriving
  rows are visible rather than hidden behind the button. Memoization stops rows
  from RE-rendering; it does not stop them from existing, and a long session's
  rows are thousands of real subtrees — measured on a synthetic 1761-message
  transcript: 868 ms and 2051 KB of markup to mount everything, versus 137 ms
  and 140 KB for the window. Off iOS, each row also carries
  `content-visibility: auto` with a remembered `contain-intrinsic-size`, so
  off-screen rows cost no layout or paint; the paint containment that implies is
  safe because every popover inside a row is portaled to the body
  (`Popover.tsx`). Under the iOS-only `-webkit-touch-callout` feature query,
  rows stay `visible`: WebKit has no native scroll anchoring, and an intrinsic
  estimate resolving under a touch can paint before the controller's resize
  correction. The initially bounded window grows only when the reader asks for
  older rows, making truthful layout there the safer trade. Nothing inside a row
  may rely on overflowing its box, and the row stays square-cornered: a radius
  on it bends that clip into the row's own corners, where it shaved the top-left
  of the first glyph off an assistant message and the corner border off a card
  flush with the row's edge (whose margin collapses out of the row in WebKit),
  leaving a fill-coloured arc where the card's border should be. What a row that
  has NEVER been rendered is worth comes from `--transcript-row-estimate`, which
  `hooks/useTranscriptScroll.ts` re-measures from the rows on screen (240px
  until it has a sample): the window grows by 240 rows at a time, so a wrong
  constant is tens of thousands of px of invented height above the reader. That
  estimate is a placeholder for non-iOS rows the controller has not warmed yet,
  not a resting state — it renders the skipped rows a couple at a time while the
  reader is stopped, so each one's real height is already in the geometry when
  they scroll into it, and each row's `content-visibility` is the controller's
  to flip for those two frames and nobody else's.
- `MessageList.tsx` owns NO scroll logic of its own: the container belongs to
  `hooks/useTranscriptScroll.ts` (policy and memory in
  `lib/transcriptScroll.ts`), and this file only supplies the two refs, the
  events the controller cannot see, and the window it can ask to widen
  (`onRequireRows`). Everything that used to be a scroll effect here is now one
  of those hand-offs — "load earlier" holds the row at the top edge
  (`holdVisibleRow`) instead of doing scrollHeight arithmetic, a cross-pane
  `focusEntry` jump hands the resolved row over once per token (`holdRow`, which
  widens the window itself and keeps the row centred while the cards around it
  settle) and only the FLASH stays here, and a committed render calls
  `syncAfterRender` for the changes a `ResizeObserver` cannot attribute (new
  rows, a view toggle) — `sessionStreaming` is one of those, since it mounts the
  standalone Thinking row below a just-submitted turn with the message list
  unchanged. A display preference takes two hand-offs rather than one, because
  the position has to be measured BEFORE the toggled layout exists and the hold
  has to start AFTER it: the controller's `holdViewChange` goes UP to the host
  through `onRegisterViewHold` and `App.tsx` calls it in the event that flips
  the flag, ahead of the transition that renders it, and the commit that carries
  the new flags — told apart here by the token of the five, and it can be
  several interrupted transition attempts later — calls `commitViewChange` in
  place of `syncAfterRender` (`../reference/web-hooks.md`). A flag that reshapes
  rows and is in neither place fails silently. `pinToBottomToken` is `App.tsx`
  saying THIS browser submitted; the transcript deliberately cannot decide that
  for itself. Do not reintroduce a local "am I near the bottom" flag: with two
  owners the reader's own scrolling and the controller's corrections fight,
  which is the bug this replaced.
- `MessageList.tsx` gates the identity of what it hands each memoized row, using
  `lib/transcriptKeys.ts` (see `../CLAUDE.md` for why this is a contract).
  `sessionReferences` was already keyed on id+title for Markdown links;
  `transcriptSessions` now applies the same rule to the raw rows, which reach
  the transcript for ONE reason — a review-spawn card showing its reviewer
  session's title and whether it is still running. Nothing else under here may
  read a session row, or that key has to widen.
- `MessageList.tsx` replaces a system-origin background-work prompt's fallback
  text with `BackgroundWorkPromptCard.tsx`, rendering the typed
  `PromptOrigin.presentation`. The card is a record of one DELIVERY and never
  updates after the fact. It RESTS as one line per update: the Background-work
  glyph (on the first row only; later rows align under it), the job's title cut
  with an ellipsis, and how it ended as a status GLYPH — the shape-per-state
  rule `SessionDeliveryMark` follows, with the word in the accessible name.
  There are five statuses, not two: `stopped` and `lost` are neither success nor
  failure, and `activity` is a monitor that was still running. The line never
  says "Completed · exit 0", because the card only ever appears for a delivered
  update and a `host-process` state IS its exit code
  (`exitCode === 0 ? completed : failed`); a `claude-query` job carries no exit
  code at all.
- Opening one row adds, under that line and without moving it: the outcome
  sentence (`backgroundWorkOutcomeDetail` — the presentation's `outcomeSummary`,
  which for Claude work is the only account of the outcome there is), the
  command through `BackgroundWorkCommand` (`defaultOpen`, since a card the
  reader already opened must not ask twice), retained output through
  `BackgroundWorkOutput`, and the registry row through the host's SPA navigation
  callback. A dropped-update count stays visible while collapsed. Local output
  paths and model-only JSON never enter the browser projection.
- Whether that body repeats the command takes TWO tests, because the title is
  cut twice over. `backgroundWorkCommandDetail` answers the textual one the
  registry row also asks — a description above it, a further line, a cut at the
  store's cap. It cannot answer the second: the top line is ellipsized by CSS at
  whatever width the reader has, so the same one-line command is redundant on a
  desktop and unreadable on a phone, where the `title` tooltip is no answer
  either. The row therefore samples `scrollWidth > clientWidth` on the title
  span in the toggle handler — a single layout read, on a gesture, never on a
  render path — and prints the command when either test says the visible line
  does not already carry it. That same measurement decides the TITLE: a label
  taken from the command is recovered by the command block above, but one taken
  from a description lives nowhere else on the card, so a clipped description is
  repeated once, wrapped, at the top of the body — and only when clipped, since
  a description the row showed whole would just be the line above said twice.
- `BackgroundWorkCommand.tsx` and `BackgroundWorkOutput.tsx` are the two
  expandable facts a background item has, shared by the chat card and
  `BackgroundWorkRow`. The command is on the row already. The OUTPUT is not: the
  panel fetches the authenticated artifact URL only when opened, keeps a 64 KB
  head of it in memory, renders it through `AnsiText` inside `CollapsibleOutput`
  (combined stdout and stderr, as the process wrote them), and can reload; the
  file itself is always one link away whether or not the panel is open, which is
  what keeps "no body on the wire" true — a closed card has fetched nothing.
  There is no live tail: nothing is captured until the item terminalizes.
- `MessageList.tsx` renders one CONDITION on a row rather than on the session:
  `promptQueueStates` maps a row id to where that prompt stands in the permanent
  Assistant's queue, and the user row under it says "Queued" or "Working" with
  the shared `common/load.tsx` spinner. Per-row on purpose — a session-wide
  indicator would be a second, disagreeing copy of the transcript's own run
  state, and these are conditions that may never be announced
  (`../messaging.md`). Only rows named in the map say anything, so the value a
  memoized row receives is a scalar that does not move when the map is rebuilt.
- A forked session renders its inherited prefix like any other row and marks
  where it ends: `MessageList.tsx` draws ONE `data-fork-boundary` rule after the
  last VISIBLE row carrying `DisplayMessage.inheritedFrom` (server-stamped on
  the copy, see `../reference/server-session.md`), labelled with the parent's
  title and opening the source message through the same jump the branch panel
  uses (`App.tsx`'s `openForkOrigin` → a reveal → `focusEntry`, which loads the
  parent's transcript back to the origin rather than stopping at its tail). A
  `focusEntry` names a row by entry id and `messageHasEntry` matches a row's OWN
  id as well as its fork anchors, so a server-resolved anchor (a peer prompt, a
  `#m-` deep link) and a fork origin travel the same path; the host drops a
  focus belonging to another session. Deliberately one marker and not a badge
  per row: the inherited rows are ordinary conversation, and the only thing the
  reader cannot infer is where they stop. Reading the boundary off the RENDERED
  rows is what keeps it honest in a windowed transcript — a window opening past
  the prefix shows no marker rather than claiming this session's own rows came
  from the parent.
- Chat-transcript turn separators + stats (Task 118) are display-only and driven
  by the server `AppSettings.appearance` toggles: `MessageList.tsx` groups the
  FULL message list into turns (via `@assistant/shared/turnStats`, so hidden
  tool activity still counts), computes the per-turn CONTEXT-OCCUPANCY delta +
  running session cumulative, and renders the end-of-turn `<hr>` +
  `TurnStatsRow.tsx` anchored to each COMPLETE turn's last visible assistant
  row; `AssistantMessage.tsx` draws the "before final response" `<hr>` at the
  `finalResponseSeparatorBeforeBlock` index (only passed when tools are
  visible). `TurnStatsRow` keeps three concepts explicit: **Turn** is billed
  input processed across completed provider runs (cache read + cache write +
  uncached input), **Context** is the last prompt snapshot occupying the finite
  model window (used/capacity/%/delta/available), and **Session** is the
  cumulative billed accounting, omitted on the first usage turn because it would
  duplicate Turn exactly. Expanding shows their breakdowns and — only when the
  persisted `turnStatsPerRequest` setting is on — per-PROVIDER-RUN lines; the UI
  calls these runs because one run may contain multiple internal model requests
  in a tool loop. Billed input can therefore legitimately exceed context
  occupancy many times over, and the provider's bare uncached `input` field must
  never stand in for the whole input figure (prompt caching can reduce it to a
  near-zero residual). The COLLAPSED lines are ordered Turn, Session, Context
  and each has to fit one row of a 360 px-wide phone (Task 437), which is why
  their vocabulary is telegraphic (`12.4k in · 340 out · 92% cached · $0.18`),
  the percentages are whole and the cost is two decimals with a `<$0.01` floor —
  precision lives in the `title` tooltips and the expanded breakdown, and
  `flex-wrap` is only the fallback for a larger text scale. Both compact formats
  are CLAMPED so rounding cannot re-tell the lie the honest denominator removes:
  only an exact 1 prints `100%` and only an exact 0 prints `0%` (99.6% cached
  reads `99%`), and a sub-cent cost reads `<$0.01` rather than `$0.00`. A
  character budget in `TurnStatsRow.test.tsx` guards the measured single-line
  fit, since the pixel measurement itself is manual. The row is `memo`ized, and
  `MessageList.tsx` holds each turn's stats entry across a recompute
  (`reuseStableTurnEnds`) so that memo can hold: `accumulateTurnStats` walks the
  whole message list, so one streamed token rebuilt a `Turn` object for every
  completed turn behind it and re-rendered every stats row on screen several
  times a second. An estimated context size (no harness snapshot; see
  `@assistant/shared/turnStats`) renders as `~54k` in both views and its tooltip
  also covers the occupancy percent and delta derived from it, and the expanded
  span is labelled "turn time" because it includes tool execution between runs.
  `SettingsPage.tsx`'s `AppearanceSection` owns the four toggles (browser-local
  panel prefs plus these server-backed chat-transcript toggles). That section is
  the SINGLE appearance surface — theme (there is no separate Theme section; the
  nav bar's Settings slot lands here on desktop, while a bare `/settings` is the
  section INDEX), text size, nav-bar order, panel animations, chat transcript —
  so a new look-and-feel preference belongs in it rather than in a new section.
- `PullRequestCard.tsx` is the lazy transcript renderer for the LIVE `/pr` card
  (stage 2, store-driven like `ApprovalCard.tsx`, not a static
  `command.result`): status badge for `choosing-task` → `creating` → `open` →
  `merged`/`closed`/`failed`, CI/review/mergeability badges while `open`, a Task
  chooser (`onChooseTask`, wired to `choosePullRequestTask`) while
  `choosing-task`, and the provider link, branches, draft, linked Task,
  generated body and warnings once known. Stage 3 adds the ACTION row
  (`onAction`, wired to `runPullRequestCardAction`): a per-merge method picker
  offering exactly the methods the card's `repositoryCapabilities` reports (a
  repository that turned squashing off shows no Squash button; unknown
  capabilities offer none at all and disable Merge, since a guessed method is a
  merge the backend refuses, and a selection the repository stops allowing is
  invalidated rather than sent), a Delete-remote-branch checkbox (checked by
  default, the per-merge opt-out — both travel with the click as
  `PullRequestCardActionOptions`, and only the opt-out is put on the wire) with
  the resulting outcome spelled out under the row, plus Merge and
  Update-with-main while `open`, the danger-toned Clean-up (only once `merged`,
  disabled while the session streams, its consequence stated on and under the
  button) and Mark-Task-done. The local actions resolve the checkout exactly as
  the server does — the card's `worktreeId` first, the viewed session's
  `sessionWorktreeId` as the fallback — so a card minted without one does not
  hide a button the server runs; `worktreeLiveSiblings` (counted in
  `MessageList.tsx` from the session list) lets Clean-up name the other live
  sessions on that worktree that it will settle too, and is ignored for a card
  pointing at a different checkout. Buttons are disabled from the card's
  SERVER-side `busyAction`, never a local spinner, so every viewer sees the same
  merge in flight; `actionError`/`actionMessage` render right where the button
  is. A `conflicts` card is the one state that reorders that row: merge, the
  method picker and the branch checkbox go disabled, Update-with-main takes the
  accent treatment, and a warning line replaces the branch-outcome sentence to
  say why (and, without a checkout to update, what to do instead). Once that
  update conflicted and its prompt was accepted (`rebaseHandedOff`) the same
  button reads "Agent is rebasing" — busy, disabled, no longer primary — for as
  long as `sessionBusy`, and the warning line points at the session instead of
  at the button; when the turn ends the offer comes back, because an agent that
  gave up must not leave the card a dead end. Without an `onAction` handler no
  action is offered at all. `AssistantMessage.tsx` registers the `pullRequest`
  display block beside the lazy commit/push cards. Settings exposes the
  independent `prAgent` model slot as the Developer workflow → Pull request
  agent section.
- `AboutSettingsSection.tsx` (settings section id `about`) lists which build
  each part of the app is running: the browser bundle (`lib/appBuild.ts`), the
  server (`ready.serverBuild`, held by `useAssistant` as `state.serverBuild`)
  and, only in the native shell, the installed binary (`nativeShellBuild()`
  through `useFetchState`, since a browser has no shell row to show). Rendering
  is the shared `formatBuildInfo`, so the rows read exactly like the desktop
  About panel. A server that has not answered yet says so rather than borrowing
  the bundle's version — the whole point of the surface is that the three can
  differ — and the copy button yields all rows as one pasteable block, unknowns
  included.
- `SettingsPage.tsx`'s `DictationSection` (settings section id `dictation`,
  "Dictation") owns the composer-dictation surface backed by
  `AppSettings.speechToText`: the show-the-button toggle, a model picker
  rendered ONLY when the server reports more than one installed model, a health
  line from the `SpeechToTextStatus` prop (`configured`/`reason`, so an instance
  without a deployed model explains itself here as well as on the button), the
  Advanced `Disclosure` for threads/idle-release/max-utterance, and the
  vocabulary editor. Vocabulary rows are LOCAL DRAFT state, not a direct
  projection of the persisted array: the server's normalizer drops rules with an
  empty spoken form, so rendering straight from settings deletes a freshly added
  blank row before it can be typed into — making it impossible to add a rule at
  all. The draft is initialised once per mount (an external edit therefore
  appears on the next visit rather than yanking the row being typed in), and
  only complete rules are persisted. The "Try it" preview runs
  `applySpeechVocabulary` from `@assistant/shared` — the same function the
  server applies after decoding, deliberately shared so the preview cannot lie —
  against the DRAFT, so a rule can be tested mid-edit. A **Recent dictations**
  card (from `lib/recentTranscripts.ts`, browser-local, hidden when empty) lists
  what the recognizer actually wrote with a relative age; tapping a row loads it
  into "Try it" and focuses it, which is how you author a rule without having to
  remember the misheard wording. Its copy must keep stating that the text is
  kept in this browser only, since that is the honest description of where
  dictated text lives.
- `PushNotificationsSection.tsx` owns Settings → Notifications
  (`notifications`): installation-local Declarative Web Push enable/disable,
  direct user-gesture permission requests, denied/unsupported guidance, and
  existing-subscription re-registration. It is deliberately not an `AppSettings`
  toggle because permission/subscription state belongs to one browser or iOS
  Home Screen installation. The initial copy discloses that session names can
  appear on the Lock Screen. In the native shell it renders an entirely
  different panel and runs none of the push probing: there is no subscription to
  create there, and asking anyway produced a browser-shaped verdict ("blocked,
  allow it in Settings") about a permission WebKit never offered. What it shows
  instead is the two facts that differ — alerts ride the app's own connection,
  so they arrive only while it runs, and the OS owns the permission — plus a
  test button, because otherwise the only way to check the wiring is to wait for
  a real turn to finish.
- `SettingsPage.tsx`'s `ProfileSection` (settings section id `profile`) edits
  `AppSettings.profile`: the display name and the IANA timezone, both drafted
  locally and saved on blur, an invalid zone never saved, the placeholder naming
  the server zone an empty value follows (`docs/user-profile.md`).
- Dictation splits "the mic is occupied" from "the row belongs to the audio":
  `isDictationBusy` (recording/starting/transcribing) disables the mic, while
  `isDictationRecording` (recording/starting) is what takes the composer's field
  and forces the compact bar. Only the microphone phase may hold the bottom edge
  — decoding is server-side at ~0.05x realtime plus a cold model load, and
  freezing the draft for that wait was the composer going dead after every
  utterance. While transcribing the field returns to the draft, Send comes back,
  the dock's sheet unblocks (there is no Stop to cover), and only the mic spins.
  The transcript still lands at the caret remembered at dictation start, EXCEPT
  when the editor has focus — a draft edited while decoding moved the caret, so
  the live selection wins and a remembered caret is clamped to the text.
- `DictationControls.tsx` owns the SHARED dictation surface pieces (trace,
  discard, mic/stop/spinner toggle, `isDictationBusy`, `isDictationRecording`,
  `formatElapsed`, live region) rendered by both hosts of a recording row, so
  the recording state cannot drift between them; the idle arrangement stays per
  host. Two rules about the toggle are deliberate. Arming (`starting`) shows the
  PULSING MIC, never a spinner: a spinner claims something was asked and is
  being answered, while what is actually happening is the microphone and the
  socket opening. Only `transcribing` — a real server wait — spins. And STOP
  acts on `pointerdown`, not on the click: it is the control aimed at
  mid-sentence and one-handed, and a touch click arrives only after the browser
  finishes ruling out a drag or double tap, which is felt as the button having
  missed. That is safe only because the dock cannot be dragged while a recording
  holds it and stopping is not destructive (it delivers the utterance); STARTING
  stays on the click, so a press that turns into a drag never opens the
  microphone. Two size flags are the only thing a host may vary, and neither
  changes the look: `dense` for the trace and discard, which the dock renders
  inside its 36px composer field (trace loses its own height/padding, discard
  drops to 28px), and `steady` for the toggle, which keeps `idleSize` in every
  phase because the dock's row is exactly `BOTTOM_CARD_ROW_PX` tall and a
  recording must not grow the bar — so THERE stop is told apart by its red fill
  rather than by growing past the mic.
- `SessionDockActions.tsx` owns everything in the mobile object dock's action
  row on a session screen except back — the bottom bar the composer used to
  collapse into. The row is BOOKENDED two controls a side around the
  `DockComposerField`, and that symmetry is structural: the field sits between
  equal clusters so it lands on the grabber's axis (inset 44px one side and 4px
  the other, it read as shoved sideways with its corner against the card's), and
  those clusters sit 16px off the screen — `ObjectDock`'s row padding on top of
  the card's gutter — because the outermost control now sends. The sides split
  by what they act on. The left pair leaves the conversation: back, then the
  single `contextSlot` — the session's worktree with its dirty dot, else the
  object it hangs off, else the composer's paperclip via the composer's
  `attachRef`; on a screen whose session has not been sent yet it is instead
  that screen's staged-context picker, since there is no object to jump to and a
  worktree is one of the things that picker stages. The right pair belongs to
  the message, in the composer toolbar's own order: the mic, then
  `DockPrimaryAction` — Send, enabled exactly while `draft` is non-empty, which
  reaches the composer's `submitRef` because the text lives there and this row
  only ever sees the bounded preview. That FIELD is what makes this a chat
  screen's bottom edge rather than any other object's: the row is the resting
  composer, so it wears the composer's border and shows the composer's own
  placeholder (`COMPOSER_PLACEHOLDER`, shared with the textarea and the compact
  bar so the three faces of one input cannot word the invitation differently) or
  the unsent draft itself — which retired the dot the compose glyph carried,
  since the text says both that something waits and what it was. An icon-only
  row was legible only if you already knew the pen meant "message", and on the
  new-session screen it left nothing input-shaped on the page. The box holds
  only what belongs to the TEXT — the face, and while dictating the trace with
  its discard — because a mic squeezed inside it was 32px against back's 36px
  and read as a detail of the field rather than a control. Both right slots keep
  their place in every state, so only the interior changes: while a TURN runs
  the face goes inert with `COMPOSER_STREAMING_LABEL`, the mic greys out in
  place and `DockPrimaryAction` becomes Stop in the composer's own stop tone
  (`COMPOSER_STOP_TONE_CLASS` — a filled box, not one more ghost glyph, and not
  danger-toned either, since interrupting a turn is ordinary, exactly as the
  composer swaps the two faces of one button); while RECORDING the trace takes
  the field, Stop takes the MIC's slot and Send waits inert for the sentence to
  land. Restore the live controls mid-turn when the composer can steer or queue.
  The changes control wears the WORKTREE glyph (`GitBranch`), not a diff one, at
  every width — this row, `SessionInspector`'s action and the desktop chat
  header are the same control, and it navigates away to that worktree's screen,
  so it shows where it lands and lets its dot carry "there is something
  uncommitted". It owns `useDictation` because it renders the trace, reports
  `onActiveChange` so the host can block the SHEET mid-recording (the row itself
  no longer stands down — the trace gets its width from the field, not from back
  and the changes button stepping aside), consumes the held `startRequest`
  hand-over from the expanded composer's mic (the row does not exist when that
  mic is pressed, so the request has to survive its mount), and emits the
  finished transcript as data.
- `StagedContext.tsx` owns the composer's composable pre-session context
  surface: the removable chip row (`StagedContextBar`, rendered above the
  textarea ONLY when context is staged) plus the tap-first accordion picker
  (`StagedContextPanel`) that `Composer.tsx` renders inside a `ChatDockPanel`
  dock sheet. The entry point is a `Plus` toolbar button next to the attachment
  button (present whenever `Composer` receives `contextBar`, i.e. a fresh
  new-chat route); the empty-state "Add context" text button was removed so
  there is no duplicate affordance (the staged chips themselves convey what is
  attached). It edits Project + Worktree + Task together with derivation
  (picking a worktree/task fills the project; re-picking the project drops a
  worktree/task that no longer belongs to it) — App.tsx owns the derivation
  handlers and the underlying
  `pendingProjectContext`/`pendingWorktreeContext`/`pendingTaskAttach` state.
  Attaching a Task must NOT clear the staged project: `stageTaskContext` derives
  it from the Task and the bar shows it as the implied (dimmed, non-removable)
  project; the send path already ignores `pendingProjectContext` when a Task is
  attached, so the derived project is display-only. The Task field reuses the
  left-panel `BacklogList` (same rows/filtering) via a lazy `renderTaskPicker`
  render prop (App supplies it, pinned to the staged project via
  `fixedProjectId`); it mounts only while that field is expanded. The
  `OptionList` filter input is NOT autofocused (tap-first; autofocus would
  re-open the mobile keyboard the dock sheet just dismissed). A staged Knowledge
  entry (its own start path, not part of the Project/Worktree/Task accordion)
  appears in the bar as a removable `knowledge` chip. Developer↔worktree
  coupling (Task 119, server-enforced counterpart in
  `app/server/src/connection.ts`): picking the Developer agent without a staged
  worktree is signalled ONLY by the send-blocked hint (the
  `Composer.contextOpenRequest` token+field prop →
  `StagedContextPanel initialField` plumbing remains for the hero's "More…"
  card, with a token ref-guard so a stale request never re-opens on remount),
  staging a worktree auto-switches the staged agent to the coding persona and
  removing it (chip X or a project re-pick that drops it) reverts a staged
  Developer to Assistant (App.tsx `stageWorktreeContext`/`stageProjectContext`
  via `switchStagedAgentType`), and while Developer is staged worktree-less the
  send is disabled with a tappable amber hint ABOVE the composer card
  (`Composer.sendBlockedReason`; the fixed-height slot is reserved whenever
  `contextBar` is present so the hint toggling never shifts layout; App belt in
  `sendPromptWithRuntime`). A staged "+ New worktree"
  ([Task-240](pa://task/240)) satisfies that guard exactly as a real worktree
  does and takes the same persona coupling: it rides
  `StagedContextValue.newWorktree` (a FLAG beside `worktreeId`, never a sentinel
  id — a fake id would have to be excluded again in every place that resolves a
  worktree), renders as a removable chip, and is offered by both the hero row's
  card and the sheet's `OptionList leadingAction` only while a project is
  staged, since a checkout needs a repository to be created in.
  Companion/inspector composers for non-worktree objects receive
  `worktreelessAgentTypes` (Developer filtered out); the worktree inspector
  keeps the full list. Guarded by `StagedContext.test.tsx`. Opening the
  context/runtime/branches dock sheets calls `Composer.blurComposer` (blur +
  unpin) so the composer collapses to its compact bar and the sheet gets the
  full height / the mobile keyboard closes; closing a sheet (its `onClose`, or
  re-tapping the runtime/branches toggle) runs `dismissSheetsAndFocus` — a
  synchronous refocus that re-expands the composer and reopens the keyboard
  within the tap gesture, so no extra tap is needed to resume typing. EXCEPTION:
  a sheet opened from OUTSIDE the composer (`contextOpenRequest` — the hero
  quick-start "More…" card) closes without refocusing (`sheetOpenedExternally`,
  reset by every composer-chrome sheet open), because the user wasn't composing
  and the refocus would pop a mobile keyboard they never had open. The
  new-session landing anchors the composer at the bottom rather than vertically
  centering it. Structured review handoffs also appear in this bar as a
  removable review-comment-count chip beside their required worktree; the
  ordinary Project/Worktree/Task picker does not edit the bundle itself.
- `NewSessionQuickStart.tsx` owns the new-session landing's quick-pick rows. The
  rows, cards and sliders themselves come from `common/RuntimePicker.tsx`
  (shared with the workflow start sheet); this file owns which of them the
  landing shows, in what order, and what a pick stages. Enabled credential
  profiles are selectable as horizontal account cards in the runtime block
  immediately after Agent and before Model; cards carry the provider brand icon
  and are grouped Claude profiles first, then OpenAI profiles, preserving
  registry order within each provider. Each card carries a fixed-height
  subscription-usage slot (`common/UsageCycleMeters.tsx`) in place of the old
  provider label line, fed by `usageIndicators` from the `usage` broadcast
  topic; the provider word moved into the card's `title` (and the provider
  icon's own label — deliberately NOT an `aria-label` on the button, which would
  replace the accessible name and hide the meters from a screen reader) because
  several accounts can share one provider, so the NAME has to stay visible. A
  once-a-minute local clock ages those rows, since a snapshot goes stale (and a
  window rolls over) with nothing arriving to say so. Choosing one scopes the
  model cards to that account/provider and the profile is sent only on the
  session's first prompt. There is no profile dropdown. Settings profile changes
  notify the new-session picker immediately, while an established session always
  keeps its own model list and binding. It renders (Tasks 119/120; there is NO
  Task row — staging a Task from here went unused, and the space belongs to the
  rows that are; a Task is still staged through the composer's context sheet.
  There is NO hero greeting line — layout stability beats a greeting, the
  composer placeholder carries it), top to bottom — context rows, then an `<hr>`
  ruler, then the runtime block (Agent/Provider/Model/Thinking): Project (chips,
  active projects only, >1 only; staging narrows the worktree cards; while
  `projectsLoaded` is false the row renders same-height skeleton pills),
  Worktree (ALWAYS rendered: snap-scroll two-line cards, main checkouts
  included, tapping the selected card clears; the project line stays even when a
  project is staged; an empty scope renders a same-height dashed "No worktrees"
  placeholder so the row never collapses; a "More…" card (Ellipsis icon — the
  semantic is "there is more to select") opens the composer's context sheet on
  the Worktree field, rendered ONLY when the row shows worktrees AND the scope
  hides others; while `worktreesLoaded` is false the row renders same-height
  skeleton cards so the landing doesn't jump; the row ends with a dashed "+ New
  worktree" card, rendered only with a project staged and staging through App's
  `stageNewWorktree` so the first send provisions it), Agent (`QuickPill` chips
  like every other row, personas from `agentTypeDisplay.ts`'s
  `AGENT_TYPE_DISPLAY`, hidden with <2 personas; picking Developer without a
  worktree gets NO extra highlight/sheet — the send-blocked hint above the
  composer carries the nudge) SHARING one row with Mode (Build/Plan pills,
  rendered where the staged persona has the axis, driving the same
  `runtimeActions.setSessionMode` as the composer pill; the landing has to STATE
  the mode, since a mode visible only in the composer's pill strip is how an
  inherited Plan went unnoticed) — the shared row is `QuickRowSplit`, two
  labelled listboxes that WRAP instead of scrolling, so a narrow phone gets both
  groups in full on two lines; either axis alone falls back to its own
  `QuickRow`. Then Model (pills), and Thinking — a discrete slider
  (`ThinkingSlider`: native range input over a custom track with one visual stop
  per `supportedThinkingLevelsForModel` level and the selected label centered
  below; stops/fill are half-thumb-inset to align with thumb travel). Selection
  is conveyed by accent border/background/text only — NO trailing check icon,
  which would change the selected item's width and shift the row. All rows drive
  the SAME App staging state as the composer chips/sheet (`stage*Context`,
  `switchStagedAgentType`, `runtimeActions`); Model/Thinking hide without ≥2
  choices, and it renders only while `App.tsx`'s `showContextPicker` is true.
  Rows are horizontally CENTERED when they fit via an inner `mx-auto` wrapper
  inside the scroll container (cross-browser, unlike
  `justify-content: safe center`); overflowing rows fill and scroll as before.
  The landing container in `App.tsx` adds NO horizontal padding: every row owns
  the page gutter INSIDE its scroller (`px-4` plus matching `scroll-px-4` so
  snapping lands on the inset; the labels, the `<hr>`, and the thinking slider
  match it), so cards rest at the composer's inset but scroll edge-to-edge on
  mobile instead of being clipped by a dead outer margin. `QuickRow` takes a
  `scrollKey` (selected id + item count): on change it scrolls the row's
  `data-quick-selected` item into view — instant on first render, smooth after —
  so initial selections AND automatic ones (worktree→project) are always
  visible. Also exports `orderWorktreesByActivity` (most recent linked-session
  `updatedAt`, falling back to the record's own timestamp — synthetic mains
  carry `updatedAt: 0` so they rank by session activity only); App pre-sorts ONE
  ordered list used by both the hero row and the context sheet.
- `Topbar.tsx` is what is LEFT of the app header: on wide layouts only, and
  holding the leading back/forward history arrows plus, at the trailing edge,
  the theme toggle and the grouped `PanelLeft`/`PanelRight` pair. Everything
  else found a better home — the app-level actions (Personal Assistant, New
  Session, Usage) are configurable slots in the sidebar's nav bar, and small
  screens render no app header at all (`App.tsx` passes none, and
  `shell/AppShell` then owns the top safe-area inset). It survives on desktop
  because a closed sidebar cannot host the control that reopens it, so those two
  toggles have nowhere else yet. The pair is one control shape, so they sit
  tighter than a lone action; both use the muted icon style (`ACTION_CLASS`),
  since accent coloring read as permanently activated. There is NO logo and NO
  global search/command field: the search went unused, and the identity block
  was the last thing keeping a bar nobody needed. The arrows lead the bar for
  the reason the toggles trail it — they are window chrome, and every window
  that has ever had them puts them top-left — and they read their enabled state
  from `lib/historyNav.ts` through `useSyncExternalStore`, since the position
  changes from outside React. They sit AFTER the leading drag inset, and
  deliberately carry no `data-tauri-drag-region`: a marked control drags the
  native window instead of being pressed.
- `PageHeader.tsx` owns the shared below-topbar header. `density="compact"` is
  the phone shape once a header has been cut back to identity: one ~44px row,
  and `subtitle` is IGNORED rather than squeezed, so a caller must not rely on
  it being rendered there. `onIconClick`/`iconLabel` turn the icon box into a
  button for the one control that belongs ON the identity rather than beside it
  — copying what identifies the object (a session's id, a Task's `Task-123`).
  That is now a rule rather than a one-off: the glyph copies the identifier, on
  every page that has one. The tone box and its geometry stay here so a
  clickable glyph cannot drift from a decorative one. It also owns the mobile
  screen **back** affordance: a `back?: PageHeaderBack` prop (label = the
  section it returns to) rendered as `PageHeaderBackButton` in the leading
  position: it REPLACES the decorative `icon` box (title width beats a glyph on
  a phone) but yields to a functional custom `leading`, which it then precedes.
  Every main-pane surface takes `back` and forwards it to its own header
  (`App.tsx`'s chat header, Task detail, Project detail, Worktree detail,
  Knowledge entry/file/state views, Settings, Usage; `calendar/CalendarPage.tsx`
  renders `PageHeaderBackButton` directly in its toolbar, which is its page
  header). App supplies ONE object for all of them and only on mobile, so back
  stays a single rule rather than per-surface behavior; it never calls
  `history.back()` (see `../docs/ui-shell.md`, Small Screens). It is also
  `undefined` on the screens whose object dock carries back in its action row
  instead, which is most of them — a surface must therefore still look right
  with `back` absent, falling back to its own leading control or icon box. And
  on a phone a surface may render NO header at all when its content already says
  what it is (the new-session screen; see `../CLAUDE.md`), so nothing may depend
  on this row existing for layout or offsets.
- `agentTypeDisplay.ts` owns `AGENT_TYPE_DISPLAY`, the per-persona
  label/icon/tone/description registry: ONE definition of what an agent looks
  like, shared by the composer's persona picker, the new-session Agent row and
  the Sessions inbox cards. It sits outside `Composer.tsx` so the sidebar can
  render an agent icon without pulling the composer into its chunk.
- `primaryNavSections.tsx` owns `PRIMARY_NAV_SLOTS`, the label/icon registry for
  the sidebar's nav bar (the `settingsSections.tsx` pattern), shared by
  `Sidebar.tsx`'s bar and the Settings order editor. Sections and the app-level
  ACTIONS are one flat table, because the bar renders them as one flat row; it
  carries NO counts and NO order — order is `prefs.navSlots` — and the Personal
  Assistant's label is overridden by the host with its configured name.
- `SessionRow.tsx`'s `SessionRow`/`SessionRowContent` are `memo`ized on
  `lib/sessionRows.ts`'s `sameSessionRowProps`, and every callback prop
  (`onActivate`/`onToggleCollapse`/`onArchive`/`onDelete`) takes the SESSION ID
  rather than closing over the row — a per-row arrow is a fresh identity on
  every parent render and defeats the memo unconditionally, which is how these
  rows used to re-render entirely on each session broadcast (~4x/second while
  any agent streams, measured at 59/59 production rows → 1/59, and ~45 µs per
  row of static render on a warm desktop). Callers therefore pass their own
  stable handlers straight through (`Sidebar.tsx`, `ProjectTreePane.tsx`), and
  `App.tsx` keeps those handlers `useCallback`-stable across list broadcasts.
- `SessionDeliveryMark.tsx` is the ONE indicator that a session owns a `/pr`
  card, at both widths ([Task-342](pa://task/342)): the worded chip on the
  Sessions inbox's cards, the glyph alone on one-line rows (`SessionRowContent`
  under a Project or Worktree, both inbox shelves), so a phone and a desktop
  cannot state different things. The glyph is chosen per STATE and the tone
  rides on top of it, never the other way round: on a one-line row the mark is
  the whole indicator, and a mark that varied only in colour said nothing to a
  reader who cannot separate the tones. The problem states leave the
  pull-request icon family on purpose — an alarm shape is what reads at 11px —
  while `choosing-task` stays in it for the mirror-image reason: the obvious
  glyph for a question is the `CircleHelp` a row already renders one item away
  for `awaitingInput`, and two identical accent circles say "something is
  asking" twice without saying which. `creating` is the one state with no glyph
  at all: it is an act under way rather than a shape, so it draws
  `common/load.tsx`'s `Spinner` (Task-391) — what stood there before was the
  app's spinner glyph held still, which to a reader who knows it is a spinner
  that died. It reads `lib/sessionDelivery.ts` and renders no link: the card
  lives IN the session, so the row is what opens it, and a second target inside
  the row would compete with the one already leading there. Every host also
  names the state in its own `aria-label` — those rows are single
  `role="button"`s whose label REPLACES their content, so a chip left out of it
  is announced nowhere.
- `SessionStage.tsx` owns the chrome the chat stage draws while what it shows is
  not the live transcript: `PendingSessionPanel` (the R4 silhouette that names
  the session being opened — every in-app switch, and any chat this browser has
  never opened), `SessionRefreshMark` (the R2 mark over a cached boot paint,
  floating rather than in a header because the transcript's top edge is
  hit-tested for the reader's row) — those two are alternatives, never both —
  and `SessionBootstrapNarration`, the line under a first prompt whose session
  does not exist yet. That one adds itself to the stage rather than standing in
  for it, between the transcript and the composer: it says what the bootstrap is
  doing ("Starting session…") or, when the send failed, carries the blocker and
  the retry beside the prompt it belongs to. `lib/newSessionShell.ts` decides
  which of the two it is and whether it renders at all — the
  worktree-provisioning card is the same source's narration and takes
  precedence. Contract: `app/web/docs/loading-states.md` § The chat stage.
- `PerfHud.tsx` is the dev-only performance overlay (`import.meta.env.DEV`,
  toggled with Ctrl/Cmd+Shift+P, mounted by `App.tsx`): bytes and message counts
  per server-message type per second, plus commit counts for the instrumented
  subtrees (App, Sidebar, MessageList, BacklogList) over the same second. It
  exists so a performance claim in this client is a measurement rather than a
  memory — every earlier number here came from hand-instrumenting for one
  investigation and then deleting it.
- `Sidebar.tsx` and `BacklogList.tsx` are `memo`ized (see `../CLAUDE.md` for the
  props contract that keeps that real). The sidebar is the left pane of every
  screen, so an unmemoized one re-renders its whole browser on every app state
  change; `BacklogList` is memoized inside it as well, because a session-list
  broadcast legitimately re-renders the sidebar's session tree and must not drag
  ~220 Task rows along with it. `BacklogList` takes the narrow `BacklogState`,
  never `UIState`.
- Background work has three surfaces, all reading the same
  `lib/backgroundWork.ts` projection ([Task-486](pa://task/486)).
  `BackgroundTasksPage.tsx` is the canonical `/background-tasks` registry:
  Active/Recent/All filters, free-text search over the label and the owning
  session's title, a 25-row RENDER page with an explicit **Show N more**,
  per-owner **Stop all**, and a link from every row to its owning session. That
  page is a cutoff over the rows this browser HOLDS, and those rows are
  themselves the server's bounded window over the registry
  ([Task-656](pa://task/656)): the two bounds are independent, and neither is a
  paged transport — no surface can ask for the next window yet. When the
  snapshot says it cut (`backgroundWorkList.truncated`), the page says so under
  the list rather than letting **Show N more of M** present its window as the
  whole registry. `?task=<id>` pins its row past the render cutoff and
  scrolls/focuses it once the snapshot delivers it — a deep link whose target is
  merely unrendered is worse than one that does not scroll, because nothing on
  screen says the link worked. A link to work older than the server's window
  resolves to nothing at all, which is the remaining gap a scoped or cursored
  read would close. `BackgroundWorkSection.tsx` is the same rows inside the
  owning session's inspector. It subscribes through
  `backgroundInspectorSubscribes`, which reads four things and none of them is
  data about the work: the inspector is on screen, the route is a session route,
  its id is nonempty, and that id is in the authoritative session LIST. It
  deliberately never reads `backgroundActivity` or rows this tab already holds —
  a cold direct load of a session whose work has all FINISHED has neither, and
  gating on either would make its Recent list depend on this browser having
  watched the work end. The list membership check is the one that looks
  redundant and is not: any nonempty id parses as a session route, so without it
  `/sessions/does-not-exist` would be handed the global snapshot for a session
  that was never real. The loaded-session snapshot is NOT a membership answer,
  since the server answers a view of an unknown id with a placeholder carrying
  that id. Bounded to five per group, plus the shared Settle/delete blocker
  sentence and a link back to the registry. It reads the SAME bounded window as
  the registry page, so a session whose work finished long enough ago to fall
  outside it shows an empty Recent list: the section cannot ask for its own
  session's history until a scoped read exists. `BackgroundWorkRow.tsx` is the
  one row both render, memoized on `backgroundWorkRowKey` (rendered labels, not
  raw timestamps) and taking ids in its callbacks. The browser owns NO lifecycle
  state: Stop and Stop-all send `stopBackgroundWork`/`stopAllBackgroundWork`,
  the pressed control goes busy, and every row fact arrives as a `background`
  state event. A retained host that Stop-all could not close shows the
  protected-turn WAIT rather than a completed close. No vendor or OS id,
  environment, credential, output path or output body reaches these surfaces —
  they stop at the server's one narrowing, and evidence appears as bounded
  size/truncation metadata or a refusal's bounded reason with no content.
  Retained OUTPUT is reachable only as a link through the authenticated artifact
  API (`lib/serverOrigin.ts`'s `artifactHttpUrl`), and only from the inspector:
  the owning session's artifact drawer is the one place `evidence.artifactId`
  resolves to a URL, so a registry row states the capture's facts and sends you
  to the owner. The id itself is never rendered as a substitute.
  `BackgroundWorkLedge.tsx` is the fifth surface: the composer's one-line answer
  to "what is running in the background for THIS session", and the list behind
  it on a tap. Its collapsed line reads the session row's own
  `backgroundActivity` and subscribes to nothing; `App.tsx` mounts it only on a
  session route whose session has that projection (active work or a retained
  host), so an idle session pays no line. Opening it is what subscribes the
  browser to the registry topic (`topicsForSurface`'s `backgroundLedgeOpen`),
  and the rows it lists are the registry's own active rows for the session
  through `BackgroundWorkRow`, each with Stop and an **Open in the background
  registry** link, plus Stop-all. Finished work is not here: the inspector
  section and the registry hold history, the ledge is LIVE state only.
  `useElapsedNow.ts` is the ticker they and the composer's other ledge share — 1
  s while anything runs, 60 s otherwise — held in `components/` rather than in
  the shell because those surfaces are all it serves. `ActiveSessionCard.tsx`
  renders the fourth surface: a DISTINCT `Background 2 · 8m` chip on the state
  line, after the provider status and without its spinner, named separately in
  the card's `aria-label`. It sets and derives nothing about `isStreaming`,
  `runStartedAt`, provider run state or unread — a session can be provider-idle
  and background-busy at once, and a concurrent provider run keeps its own
  `Working 12s` badge beside the chip.
- `SpawnedSessionsLedge.tsx` is the composer's SECOND strip: what this chat
  spawned. It is the cluster card's fold in another place, and it is aligned
  with it on purpose, item for item. Collapsed it is one line —
  `3 sessions · 1 running · 2 jobs · 4 settled`, the card's own verb-less words
  through `spawnedSessionsSummary`; while any peer is WORKING the line runs in
  the accent with a spinner in place of the peer glyph, which matters more here
  than on the card: the session you are typing into is usually quiet while its
  peers run, so this strip is the only place that run is visible and a static
  count reads as a stalled cluster. The verb the line drops lives in the
  toggle's spoken label (`Show the sessions this chat spawned — …`; SPAWNED
  rather than the card's "coordinated", because this projection keeps a peer the
  user has taken over and the label may not claim a relation that has ended) —
  the card can let its title supply it, a strip on the composer has no title to
  supply it from. Under the line, when a peer is waiting on a human or holding a
  failure, that peer is NAMED (`Answer in “Reviewer”`) and is a link straight to
  it, on a line of its own so it costs height only while something needs
  answering and the two strips' chevrons stay in one column; a bubbled FAILURE
  carries the same dismissal the card does (`clusterBubbleDismissible` → that
  peer's own Settle). Opened, it lists the peers as `ClusterChildRow`s — the
  same row the Sessions inbox renders a folded peer with, so a peer looks and
  reads the same wherever it is found — as a TREE of every peer at every depth,
  each indented under the session that spawned it, siblings by latest activity,
  newest on top, NOT in the inbox's tier order: the list is read as "what just
  happened among my peers", and the tiering is already on the collapsed line as
  the counts and the bubble. Dormant settled peers are history — never counted,
  and listed only behind a `Show N settled` button at the FOOT of the list (a
  settled peer running or holding jobs again is live, listed and counted); the
  host answers it by rebuilding the view with them for that session alone
  (`App.tsx` keys the state by session id, so switching chats starts with live
  peers only, and closing the strip forgets it). The list is capped in height
  and scrolls in place, so listing every peer changes what is in the box, never
  how tall the composer's shelf is. It SUBSCRIBES NOTHING: `App.tsx` derives it
  from the session list this browser already holds (`spawnedSessionsView`),
  mounts it only for a session with peers, live or settled, so the ordinary chat
  pays no line, and holds the node on `spawnedSessionsKey` so a rebroadcast that
  changes nothing the strip draws does not re-render the memoized composer —
  which is why that key asks whether the strip is OPEN (`web-lib.md`). Dismissal
  is the ONLY lifecycle action here — Archive, Delete and a peer's own Settle
  stay in the inbox, and `ClusterChildRow` binds those keyboard shortcuts only
  when its host passes the handlers, because a row must never appear to
  acknowledge or destroy something its surface cannot undo. Its rows ARE tab
  stops (`tabbable`), which the inbox's are not: there is no roving focus above
  them here, so without it the link would be reachable by pointer alone.
- The Sessions section's browser is an INBOX of the working set, not a history
  list: `SessionInbox.tsx` owns it (search, the labelled **Needs you** block,
  one priority-sorted list for everything else still unsettled, the compact
  **Settled** shelf, and the existing lazily-loaded **Archived** group — both
  headed without a count, since the size of the history is not a decision),
  `ActiveSessionCard.tsx` owns the rich card (three lines with a state, two
  without), and `InboxShelfRow.tsx` owns the one-line row BOTH shelves use —
  Settled and Archived are different states but the same kind of thing (work you
  have put down), so one component renders them and the Archived group no longer
  borrows `SessionRow`. Neither shelf row ever shows an unread marker: archiving
  or settling MARKS THE SESSION READ server-side (`sessionStore`'s
  `markReadThrough`, plus a projection guard for rows shelved before that rule),
  because an unread badge on a surface with no way to clear it is a
  contradiction. "Active" means UNSETTLED — a finished-but-unread run, a failed
  run and a quiet conversation are all still work — so only an explicit Settle
  (or Archive) takes a session out, and only an OUTCOME puts it back
  ([Task-674](pa://task/674)): a settled session runs its next turn from the
  shelf, and the completion or failure that turn produces is what wakes it. Row
  height follows lifecycle value, and the card spends its lines deliberately —
  three with a state, two without: line 1 is the AGENT's own icon
  (`agentTypeDisplay.ts`, in the agent's own color — the persona is therefore
  never also named in text) plus the title and a compact age; line 2 is the
  state as a short coloured BADGE
  (`Answer`/`Approve`/`Failed`/`Done`/`Working 4m`; a quiet session shows none,
  and with nothing else on the line — no queued-work detail, no pull request, no
  background chip — it renders no line 2 at all, so a quiet card is two lines
  rather than three, since "Waiting for your next prompt" restated the absence
  on nine cards in ten; the running one also carries a spinner, since a badge
  whose only change is a minute counter reads as stalled — and that spinner is
  ALL of it: the card's own bottom rule stays the list's ordinary separator,
  because a second, differently-styled rule under every working card restated
  the badge as a change in the list's shape) followed by what the badge cannot
  say, above all the failure message, and then — last, so it takes none of that
  text's width — the session's delivery chip (`SessionDeliveryMark`, on this
  line because it is the OTHER thing that can be waiting on you, and
  fixed-width, so it survives the truncation rather than causing it); line 3 is
  the objects the session hangs off — the Project as its short KEY behind the
  Projects icon tinted with that Project's color, the branch behind the
  Worktrees icon, the Task as `#227` behind the Tasks icon
  (`primaryNavSections.tsx`'s icons; a card's relations must look like the
  sections they lead to), then fork lineage. Every item NAMES an object the
  session hangs off, which is why the model and the Task progress counter were
  dropped: they were the only items that stood for nothing. Each object is
  opened from exactly ONE target: the worktree and the Task from the fixed JUMP
  buttons beside the line, in the space under the age (the metadata text clips
  with the line, these never move), and the Project from its text item, which
  has no button and, first on the line, never clips. The worktree and Task items
  used to be links too, and a text link beside a button for the same object was
  two targets one item apart. A metadata item states WHICH object, never that
  object's state — the dirty dot is the worktree jump button's alone, since two
  dots one line-item apart for one fact read as two facts — and the Task the
  button names is the single Task whose `sessionRefs` claim this session.
  Several claimants means no Task at all; a card must not pick one arbitrarily.
  Actions live in a RIGHT GUTTER of two targets — Settle on top (a plain
  `Check`; the circular one read as a Task status) and a VERTICAL `⋮` below it
  (the row is vertical, and the horizontal glyph read as a menu belonging to the
  line beside it) — drawn with NO border or divider of their own: cards are
  SQUARE and separated by a bottom rule, so a gutter border would have read as
  one continuous vertical line down the list and the hover tint would have been
  cut in two. `⋯` does not open a popover: it flips the card in place
  (`rotateY`, `motion-reduce` disables the transition) to its own **Actions**
  face — the relation jumps (worktree, Task) when they exist, then Rename /
  Archive / Delete, as icon+label tiles with a close gutter — so the actions are
  as big as the card and never a menu floating over the list. Those tiles are a
  FIXED size centred in the card's height rather than stretched to fill it: a
  hover tone whose shape depends on which card you are on reads as a different
  control. The relations appear on BOTH faces on purpose — a control that exists
  on one side only is one you have to remember. The face turned away is `inert`,
  so only one face is focusable or hit-testable at a time. The actions face and
  the card's 3D rendering context (`perspective`,
  `transform-style: preserve-3d`, `backface-visibility`) exist only while the
  card is turning or turned. The measured reason is DOM size: the face is 35 of
  a card's 82 elements — 43% of it — on every idle row of a list built to be
  scrolled, and `ActiveSessionCard.test.tsx` pins the resting count. The 3D
  properties follow the face because they are meaningless without a second one;
  no claim is made about composited layers, which were never profiled. Both
  arrive in the SAME commit that starts the rotation, which is what keeps the
  transition intact, and they leave on that rotation's `transitionend` — NOT on
  a timer, which cannot time a transition it starts before: the transition does
  not begin until the next style recalc, so a timer of exactly the duration
  always fires early (measured ~36ms early) and would tear the 3D context out
  mid-turn. A timer remains only as the fallback for turns that never send the
  event (reduced motion, a background tab). Every button here sets
  `cursor-pointer` explicitly — Tailwind v4's preflight gives `button` the
  default cursor, so inside a card that is itself a pointer target an un-styled
  button silently reads as dead space. Settle is disabled with the reason from
  the shared `settleBlockedReason`, the SAME predicate the server refuses the
  command with, and a refusal rolls the optimistic row back. Settling
  deliberately does NOT navigate (unlike archive, the session stays readable and
  stays in the shelf), and a directly routed settled session is pinned visible
  past the shelf's page cutoff. It is also the one action with an EXIT:
  `SessionInbox` owns it, not the card, because the wrapper that animates is the
  row's place in the list — the card slides out to the left (200ms) and only
  then does its grid row collapse from `1fr` to `0fr` (150ms) and the rows below
  travel up, and the settle command is SENT when that finishes, so the list
  update the command causes cannot cut the animation short. The leaving card is
  `inert` and skipped by `↑`/`↓`, and its durations are literal Tailwind classes
  that must stay the sum in `SETTLE_EXIT_MS`. It is gated on
  `prefs.animateListChanges` (Settings → Appearance, Panel animations) AND the
  OS reduce-motion setting; with either off the command is sent immediately, so
  the outcome never depends on the preference.
- A card also carries a SWIPE per side (`common/SwipeRow`, wrapping the card
  inside both exit stages): rightward settles, leftward archives. The order is
  the same as the keyboard settle's and for the same reason — the command is
  sent from `onExited`, so the list update that removes the card cannot cut the
  animation short — but the MOTION is `SwipeRow`'s, not the stages', because a
  card that flew off the side the finger did not pull would read as a different
  act. Only one of the two exits ever runs for a given card. The Settle side is
  omitted where `card.settleBlocked` is set, the same predicate `s` and the
  gutter button disable themselves on and the server refuses the command with: a
  swipe cannot explain a refusal, and one offered here would slide a running
  session away and have the optimistic row roll back underneath its own receipt.
- The pending command is held by the LIST, with a backstop, because `onExited`
  is not guaranteed to arrive: `needsYou` and `active` are separate parents, so
  a session that changes tier while its card is leaving unmounts the very
  `SwipeRow` that was going to report. `SWIPE_COMMIT_MAX_MS` sends it anyway,
  whichever ending comes first wins, and unmounting the whole inbox flushes what
  is still pending — a gesture the user completed must not be dropped because an
  agent happened to answer during the animation. Both actions are reversible,
  and both raise an Undo receipt (one toast key, so a second swipe replaces the
  first) because a thumb over a scrolling list can pick the wrong card and
  archive puts it in a collapsed group a phone does not find its way back to;
  the `s` and `e` keys stay quiet, a keypress being aimed in a way a gesture is
  not. A card mid-swipe-exit is skipped by `↑`/`↓` on `[data-swipe-exit]`, the
  same way a settling one is skipped on `[data-session-leaving]`. OPENING a card
  is the other movement, and it is handled at the source rather than by
  animating it away: reading a session is what makes it read, and read is what
  drops it out of the attention tier, so the card you just clicked used to leave
  its place under the click. `useReadDwell` holds the browser's own "the session
  I am looking at is never unread" rule back for `SESSION_READ_DWELL_MS` — the
  shared constant the SERVER holds its durable read mark back for too
  (`connection.ts`'s `armReadDwell`), so the two halves flip together and the
  card moves once, a moment later, instead of twice, instantly. Whatever still
  moves then moves visibly: `useCardReorder` is a FLIP over `[data-inbox-card]`
  — the commit that moved a card measures them and animates the ones that
  changed place from where they were, through the Web Animations API rather than
  a class so it cannot collide with the settle exit's transitions on the same
  element. It measures the card's LAYOUT position, never a viewport rect: a rect
  also moves when the sidebar scrolls and while a FLIP of that same card is
  still running, and keyed on rects every scroll made every card animate back
  over its own scroll delta while overlapping commits measured each other's
  animations — the inbox's scroll flicker (Task-338). That position is
  `offsetTop` summed up the WHOLE `offsetParent` chain, not a single hop: one
  hop is only comparable between cards sharing a positioned ancestor, so a later
  `relative` on the **Needs you** section would have silently reintroduced the
  same flicker in one block (measured: an 8px phantom jump on every card in it).
  Summing leaves no invariant to defend. It also cancels a card's previous FLIP
  before starting the next, so two animations cannot fight over one `transform`.
  `planCardReorder` in the lib owns the DECISION — which cards moved, by how
  much, and the next baseline — so the part worth testing does not need a layout
  engine. The pass is gated on a digest of what the cards render, so the ~5
  commits a second this browser takes while agents stream reach it only when
  something could actually have moved; a commit that repaints no card cannot
  have moved one, which is what keeps the baseline valid across the commits it
  skips. It runs only while the same preference is on, and stands down entirely
  while a settle exit is playing (that animation already moves the rows below
  it). Every control is LAID OUT at every width — nothing here may become
  hover-only. Every card and row takes the host's `density`
  (`lib/rowDensity.ts`, passed by `Sidebar.tsx` as `comfortable` on a phone
  screen and `tight` on the rail): the gutter floor grows from 36px to 44px, the
  jump buttons from 24px to 36px squares, and the shelf and child rows to 44px.
  It is a string prop, so the enumerating memo comparators cover it unchanged,
  and it heads the reorder pass's layout digest, since a sidebar that turns from
  rail to phone screen while mounted changes every row's height. Cards never
  read a transcript, never issue a git query and never own a timer:
  `SessionInbox` resolves Project (id/key/name/color)/Worktree/Task/fork-parent
  metadata in ONE central join over the already-loaded projections and drives
  every elapsed label from ONE shared ticker (1s while something runs, 60s
  otherwise). `ActiveSessionCard` is `memo`ized on CONTENT (`sessionCardKey` +
  `sessionRelationsKey`), not on identity, for the same reason a pull-request
  row is: both inputs are rebuilt from scratch several times a second while
  agents stream. The rendered LABELS are on the key rather than `now`, so a tick
  that changes no character on a card does not re-render it while a running
  card's `Working 12s` still counts up. Its callbacks therefore take the session
  id rather than closing over the row — a per-card arrow would defeat the memo
  unconditionally. That join resolves a card's Project as
  `session.projectId ?? worktree.projectId` — a session started from a Task plus
  a Worktree commonly has no standalone `in_project` edge, and without the
  worktree fallback those cards would silently drop their Project. Every row
  here — card and both shelves — answers the same keys (open, `↑`/`↓`, `e`,
  `#`), a flipped card also answers Escape, and `s` is the one narrower key
  (settle, and the unsettle that undoes it). `SessionRow.tsx` is now used ONLY
  outside this inbox (`ProjectTreePane`, and the Project page's worktree rows);
  fork lineage is card metadata here, and the compact fork trees stay in the
  relation browsers. Its handlers must stay `useCallback`-stable like every
  other prop `App.tsx` passes to the memoized `Sidebar.tsx` — `settleSession`
  and `promptRenameSession` read the live session list through `sessionListRef`
  rather than closing over `state.sessions`, matching
  `archiveSession`/`confirmDeleteSession`.
- The **Pull Requests** section's browser is an inbox too:
  `PullRequestBrowser.tsx` owns it (a search box and three labelled groups —
  **Needs your review**, **Yours**, **Needs cleanup**), and its rules are pure
  in `lib/pullRequestInbox.ts`. It REPLACED the Worktrees inbox in this slot:
  `WorktreeInbox.tsx`, `WorktreeCard.tsx` and `WorktreeShelfRow.tsx` are gone,
  and a worktree is browsed on its Project page and in `ProjectTreePane`, where
  a project is the subject. `worktreeRowParts.tsx` survived because those rows
  still draw the three-axis git summary, over the axes `lib/worktreeAxes.ts`
  kept when the rest of `worktreeInbox.ts` went with the surface. A row is two
  lines: `#number`, the state glyph and the title on the first, and the project
  chip, head branch, draft marker, local-worktree marker and the CI and review
  glyphs on the second. Every glyph distinguishes UNKNOWN from a negative answer
  — an unread CI is not a pass, an unread review is not agreement, and a review
  with no thread count is not "all resolved" — because absence on the wire means
  the provider was not reached. Rows are `memo`ized and take ids in their
  callbacks, never the row, so the browser hands every one the same stable
  handler; the row id is `projectId#provider#repositoryKey#number` — the same
  four components the route addresses one by, since a number alone names
  nothing, `owner/repo` is only unique within a provider, and one project can
  hold two repositories. Ordering is most-recently-updated first, an absent
  `updatedAt` LAST, and a total tie-break on that id. The browser itself SHIPS
  NO ACTIONS: they live on the detail page below, and a disabled or fictional
  control is worse than none. What the deleted inbox owned and the app kept is
  **Retire** — it moved to the worktree's own inspector beside Remove
  (`worktree/useWorktreeRetire.tsx`), with the same `RemoveWorktreeDialog`, the
  same consent ladder and the same words: only a refusal `force` can answer is
  remembered and escalated, a `sessions` refusal is dropped because force does
  not override one, and a transport failure escalates nothing because nothing
  was verified. Every piece of that state is bound to a WORKTREE ID and the
  inspector is keyed by the one it inspects — a refusal is consent-bearing, so
  under another branch it would enable a forced retirement there. Refusals and
  failures are INLINE on the dialog that asked (`docs/messaging.md`); the
  success toast is the sanctioned one, since the checkout it names is gone with
  its surfaces. The consent text's session COUNT is stated only from a
  `sessionListFresh` list — the ACT is never gated on it (the server recounts
  under the removal hold, and that recount is what protects a running or waiting
  session), but a number taken from previous-episode rows would promise "settles
  0 sessions" while the run settles four, so a stale list yields the generic
  sentence instead. `components/pullRequest/PullRequestDetailPage.tsx` is the
  main-pane page for one pull request
  (`/pull-requests/:projectId/:provider/:repositoryKey/:number`, the repository
  key one percent-encoded segment): a header with the title, `#n` and
  `base ← head`; a status block (checks, review, mergeability —
  `mergeable: null` is "still checking", never a conflict — and the exact head);
  and a relations block resolving the inventory's join ids against
  `state.worktrees`, `state.worktreeStatuses`, `state.sessions` and the Backlog.
  Those ids are authoritative and those lists are not, so each id gets one of
  three answers (`resolveJoinRows`): resolved (rendered even from a stale list),
  pending (reserved, because a cold, stale or failed list is missing exactly
  what was linked a moment ago), or absent — and ONLY a fresh list may say that.
  `pullRequestJoinSources` maps app state onto those lists WITH their freshness
  in one tested place, because an `?? []` there is the one-character edit that
  turns "not answered yet" into "there are none". It performs NO fetch of its
  own: App polls one inventory and hands it the same projection, so the list and
  the page cannot disagree about the same pull request. The page draws no
  actions of its own: they are `PullRequestInspector`'s (`objectInspectors.tsx`,
  keyed by the pull request in `App.tsx`), whose `pullRequestInspectorActions`
  lists Start session in worktree (the primary, disabled with creating the
  worktree as its reason until a checkout holds the head branch), Review in a
  session, Create/Update worktree, Merge & clean up (Clean up for a terminal
  pull request) and Open on the provider. **Review** and **Create worktree**
  (`pullRequest/usePullRequestCheckout.tsx`, over
  `POST /api/pull-requests/checkout`) share the checkout: the server creates or
  updates the checkout of the head branch. Review then hands the item, the
  SERVER's worktree id and the outcome back to `App.tsx`, which stages the
  composer; Create worktree stops there, refetches the inventory and reports
  what the checkout did on a toast carrying Start session as its action. Both
  are offered only while the pull request is OPEN — a merged one has normally
  had its head branch deleted — each busies only its own row, a refusal (dirty,
  diverged, a head on a fork) is a toast naming the pull request because a menu
  row has no inline home, and the review's success is silent because the
  navigation is the confirmation. Its state is bound to the pull request's
  identity like the merge's, and an answer that lands after the panel unmounted
  does NOT navigate — it becomes the sanctioned toast naming the pull request
  with the hand-off as its action, because yanking a reader into a composer for
  a pull request they left is the same class of bug as showing them another
  one's refusal. **Merge & clean up**
  (`pullRequest/usePullRequestMergeCleanup.tsx` +
  `pullRequest/PullRequestMergeDialog.tsx`, over
  `POST /api/pull-requests/merge`) is one row, one dialog listing every
  consequence with a per-item opt-out and the sentence under each control
  describing what THIS click will do. The picker offers only
  `capabilities.mergeMethods` and offers nothing while they are unknown; a KNOWN
  conflict, a draft or unreadable capabilities disable the row with the reason,
  which the page's status block also states as TEXT; `mergeable: null` keeps
  merging on offer. A terminal pull request gets the cleanup alone, and one
  whose checkout is already gone gets no row at all. The hook holds the
  cleanup's consent ladder — the retirement's own, through
  `lib/worktreeRetire.ts`, so only a refusal `force` can answer arms it — and
  binds every piece of that state to the pull request's four-component identity,
  since a refusal shown under another pull request would arm a forced removal
  there. A merge that LANDED is stated and never re-offered even when the
  cleanup then refused; failures stay in the dialog (`ErrorNote`), success is
  silent while the object survives, and the sanctioned toast speaks only when
  the pull request left the inventory with its checkout. A response that never
  came back is its own state: the outcome is UNKNOWN and neither surface offers
  anything from an item that may predate the attempt. What ends it is the STATE
  CHECK (automatically once, then behind a **Check again** control on both the
  row and the dialog): taking the pull request's own lock proves the lost
  request finished, and because the check attempts nothing it stays answerable
  even once a draft, a conflict or a dropped merge method would refuse every
  merge. A refetched inventory never ends it: the lost request may still hold
  that lock, so a `refreshing → ready` cycle is not evidence about it. A
  terminal answer suppresses the merge half and leaves the cleanup; an open one
  says the attempt did not merge it and hands the ordinary decision back. The
  check's three-valued local answer is honoured as three: only `none` may be
  announced as "no local checkout is left", while `ambiguous` states its reason
  and claims nothing. `docs/pull-requests.md` is the contract for all of it.
- `Sidebar.tsx` renders the selected section's object browser first and
  `shell/PrimaryNav.tsx` pinned below it, per `../docs/ui-shell.md`. It also
  owns both inboxes' data prerequisites: the Projects, Worktrees and Task lists
  are loaded when the Sessions section opens, and the Pull Requests section
  takes that same one-off Task load for the join ids its detail page resolves
  (that section joins all three; unlike the Sessions section it DOES hold the
  `tasks` topic while its browser is visible — `lib/broadcastTopics.ts` — so the
  one-off is only what covers the interval before the subscription answers), and
  the live worktree-status watch is scoped to the DISTINCT worktrees its
  unarchived sessions reference — the Projects browser keeps watching every
  worktree it lists, and the Pull Requests browser needs none, since its rows
  say only THAT a checkout exists — and it holds them through
  `hooks/useWorktreeWatches.ts`, so they are refcounted against every other
  surface that wants the same worktree and survive a reconnect. The Backlog's
  are deliberately NOT here: its rows are also on a project page this component
  never renders, so App owns those (see `docs/reference/web-app.md`). It
  FORWARDS the app's hosting projection and its dirty set to the browsers that
  read them (the Backlog's Task rows), and its pull-request inventory to the
  Pull Requests browser, rather than either one fetching or deriving its own —
  see `hooks/useWorktreeHosting.ts` and `hooks/useDirtyWorktrees.ts`. It builds
  that bar's slots from `prefs.navSlots` and dispatches a tap by kind
  (`isNavAction`): a section selects, an action runs `onNavAction` and leaves
  the selection alone. On a phone that bar is a `BottomCard` overlaying this
  surface rather than a row in its column, so the `<aside>` is `relative` and
  the browser reserves `NAV_CARD_INSET` under itself. It takes `mobile` from
  `App.tsx` for the overflow surface's presentation and routes the overflow's
  "Customize order…" to Settings → Appearance. On small screens this whole
  surface IS the browser screen (the shell renders it full-screen for section
  index routes), so its callbacks only navigate — nothing "closes" it. Its one
  scroll container is owned by `hooks/useListScroll.ts`, keyed
  `sidebar:<section>`, so every browser reopens where it was left — per section,
  because they share that container, and across the unmount a phone performs
  every time an object screen opens. Rows anchor that restore through
  `data-list-row-id` (`common/Tree.tsx` for the Backlog/Projects/Knowledge
  trees, the session and worktree rows, the Focus and Inbox lists); a row
  without one degrades the restore to a pixel offset rather than breaking it.
  `SettingsPage.tsx`'s `AppearanceSection` owns the **Navigation bar order**
  editor: up/down reordering of `prefs.navSlots` (no drag-and-drop — the list is
  short and buttons work on touch and keyboard alike) with a live marker showing
  where the current bar width folds into More, computed with the same
  `planNavSlots` the bar uses.
- Chat header (`App.tsx` `PageHeader` actions) hosts exactly two controls ON
  DESKTOP: the worktree-diff button (with a dirty-worktree dot — it stays
  visible because that indicator is worth seeing without opening a menu) and the
  `⋯` overflow, owned by `ChatHeaderMenu.tsx`. On small screens it hosts NONE:
  the object dock is the session's action home, so the diff button becomes a
  `SessionInspector` action and the transcript toggles become its **View**
  section, leaving the header row to identity alone (`../docs/ui-shell.md`,
  Small Screens). `ChatHeaderMenu.tsx` exports `TranscriptViewRows` for exactly
  that reuse — one implementation of the five toggles, so the menu and the dock
  section cannot drift. That menu holds a **Transcript** group (only when a
  transcript exists) and a **Session** group (Rename/Archive/Delete — the same
  actions the right inspector exposes). The Transcript group is five independent
  checkable rows: show thinking, expand thinking, show tool calls, expand tool
  calls, and wrap long lines (`prefs.wrapToolLines`, off by default, reaching
  native tool bodies as `ToolRenderContext.wrapLines`). All five travel as ONE
  memoized `transcriptView.ts` object (`App.tsx` → `MessageList` → `MessageRow`
  → `AssistantMessage`) so a flip costs one referential comparison per memoized
  row, and the menu's `onChange` applies them inside `startTransition` so React
  can interrupt the transcript work while the menu stays responsive — the
  transcript-view toggles no longer sit in the header itself.
  `expandThinking`/`expandTools` (browser-local `usePrefs`) are live
  expand-all/collapse-all AND the default for blocks that arrive later:
  `ThinkingBlock`/`common/ToolCallBlock` re-sync their uncontrolled open state
  whenever `defaultOpen` CHANGES, so one control covers both without a one-shot
  action, and per-block toggling still works afterwards. That sync is adjusted
  DURING RENDER, not in an effect (an effect commits and paints, then re-renders
  every block again — double work for one toggle on a long chat), and it keys on
  the change rather than the value so a hand-opened block is still closed by a
  later collapse-all (`common/toolCallOpenState.test.ts`). Each `expand` row is
  disabled while its `show` row is off. Presentation is `Popover` on desktop and
  a `ui/Sheet side="top"` on mobile, anchored to the chat header's bottom edge
  (measured from the trigger's `closest("header")`) so it drops out of that bar
  rather than covering the app header; view rows keep the surface open, session
  actions close it. The `Composer` has NO top control row: the agent-type picker
  (`AgentTypeSelector`, shown pre-first-prompt only) sits with the
  model/thinking controls — inline while the bottom row can hold them, and
  inside the Runtime dock sheet (`RuntimeSettingsPanel`) once it cannot.
  `Composer` does not take `prefs`/`updatePrefs`. The whole component is
  `memo`ized, which makes every one of its ~35 props a stability contract: it
  hangs under `App`, which re-renders for every socket message — several a
  second while any agent runs, and once per animation frame for the streamed
  tokens of the chat it is attached to — and none of that is about the composer.
  Most of those props were already stable; the ones `App.tsx` had to fix are
  `onAbort` and the `dictation` object (memoized), `isModelDisabled` (a
  `useCallback` on its three scalars) and `onSend`, which goes down as a fixed
  identity over a ref because a send reads about twenty pieces of that render's
  state — a dependency list nobody could keep exact, and one missed entry there
  is a prompt sent with stale context. `usePerfRenderCount("Composer")` is what
  `transcriptRedrawScenario.test.tsx` asserts on. The Build/Plan `ModeSelector`
  is an icon-labelled dropdown, immediately after the attachment/context
  controls and before the other runtime pickers (Task 332); it is rendered only
  where the session has the mode axis (`lib/sessionCapabilities.hasModeAxis`:
  every interactive persona on both harnesses; only the server-owned workflow
  coordinator is excluded). It reads `session.mode` — the staged optimistic
  record before the first send, the server record after, so a live session's
  badge and control track the server's answer over a stale client pick. Staged,
  the pick is client state: `App.tsx` keeps it on `pendingStart` (restaging one
  axis preserves it; switching to an assistant persona drops it) and the first
  send carries it via `lib/newSessionRuntime.firstPromptRuntimeSelection` →
  `harnessSend.mode`; live, it goes through `actions.setSessionMode`. While a
  session is in Plan, the session header title carries the `PlanModeBadge` and
  the folded runtime button label appends "· Plan". The labelling is a binding
  epic decision (Task 305): the control and badge say "Plan" and NOTHING more —
  no "read-only", no "safe", no lock iconography — because v1 Plan keeps the
  shell and is a convention, not an enforced boundary.
- The bottom row's runtime strip (mode, agent type, model, thinking) folds into
  the single Runtime sheet trigger by MEASUREMENT, not by a viewport breakpoint
  — `composerRuntimeFit.ts` owns the arithmetic, `Composer` measures the four
  `data-composer-fit` boxes (`row`, `lead`, `runtime`, `trail`) in a layout
  effect and re-measures under a `ResizeObserver` on the row. A breakpoint was
  wrong in both directions: a phone-width media query left a desktop composer
  squeezed between an open sidebar and inspector overlapping its own send
  cluster, while the strip's width is data-driven (model name, agent label) and
  follows `--text-scale`, so no constant predicts it. The trailing cluster keeps
  priority and never folds. Only the ROW is observed — its width comes from the
  layout above it, never from the fold — and the strip's natural width is
  remembered per signature, so folding cannot change any input to the decision
  and the fold cannot oscillate. While the strip is folded there is nothing left
  to measure, so that signature must carry EVERY width-bearing input, not just
  the content: it keys on the pills' presentation mode too
  (`RUNTIME_LABEL_MEDIA`, Tailwind's `sm`, where `common/ModelThinkingSelect`
  widens the model cap and swaps in the full thinking label) and the root
  `data-text-scale` invalidates it outright. A signature change renders the
  strip again to be re-measured, inside the same pre-paint commit, so the probe
  is never seen. An unmeasured row (a hidden or never-laid-out composer) means
  "unknown" and keeps the standing decision rather than folding on a zero.
- Dictation records in a one-row surface, never in the expanded composer and
  never in an overlay. That is the one composer state which does not involve the
  textarea, so it is the one state that does not raise the virtual keyboard:
  starting there never summons it, and therefore never has to dismiss it. There
  are two hosts for that row — `CompactComposerBar` on desktop (and in
  `collapseWhenBlurred` composers) and `SessionDockActions` in the mobile object
  dock's action row — and they share ONE implementation of the recording state
  through `DictationControls.tsx` (trace + discard + the mic/stop/spinner
  toggle, plus `isDictationBusy` and the live region). Two recording UIs
  drifting apart is exactly what that module exists to prevent; the idle
  arrangement is per host, because both rest as a field carrying the draft but
  one closes with Send while the other's row leads with back and the object's
  own controls. The recorder lives with its TRACE: `useDictation` is owned by
  whichever component renders the waveform, because peaks arrive ~40x a second
  through a ring buffer that `WaveformStrip` reads in its own animation frame —
  routing that up through `App.tsx` would re-render the transcript instead. On
  mobile that owner is `SessionDockActions`, and `Composer` stands its own
  recorder down (`onRequestDictation` present ⇒ `available: false`) so two
  owners never compete for the microphone; the finished text crosses back as
  DATA (`transcript` token prop) and is inserted at the caret the composer
  remembered. While recording, the dock records inside its composer FIELD rather
  than across the row: back and the changes button stay where they are (the
  field carries the trace at `dense` size), and `peek.expandBlocked` still stops
  the sheet opening over the Stop button. `CompactComposerBar` owns three states
  over its single row — idle (draft preview · mic · send), recording (waveform +
  elapsed · small discard · STOP where the mic was, deliberately a size larger
  than the mic that started it, send HIDDEN so stop owns the thumb edge),
  transcribing (waveform frozen · spinner) — and while recording, tapping the
  bar body must NOT expand the composer. The expanded composer's toolbar mic is
  only an entry point: it remembers the caret, blurs (dropping the keyboard) and
  hands over to the row that will record — the compact bar on desktop, the
  dock's row on mobile — so a half-typed draft and a cold start are the same
  flow. Recording therefore FORCES `compact` wherever the bar is the surface,
  including the desktop chat composer that never collapses otherwise — one flow,
  one state machine, and the waveform gets the row's width. `Composer` is gated
  by the `dictation` prop (`{ enabled, status }`): the user setting hides the
  mic, the server-reported `SpeechToTextStatus` disables it with a real reason,
  so an instance without a deployed model (e.g. a PR preview) explains itself
  instead of failing at the first press. The composer pins itself open
  (`composerPinnedOpen`, set by `onPointerDownCapture`) ONLY while it is ALREADY
  expanded, where that pin stops a chrome tap from collapsing it
  mid-interaction. Pinning while it is compact is actively harmful and must not
  be reintroduced: it flips `compact` synchronously inside the same gesture, so
  the collapsed bar becomes `inert` before the click lands and the tap is
  swallowed — the mic tap merely expanded the composer instead of recording, and
  the compact bar's abort tap did nothing at all. The bar's own controls expand
  explicitly (`onExpandPointer`) when they mean to, so nothing in it needs the
  pin. Dictation failures (no speech detected, denied permission, no device) are
  TOASTS (`lib/toast.ts`, key `dictation`) rather than the composer's
  attachment-error slot under the bar: they are transient feedback about a
  gesture, while that slot belongs to the draft being sent and persists until
  something replaces it. On a finished transcript the text is appended at the
  caret remembered when dictation started (the collapse discards the live
  selection) via `lib/insertTranscript.ts`, never auto-sent, and the composer
  expands so it can be corrected. That focus is NOT inside a user gesture — the
  transcript arrives from the network — and iOS Safari only raises the keyboard
  for gesture-initiated focus, so expect the expansion to be reliable and the
  keyboard to sometimes need one tap; keeping the textarea focused throughout
  recording would restore exactly the keyboard thrash this design removes. There
  is no hold-to-talk: one gesture (tap to start, tap to stop) serves pointer,
  keyboard and assistive tech, and the button you press to start is no longer
  the button you press to stop.
- On MOBILE the composer has no collapsed bar at all: the object dock's action
  row is the resting bottom edge there (`../docs/ui-shell.md`, Small Screens),
  and a collapsed composer under it would be two bottom bars with the same job.
  So `mobile` makes the composer either expanded or zero-height (`hidden`), and
  it tells the host which through `onVisibilityChange` so the dock's row can
  stand down while it is up; `onDraftPreviewChange` hands the dock's field the
  draft to SHOW, since there is no bar left here to show it. That one carries
  text rather than a flag, so it is emitted only while hidden (and capped): that
  is the only state anyone can see it in, and a callback per keystroke would
  re-render the host and the transcript behind this card on every character. It
  is zero-height rather than UNMOUNTED because the textarea must stay in the
  DOM: `openRef` hands the host a live callback that focuses it synchronously,
  and only a focus INSIDE the opening tap gets iOS to raise the keyboard on the
  first try. `attachRef` is the same shape for the file picker (the dock row's
  paperclip), for the same reason — iOS refuses a picker that is not opened
  inside the gesture — and `submitRef` for that row's Send, this time because
  the DRAFT never leaves: the host holds a bounded preview, not the text, so a
  send has to be run in here. A blocked send (`sendBlockedReason`) opens the
  composer through it rather than doing nothing, since the hint that says why
  hangs above this card and a closed composer is not showing it.
  `CompactComposerBar` is therefore desktop/`collapseWhenBlurred` territory plus
  the recording surface — recording still brings it up on mobile. One exception
  to the zero-height rule: the composer's own dock sheets anchor to its card
  (`bottom-full`), so while one is open a mobile composer stays EXPANDED with
  the keyboard down instead of collapsing (it used to collapse for the height;
  collapsing to nothing would hang the sheet off the bottom of the screen over
  the dock's row).
- `Composer` collapse is focus-driven and applies ONLY where a
  permanently-expanded composer is costly: on `mobile` (viewport prop from
  `App`) via `collapseWhenBlurred`; the desktop chat composer stays expanded.
  When collapsible, `compact` is true unless the composer is engaged — textarea
  focused, a chrome tap `composerPinnedOpen` (so tapping a button doesn't
  collapse it mid-interaction; an outside pointerdown unpins), a file dragging,
  or an attachment staged. Unsent text is draft-persisted and shown as a preview
  in the collapsed bar. Submitting drops the pin and, when collapsible, blurs
  (mobile keyboard closes; desktop keeps focus for rapid follow-ups). There is
  no scroll-position ("near bottom") coupling — that plumbing (`MessageList`
  `onNearBottomChange`, App `messageListNearBottom`) was removed. A
  keyboard-dismiss detector also collapses the composer when the OS "hide
  keyboard" control hides the keyboard WITHOUT blurring the textarea (otherwise
  it would stay expanded until the next scroll). It mirrors
  `App.useMobileKeyboardInset`'s detection — viewport overlap
  `innerHeight - (visualViewport.height + offsetTop)` measured in a rAF, across
  `visualViewport` resize/scroll + `window` resize — and, on the open→closed
  edge while our textarea is still `document.activeElement`, drops focus + pin.
  (A temporary `localStorage.composerKbDebug="1"` logs the overlap/edge for
  on-device diagnosis.)
- `FileViewerPage.tsx` owns the file viewer (`/files/<absolute path>`), reached
  from a served-file card or an agent's link and belonging to no sidebar
  section. Markdown renders through `Markdown.tsx` with `documentDirectory` set,
  so a relative image loads from beside the file and a relative link opens the
  viewer on it; text reads as text, an image fits the pane, a video gets the
  browser's own player, a PDF gets the browser's viewer where the engine scrolls
  a framed one and otherwise a panel that opens it in a browser tab (and
  registers no zoom, since the panel scales nothing), HTML goes to
  `SandboxedDocument.tsx`, and anything else offers a download. The header
  states the path, size and modification time and reloads from disk, because the
  file is live rather than captured.
- `SandboxedDocument.tsx` is the only place agent-authored HTML runs: it mints a
  directory-scoped grant at view time and points an iframe at it with `sandbox`
  and NO `allow-same-origin`, so the document's scripts run in an opaque origin
  with no reach into app storage or DOM (`docs/served-files.md`). It also owns
  the PDF decision: passive file-scoped grant in a frame where the engine
  scrolls one, and on iOS/iPadOS WebKit (`lib/embeddedPdf.ts`) a panel naming
  the file that opens the same grant in a real browser tab.
- `UsagePage.tsx` owns the Usage surface (`/usage`), opened by the nav bar's
  Usage action — it is NOT a sidebar section and has no object browser
  (everything it shows is on the page). It starts with an **At a glance** card
  for every enabled Claude/OpenAI account, showing the primary 5-hour/weekly
  utilization windows together; cards are grouped Claude first, then OpenAI,
  preserving profile registry order within each provider. Detailed provider
  sections then list ALL enabled accounts vertically (never a profile dropdown),
  with each account loading/refreshing/failing independently through
  `useProfileUsage`, which holds ONE `LoadState` per account: a first fetch
  draws meter-shaped `Skeleton`s, a refetch keeps the meters under a
  `RefreshIndicator`, and a failure keeps them under an `ErrorNote` that retries
  that account alone (`app/web/docs/loading-states.md`). The enabled-account
  list itself is a keyed `useFetchState`, so "No enabled provider accounts."
  only ever states an answer (R1). The header refreshes all accounts and OpenAI
  reset redemption reloads only its account. Mount reads the SERVER cache
  (`docs/usage.md`) so opening the page no longer spawns a CLI subprocess per
  Claude account; only the refresh button and a post-redeem reload force a live
  provider fetch (`?refresh=1`, which also writes through for every other open
  surface). Meter colours come from the shared `usageLevel` thresholds. A shared
  horizontal `% used` `UsageMeter` (utilization is always CONSUMED, never
  remaining — the meter labels both) with a live reset **countdown**
  (`resetCountdown` → "Resets in 1d 5h"; one `useNow` 30s tick lifted to the
  page keeps all meters fresh) renders every window. No chart library is used
  here.
  - **Claude** (`fetchClaudeUsage`, `/usage`-equivalent SDK control request):
    5-hour/weekly/per-model windows, generic `limits[]` table, overage credits,
    approximate local activity. Overage credits format from MINOR currency units
    via `extraUsage.decimalPlaces` (raw 5025 EUR-cents ⇒ €50.25). Per-model caps
    (e.g. Fable) come from `modelScoped`.
  - **OpenAI** (`fetchOpenAiUsage`, ChatGPT `/wham/usage` via pi's login):
    windows classified by duration (never the raw primary/secondary names — the
    primary window may itself be the weekly cap), a spend-cap card (shown with
    NO invented currency symbol — OpenAI reports no currency; caption notes the
    unit is unknown/typically USD), and a credits card listing banked
    **rate-limit resets** with expiries (soonest-expiring first, nearing-expiry
    rows tinted). The credits card offers a **"Redeem a reset"** action for the
    soonest-expiring available credit, ENABLED only when a reset is applicable
    right now (`resetCredits.applicableCount > 0`, i.e. you are actually
    rate-limited — otherwise redeeming wastes it); it opens `RedeemResetDialog`,
    an irreversible-action confirm showing the credit + expiry, and calls
    `redeemOpenAiResetCredit` then reloads. The server independently 409-guards
    the same applicability condition. A missing/expired pi login degrades to a
    friendly `available: false` message (read-only; the app never refreshes the
    token).
- `shell/`, `calendar/`, `tools/`, `diff/`, and `ui/` have child contracts.
- `worktree/WorktreeDetailPage.tsx` has two hosts — the `/worktrees/:id` route
  and the right panel's Worktree tab — and `narrow` (not "mobile") is what picks
  its compact single-column layout, since the panel is a column of a phone's
  order of width. `narrow` decides LAYOUT only: the scope picker and the
  changeset's jump list ask `useMobileLayout` whether to open as a bottom sheet
  (a phone) or an anchored popover (everywhere else, the side panel included).
  Its per-file "viewed" marks come from `useViewedFiles`, a module store rather
  than per-hook state, because both hosts can be mounted on one worktree at once
  and `storage` does not fire in the document that wrote the key. Its header is
  ONE identity row at every width (`density="compact"`), the shape every other
  object page uses: the branch, and a glyph that copies the worktree PATH — the
  thing you actually paste into a terminal, and which used to sit in a subtitle
  that truncated to uselessness on a phone. The path is stated in full by the
  panel's Checkout facts. It carries NO status chips: the dirty counts they
  showed are the Delivery section's, and the pane itself states them where you
  are looking (the rail's "CHANGED FILES · N files +x −y", the changeset list's
  per-file headers).
- The worktree detail surfaces run on `hooks/useFetchState.ts` and the five
  states of `app/web/docs/loading-states.md` (Task-361 Phase 3c). Every key here
  encodes the object being READ, which is what makes R3 structural: the changed
  files key on `worktree:scope` (so a scope switch can no longer leave a list
  behind for a file to be selected off — the old `sameWorktreeScope` guard
  against a spurious cross-scope 400 is gone with it), the Review diff and the
  Files source/`vs base` pivot key on the PATH as well, so opening another file
  draws its own placeholder instead of the previous file's diff or source. The
  Files view's History pivot (`worktree/FileHistoryList.tsx`) lists the commits
  that touched the file and opens one as a Changes range (`parentOid..oid` on
  the file's path at that commit), so a commit's change reuses the Review diff
  surface rather than a second one. The worktree status `updatedAt` is an
  invalidation TOKEN, not part of the key (`useReloadOnToken`): a watcher push
  refreshes what is on screen and marks it with a `RefreshIndicator`, and a
  failed refresh keeps the diff/source readable under an `ErrorNote` whose frame
  is rendered unconditionally (a wrapper appearing with the note would remount
  the pierre surface — see the Knowledge entry above for the same rule). Each
  pane marks the request that belongs to IT: the rail subtitle covers the
  changed-file LIST, the Review toolbar the shown diff, the Files header/detail
  bar the source or the `vs base` diff, whichever is on screen. Retry counts as
  such a refresh, and is the case that most needs the marker — the note
  disappears on the click. The `ErrorNote`'s danger tone is reserved for actual
  failures: "Binary file.", "No changed file selected." and the server's "not
  changed in this scope" (an empty answer dressed as a failure, and the everyday
  case for the `vs base` pivot) are facts about the content and stay muted
  notes. The file TREE is a lazily filled cache of directories rather than one
  query, so its refresh is per DIRECTORY: a token bump re-reads every directory
  already loaded and swaps each in when it answers (`pruneVanishedTreeDirs` then
  drops a folder's cached children once its parent's fresh listing no longer has
  it), leaving the rows, the expansion and the list-mode folder you are standing
  in alone. Dropping the cache first — which is what it used to do — blanked the
  rail to skeletons and threw list mode back to the repo root on a bump that
  `computeWorktreeStatus` stamps on every scan, i.e. shortly after every open.
  Reads are deduplicated per directory and stamped with a tree GENERATION, so a
  run of pushes cannot pile duplicate git reads and a read still out for the
  previous worktree cannot land in this one's cache. The tree's error is per
  directory too, so its retry reloads the folder that failed rather than the
  root, and the rail is "loading" until the root has ANSWERED, never merely
  while a request is open, so an empty first frame cannot read as an empty
  worktree (R1). Covered by `worktree/worktreeLoadStates.test.tsx`.
- `worktree/` owns the worktree detail page (lazy route page; the only static
  importer of `diff/`) plus reusable worktree file/change tree navigation; the
  sidebar has no worktree section any more (the list is on the Project page).
  The page takes a `mobile` prop (Task 122): on mobile the rail layout becomes
  list→detail navigation (the navigator is the screen; a selected `path` route
  param swaps in the full-screen file/diff view behind a back bar; Review does
  NOT auto-select the first file there), split diffs are forced to unified via
  page-level override prefs (the pref itself is untouched, desktop-only), the
  tabs row owns a "view options" `Popover` (`DiffModeToolbar`, with style hidden
  on mobile, on Review; a regular Folder list/Tree radio menu on the mobile
  Files navigator, switching back to diff options in file detail), the mobile
  Files navigator has no separate title/branch/segmented-toggle row, and its
  Folder list is a one-directory-at-a-time drill-down (folders enter, a
  path/back row returns upward) rather than a misleading accumulation of every
  lazily loaded entry, and App passes the worktree actions as a `⋯` overflow
  `Popover` on mobile. The page no longer renders any comment roster itself —
  `WorktreeCommentsPanel.tsx` is gone, and reviewing a diff and reviewing a
  Knowledge entry are the same shape at every width: the object PANEL's Comments
  section (`objectInspectors.tsx`'s `WorktreeReviewSection`, over the same
  `review/ReviewCommentList` + `review/SendCommentsSheet` a Knowledge entry's
  panel uses) is the one place a worktree's comments are listed. Its rows are
  LINKS (`onOpen`) — a diff comment is read and answered ON its line, so the
  roster carries no thread actions of its own, only the review bar. Following a
  row is cross-pane: `App.tsx`'s `openWorktreeComment` collapses the dock sheet
  on mobile (it covers the diff) and hands the page a `{ commentId, nonce }`
  token; the page resolves which file that comment currently lives in (it is the
  one place the comments themselves are loaded) and calls its own
  `followComment`, which remembers `{ commentId, path, nonce }`, feeds it to
  that file's `LineCommentsConfig.focus`, and the surface scrolls to the
  annotation and rings it (`diff/CLAUDE.md`). It navigates first only where the
  layout needs it (by-file, or the Files view); the changeset already stacks
  every file, and the focus retry covers its lazily mounted section.
  `worktree/worktreeReview.tsx` owns this domain's adapter
  (`worktreeReviewThreads`), its pending-review helpers and
  `WorktreeReviewSubmitSheet`, and must stay free of `diff/` imports: both
  `App.tsx` (the mobile dock's submit action) and `objectInspectors.tsx` (the
  panel's Comments section, at every width) import it directly, and a static
  `diff/` import would drag pierre + Shiki into the main bundle.
  `WorktreeComment.attachedSessionId` is this domain's record of having been
  handed to an agent, which is what the roster's pending count reads. Sending
  selected comments to a NEW session is a draft handoff, not an immediate spawn:
  it stages the worktree + structured thread ids on `/sessions/create`, prefills
  an editable review prompt, and reuses the standard Agent/Model/Thinking
  controls; first Send creates the chosen runtime and supplies the comment
  bundle as model-only context. Existing-session sends remain immediate and
  carry the review message. Its roster shows the same review bar as a Knowledge
  entry's, so the everyday path is "submit everything still unsent" rather than
  checkbox selection.
- Worktree Review flow (Task 123): tabs are **Review** and **Files** — the
  History tab is gone. That toolbar now carries TWO kinds of thing only: WHERE
  you are (the tabs) and WHAT you are looking at (one scope control), with the
  mobile jump-to-file and the view-options popover trailing.
  `WorktreeScopePicker.tsx` is that control: its trigger STATES the current
  scope in words at every width ("Uncommitted", "vs main", "Commit 3c8287a",
  "a1b2c3d → working tree" — `worktreeScopeLabel`), and one surface (popover on
  desktop, `Sheet` on mobile) holds every way to change it: the presets, then
  the branch commit log where one tap reviews that commit and the Range toggle
  or shift-click compares two (`from` = the older commit, exclusive). It
  replaced three separate triggers — two preset buttons plus a "Commit…" picker
  — whose combined state you had to infer from which one looked active, and
  which degraded to unlabelled glyphs on a phone. The by-file/changeset choice
  moved INTO the view-options popover as its "Review layout" segment: it is a
  rendering choice like unified-vs-split, and as a second segmented control in
  the toolbar it competed with the tabs. Because the trigger says the scope out
  loud, the object panel's old read-only "Viewing" section
  (View/Scope/Range/File) is gone — it restated the page's own toolbar. Review
  has two modes via `prefs.worktreeReviewMode` (unset = changeset on mobile,
  by-file on desktop): by-file (the Phase-1 rail/detail behavior) and changeset
  — `WorktreeChangesetList.tsx` stacks every file's diff in one scroll with
  sticky per-file headers, lazy IntersectionObserver mounting (latched;
  rootMargin 600px), large (>600 changed lines)/binary/viewed files starting
  collapsed, and per-file "viewed" checkmarks persisted browser-locally per
  worktree+scope by `useViewedFiles.ts` (marking viewed collapses the section).
  Jump-to-file: desktop rail clicks and the mobile "Files…" `Sheet` scroll to
  registered section elements instead of navigating. Review comments work on
  committed range diffs too: the file-diff response's resolved `newOid` flows
  into the comments config as `refOid` (threads render at immutable creation
  anchors for exactly that commit; new comments anchor with
  `NewWorktreeCommentAnchor.ref`). Files previews (Task 124): raster images
  render directly in the File pivot via the token-carrying `worktreeFileRawUrl`;
  svg/markdown/html add a "Preview" pivot — markdown through a lazily imported
  `Markdown.tsx` (relative link/image URLs resolved to `file-raw` via
  `onResolveUrl`, `..` escapes left untouched), html in a scriptless
  `sandbox=""` iframe. File detail no longer offers the redundant Last commit
  pivot; on mobile its back/path summary and any remaining File/Preview/vs-base
  pivots share one compact row, with icon-only accessible pivot controls and no
  separate full-path toolbar. **Delivery lives in the object PANEL, not the
  toolbar** (`worktree/WorktreeDelivery.tsx`, imported statically by
  `objectInspectors.tsx`: it was lazy for WEIGHT while it owned a section of its
  own, but its dialogs are in the main bundle anyway through this importer, and
  a hook cannot be lazy — the main chunk measures 455 kB, inside the 500 kB
  budget): one `Delivery` section holding where the work stands — working tree
  (files, +/−), remote (`↑ahead ↓behind` or "not published"), HEAD, CI (linked,
  coloured by state) and PR (linked) — while `useWorktreeDelivery` hands the
  ACTS on that state to the panel as ordinary `InspectorAction`s: auto commit
  and commit-with-message while dirty, Push (only when there is something to
  push, with the commit count or "new branch" as its right-aligned hint), Force
  push (only when the remote has diverged), Pull from origin (inert without an
  upstream — there is nothing to pull from until the branch is published),
  spawned-worktree **Pull from `<base>`** (hint `rebase onto remote <base>`,
  since the remote's base branch is the target and only the SERVER resolves
  which remote carries it), create-PR, merge-PR and Clean worktree (`HEAD`
  reset + ordinary untracked removal; commits/ignored files preserved, and it
  confirms in a dialog). Every delivery act whose answer is a DIALOG (auto
  commit, whose outcome can be a blocker dialog, commit-with-message, merge-PR,
  create-PR, Clean worktree) is `keepOpen`: the dock sheet's collapse-on-act
  unmounts the body that holds the hook AND its dialogs, so collapsing would
  destroy the dialog the tap just opened — invisible on a desktop panel, silent
  on a phone (`WorktreeDelivery.dockAct.test.tsx`). A panel has ONE Actions
  section: delivery's own list used to be a second one under its facts, so the
  worktree panel now orders start-session, delivery, merge back/remove, submit
  review, reveal in that single list, and the dialogs travel with the hook. The
  section absorbed the panel's old read-only "Working tree" section, and it
  replaced the toolbar's status cluster and its twelve-item `⋯` menu — delivery
  state used to be spread across header chips, the sidebar's counter, toolbar
  glyphs and panel facts while its actions hid in a menu wedged between
  navigation and rendering controls. The page therefore passes NO
  lifecycle/overflow actions any more (`App.tsx` dropped that render prop).
  Auto-commit reuses the server `/commit` safety/message workflow without
  guessing a session and shows blockers before any force override. The hook owns
  its own status REFETCH after a mutation (newest of watcher-push vs refetch
  wins, the same rule the page uses) so state updates immediately instead of
  waiting for the watcher, and hosting polls every 60s only while CI is pending,
  refetching when HEAD moves. `MergePullRequestDialog` offers only the merge
  methods the hosting payload's `capabilities` report — none, with the reason
  said in place and Merge disabled, while they are unknown — for the same reason
  the card's picker does. Repository actions use HTTP POST (`lib/worktrees.ts`),
  not the WebSocket.
- `AppStatus.tsx` is the app status slot: the one surface allowed to announce
  anything globally, and only app-wide lifecycle state the user cannot act on
  that ends by itself — a queued or running server restart, and a dropped
  socket. Two placements over one derivation (`lib/appStatus.ts`, pure): inline
  in `Topbar`'s spare centre on wide layouts, where it adds no height and passes
  the pointer through so the native title bar still drags, and a `role="status"`
  pill floating at the top centre on narrow ones, which have no header bar. The
  floating one is always mounted and gates on the layout; the bar one exists
  only while `Topbar` does. It owns `RECONNECT_GRACE_MS`, the wait before a
  disconnect is worth saying out loud — a cached shell is hydrated but not live
  until `ready` lands, and a dropped socket usually returns inside one retry, so
  without it the slot would flash on every cold start — and that wait is held in
  `lib/appStatus.ts`'s module store, not in component state, so crossing the
  breakpoint does not restart it and blank a live announcement. A restart has no
  such wait and outranks the disconnect it causes; the connection half says
  "Connecting…" until the app has been live once, "Reconnecting…" after.
  Contracts: `docs/messaging.md` for what may appear here,
  `app/web/docs/loading-states.md` for its glyphs.

## Contract notes and rationale

- Components should receive data/actions via props or hooks from owning layers;
  avoid direct WebSocket ownership here.
- The permanent Personal Assistant is a pinned Topbar action, is omitted from
  the ordinary session list, and opens the server-owned singleton session. Its
  composer hides model/thinking controls because those are fixed through its
  dedicated settings page; web sends to that session through the server's
  durable cross-channel queue. Changing
  name/provider/model/thinking/instructions rotates the singleton binding to a
  fresh conversation on next open while preserving the previous session in
  history; the settings page must state this.
- Task intake settings must offer active registry projects for optional
  automatic linking, and explain that the curator can use a bounded read-only
  subset of enabled integrations, has no native file/shell or mutation
  capabilities, and leaves a persisted Task retryable on failure.
- Integration settings pages are end-user surfaces: keep deployment details,
  protocol names, scopes, token diagnostics, and manual test controls out of the
  primary flow. Expose only connect/sign-out and enable controls, verify
  existing authorization automatically when opened, show one concise
  healthy/warning state, and tell users with invalid authorization to sign out
  and back in. Google and Slack do not offer a separate
  reauthorize/switch-account action.
- Settings → Claude SDK owns Claude profiles. `ClaudeLoginTerminal.tsx` is the
  mobile-safe modal around `hooks/useClaudeLoginTerminal.ts`: it shows bounded
  streamed output from the official `claude auth login --claudeai` process,
  turns only Claude's authorization URL into a tappable external action, and
  forwards the password-masked pasted code without displaying it. The protected
  Default Claude mirrors the server user's ordinary `~/.claude` login and
  becomes Ready automatically when that login exists; named profiles remain
  isolated and retain `CLAUDE_CONFIG_DIR=… claude` as a terminal fallback.
  Connect/Reconnect uses the browser terminal for every Claude profile. Every
  profile, including the default, can be disabled; only named profiles can be
  renamed/deleted (deletion is refused while sessions remain bound). Settings →
  OpenAI owns isolated OpenAI/Codex profiles and the pi device-code flow. Both
  list only safe metadata; tokens and raw credential files never enter the UI.
- Jira and Tempo are two separate settings pages. `Jira` is token-based
  (Atlassian email + API token, host shown read-only from deployment config)
  and, like `GitHub`, keeps an explicit token entry with a `Save and test`
  action in its primary flow, since it has no OAuth round-trip. `GitHub` is a
  classic-PAT integration (enable toggle + personal access token + optional
  default owner + a package-proxy toggle ("Let builds read private GitHub
  packages", default on — reuses the same token to authenticate Maven/npm/NuGet
  package-registry hosts for in-build dependency resolution, contract
  `docs/package-proxy.md`) + `Save and test`/`Test saved token`); its status
  line shows the resolved login, reported token scopes, and readiness of both
  the container-pull and package-proxy capabilities, and the copy names the
  required scopes and the SAML-SSO org-authorization step. `Forgejo` mirrors
  `GitHub` for a self-hosted Gitea-compatible instance (enable toggle + editable
  instance base URL + access token + optional default owner +
  `Save and test`/`Test saved settings`); because it is self-hosted the base URL
  is user config (non-secret, echoed back) and only the token is a secret, and
  its status line surfaces the resolved login + reported server version. `Tempo`
  is OAuth (Connect/Reauthorize/Disconnect); it auto-verifies on open and notes
  that Tempo needs the Jira integration for worklog enrichment (degrading to raw
  issue ids when Jira is disabled). Slack uses two settings pages: `Slack` owns
  the end-user OAuth flow and normal health, while `Slack Huddles` owns
  independently enabled/checked experimental paste-only “Copy as cURL” browser
  access. Huddle cURL parsing accepts only `huddles.history` and sends only the
  browser token plus `d` cookie; individual credentials stay hidden and Huddle
  status/credentials must not enter the normal Slack flow.
- Rich tool cards must tolerate partial, streaming, or malformed tool output and
  degrade gracefully. A card that lazily loads more of its own content in the
  browser (`GoogleWorkspaceToolCard`'s Drive preview and Gmail thread expansion)
  marks that with the shared primitives — a `Spinner` on the control that
  started it, `Skeleton` rows where the body will land — and renders the
  server's error text when the fetch fails rather than staying pending. Jira
  approval rows surface a create's parent, Markdown source preview, native issue
  links, and partial-execution warnings so approval/result state remains
  informed; executed partial results use a “Done with warnings” badge rather
  than a false clean success or total failure. Approval buttons clear their
  local spinner on authoritative lifecycle changes and after a bounded timeout;
  stale-decision reconciliation comes from the server's current-card update.
  `ApprovalCard.tsx` switches on `body.kind`. Its `gmailArchive` arm puts every
  frozen message in one bounded scrolling list and shows the full sender and
  subject for each row; the focusable region remains keyboard-scrollable, and
  the card has one Approve/Reject decision for the whole batch. Google Settings
  marks legacy read-only grants and tells the user to Reauthorize before an
  archive card can be created. The `githubPullRequest`/`forgejoPullRequest`
  kinds share one `PullRequestBody` arm and header icon: the kinds stay separate
  on the wire for persisted-card readability, but the fields this card renders
  (title, head → base, draft, description, review summary, inline comments,
  comment body) are the same on both. The GitHub-only `assign` operation gets a
  person icon and lists its four people changes (request review, cancel review
  request, assign, unassign), skipping the lists the proposal leaves alone.
  `forgejoRelease` is its own arm (tag icon): it shows the tag, the short target
  sha with the ref and commit subject it was resolved from, and clamped notes —
  the sha is on the card because approving is approving that revision.
  `managedPullRequestMerge` is its own arm (merge icon): an agent asking to
  merge its own managed pull request into the DEFAULT branch, rendering the head
  → base pair with the default-branch label, repo/number, method and
  branch-deletion choice, the short accepted head, the exact-head check verdict,
  hosted review, draft state, the methods the repository allowed, and the linked
  Task. It is deliberately NOT editable: everything shown is frozen evidence of
  what was decided, and approving re-derives all of it server-side, so a merge
  with different settings is a new tool call rather than an edited card.
  `sessionSpawn` is the only EDITABLE arm: each proposed session renders its
  title, persona/target line, a `ModelSelect` + `ThinkingSelect` fed by App's
  `accountModels` (so picking a model also picks its account — the compact
  account-grouped selects rather than `common/RuntimePicker.tsx`'s full-width
  rows, which do not tile for up to eight rows inside a transcript), a Skip
  toggle, a `more…` disclosure for the opening prompt, and — once executed — a
  link to the session it created or its own error. Those changes live in the
  card's local state and travel with Approve as `ApprovalResolutionEdits`: the
  stored card must keep reading as the agent's proposal, so a reload shows what
  was proposed, never a half-edit. The pickers disappear the moment the card
  leaves `pending`, leaving the resolved runtime as plain text. Two states this
  arm has to get right because the server can refuse an approval and leave the
  card pending: ANY authoritative card echo clears the local Approve/Reject
  spinner (the status alone cannot see a pending→pending re-send, and 15 seconds
  of dead buttons is not a recovery), and a row whose model is missing from
  `accountModels` LOCKS its thinking control rather than offering the `off`-only
  ladder an unmatched model yields. The same model on ANOTHER account stands in
  for the ladder only — never for display, which would otherwise name an account
  the row would not run on.
- Keep accessibility basics for interactive elements: labels/titles, keyboard
  behavior where applicable, and clear disabled states.
- Prefer existing UI primitives before adding one-off styling patterns.

## Working notes

- Preserve lazy imports for heavy cards/pages unless there is a measured reason
  to inline them.
- Keep domain cards aligned with server `renderKind` and shared display block
  contracts.

## Verification commands

- Run `pnpm --filter @assistant/web build` for component changes.
- Run root `pnpm run build` before closeout.
