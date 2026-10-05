# Workshop UI conventions

Use this document when changing `app/web` UI code. The goal is a coherent, DRY
interface: future UI work should reuse existing concepts, make reusable
components easy for agents to discover, and keep these conventions current as
the product evolves.

## Core principles

- Prefer reuse over repetition. Before adding a control, card, table, picker,
  popover, layout shell, or visual state, search for an existing component or
  pattern with the same intent.
- A new UI concept should have one clear home. Avoid creating parallel variants
  of the same interaction unless there is a deliberate product reason.
- Match the existing design language: spacing, type scale, density, colors,
  border radius, icon treatment, hover/focus states, and empty/error/success
  states.
- Use semantic theme tokens (`bg-panel`, `bg-surface`, `bg-raised`,
  `border-line`, `text-fg`, `text-muted`, `text-faint`, `text-accent`,
  `text-success`, `text-warning`, `text-danger`, and matching `*-soft`
  backgrounds) rather than hard-coded colors.
- Keep behavior and presentation separate when practical. If a component
  contains reusable interaction behavior, expose it as a component or hook
  instead of copy/pasting handlers.
- Preserve accessibility: labels for form fields, accessible names for icon-only
  buttons, keyboard dismissal for overlays, and sensible focus behavior.
- Avoid competing vertical scroll areas in the same navigation or content
  surface. Prefer one clear scroll owner per panel/page, with fixed
  headers/footers only when they provide persistent controls. This matters on
  all platforms and is especially important for mobile overlays.

## Native-feeling performance and navigation

- Core rule: never make the user wait when the app can make a reasonable
  prediction and reconcile later. Optimize the time from user intent to visible
  feedback over backend round-trip timing.
- Treat navigation as an in-app state transition, not a document reload. Keep
  the app shell, sidebars, topbar, and composer mounted whenever possible;
  update only the content that actually changed.
- Use optimistic UI for user edits by default: reflect the intended state
  immediately, send persistence/server work in the background, and rollback or
  show an inline error only if reconciliation fails. Avoid waiting for
  websocket/HTTP confirmation before showing low-risk changes.
- Prefer cached, stale, or browser-local session/page data during navigation and
  refresh it in the background. Avoid replacing the whole app with a loading
  screen after initial hydration; show last-known data plus compact refresh
  state instead.
- Use visible-first loading: fetch/render the current route, visible tab,
  selected panel, or first page before secondary panels, hidden tabs, full
  histories, previews, or large datasets.
- Keep state changes granular. Normalize or isolate data so updating one item
  does not rerender unrelated pages, sidebars, drawers, or long transcripts.
  Memoize, split components, or virtualize only where large data or measurements
  justify it.
- Load less JavaScript on first paint. Prefer route/component-level lazy loading
  for settings sections, rarely used tool widgets, terminal/runtime surfaces,
  syntax highlighting, and large integration-specific panels.
- For PWA/Home Screen repeat launches, keep service-worker caching
  production-only and bounded: cache the app shell/static hashed assets, update
  shell data in the background, and never cache websocket, `/api/*`, MCP,
  artifact, or other dynamic/private endpoints unless there is an explicit
  product decision.
- Disable or scope only actions that would target the wrong server state while a
  transition is pending; do not block reading cached content.
- Keep navigation animations short and cheap (`transform`/`opacity`, usually
  100–200ms) and avoid animating restored state after route/session switches.
  Respect reduced-motion settings.
- Treat mobile/Home Screen usage as a first-class performance target: layouts
  must be thumb-friendly, avoid competing scroll regions, preserve fixed
  topbar/composer behavior, and remain useful on narrow/touch/standalone iOS
  viewports.
- When introducing or changing a performance principle, audit all current
  pages/components that share the affected interaction pattern in the same
  change or explicitly document the safe exception. Do not let pages drift into
  separate loading/editing rules.
- When introducing data-loading flows, ask whether stale-while-revalidate, local
  cache, optimistic state, route-level lazy loading, or smaller visible-first
  payloads can avoid spinners.

## Keeping conventions current

Update this document when you introduce or intentionally change a reusable UI
concept.

Update it when:

- adding a new reusable component family or interaction pattern;
- changing the preferred style for buttons, fields, cards, tables, overlays,
  selectors, or status/callout states;
- deciding that an older pattern should no longer be used for new work;
- introducing a naming, documentation, layout, accessibility, or theming
  convention;
- learning a better way for agents to discover or apply existing UI components.

Do not use this document as a cleanup backlog. Capture durable conventions and
decision rules, not lists of existing inconsistencies to fix later.

## Finding existing components quickly

Before implementing UI, do a short discovery pass:

1. Search component names and intent keywords under `app/web/src/components`.
2. Search for exported components, hooks, and top-of-file component briefs.
3. Look for shared CSS utilities or semantic class patterns before inventing new
   class strings.
4. Inspect only the most relevant files first; use the component brief to decide
   whether a file is worth loading fully.

Useful commands:

```bash
rg "@component|@purpose|@useWhen|export function|export const" app/web/src/components app/web/src/hooks app/web/src/lib
rg "selector|popover|dialog|table|card|field|button|status|empty|preview" app/web/src
```

Prefer improving discoverability in place over creating a large registry solely
for documentation.

## Component brief convention

Reusable UI components, component families, and complex one-off surfaces should
start with a short searchable doc comment. The intent is to let an agent
identify relevant components without loading an entire file into context.

Use this shape near the top of the file, before the component implementation:

```tsx
/**
 * @component ComponentName
 * @purpose What this component renders and the user problem it solves.
 * @useWhen When future code should use or extend this component.
 * @avoidWhen When a different pattern is more appropriate.
 * @intent Design/UX intent: density, interaction style, data ownership, or constraints.
 * @related Optional: closely related components/hooks/helpers.
 */
```

Guidelines for briefs:

- Keep them short: usually 5–10 lines total.
- Describe intent and usage, not implementation details that change frequently.
- Mention important constraints, such as controlled vs uncontrolled state, async
  loading, browser-only data, or accessibility expectations.
- If a file exports several small internal helpers, document the main exported
  component or component family rather than every helper.
- Add or update the brief whenever a component becomes reusable, changes intent,
  or gains important constraints.

## Choosing between reuse, extraction, and local implementation

- Reuse an existing component when the user interaction and visual intent are
  the same.
- Extend an existing component with props/slots when the new case is a supported
  variation of the same concept.
- Extract a shared component when a pattern is repeated or likely to be repeated
  and the shared abstraction is clear.
- Keep code local when the behavior is genuinely one-off, tightly bound to the
  surrounding feature, or extraction would create a vague abstraction.
- Do not introduce a registry or abstraction just for neatness. Add structure
  when it improves clarity, consistency, or future implementation safety.

## Chat message rendering

- Render both user and assistant chat text through the shared `Markdown`
  component so sent prompts, relay prompts, and assistant prose use one
  Markdown/link/code treatment.
- Copy affordances inside content use `ui/CopyButton`'s `InlineCopyButton` (a
  small ghost icon that swaps to an accent check and raises the copy toast).
  Fenced Markdown code blocks carry one under the block via `CodeBlock`'s
  `copyable`; inline code does not.
- Synthetic resume/control prompts that are useful to the user should render as
  compact transcript FYI blocks (for example a tool-group activation notice)
  instead of raw hidden prompt text.
- User-role turns that were submitted by an agent or system automation (for
  example a post-reload continuation) should preserve prompt provenance and
  render with a distinct low-emphasis “Agent/System prompt” treatment rather
  than looking like a human-authored prompt.
- Keep durable session references id-based in stored text. When known session
  ids appear in Markdown prose, enrich them at render time with the current
  session title and an internal navigation link; do not write the title back
  into message text.
- In Workshop sessions, when current changed-file paths appear in chat Markdown,
  link them at render time to the workspace diff/review panel and focus that
  file. Preserve the original message text as a plain path.
- Pi prompt attachments are sent to the model as an inline text suffix on the
  user turn, so a reloaded transcript would otherwise show that raw suffix
  instead of chips. The suffix begins with a comment-wrapped, base64 attachment
  manifest (`buildAttachmentManifest`/`splitAttachmentManifest` in
  `app/server/src/serialize.ts`); the serializer strips it to recover the clean
  prompt text and rebuild an `attachment` block per attachment, so all
  attachment kinds (files, images, `role: "task-context"`, future roles) render
  the same chip/widget on reload as they do live. Add new attachment roles to
  the shared `AttachmentRole` and render them in `AttachmentChip`; do not
  special-case reconstruction per role.

## Application Header Bar

- The application Header Bar is the single global top toolbar (`Topbar`, using
  `AppHeaderBar`) mounted above every route. It is always visible and must not
  be replaced or specialized per screen.
- Accountabilities: show app identity (logo + name on wider screens, logo-only
  on mobile), expose primary global app actions in a stable left
  session/navigation cluster (`[Logo] [Sessions] [New Session]`, all icon-only),
  expose global state/actions on the right (theme, websocket connection), and
  host the remaining layout control: the right Session Tasks panel toggle.
  Settings navigation is in the sidebar (gear icon tab), not the Header Bar.
- The left **Sessions** control is a destination-named navigation trigger (see
  the “Destination-named navigation controls” convention below), not a
  left-sidebar layout toggle. It is responsive: desktop toggles the inline
  sidebar; mobile opens a full-screen Sessions sheet; on non-chat routes
  (Settings/Task detail/Project detail) it opens the sidebar inline in place. It
  must not be disabled on any route or viewport.
- The right Session Tasks panel toggle keeps its layout-panel semantics. It may
  be disabled on non-chat routes (Settings/Task detail/Project detail) where the
  active session has no drawer to address. Do not add a separate disabled
  left-side panel button as a placeholder; the Sessions control already owns the
  left affordance.
- On mobile, hide low-priority diagnostics/preferences from the Header Bar,
  including the theme toggle and websocket connection indicator. Theme remains
  available from the dedicated Settings → Theme section; richer connection
  diagnostics belong in Settings or explicit debug surfaces.
- Keep it stable across routes and sessions. Do not add controls that appear
  only because a specific page, chat session, agent kind, workflow, or selected
  item is active. If state shown in the Header Bar changes, it should be
  genuinely global state or app-shell state.
- Put contextual controls in contextual surfaces instead: page headers for
  page-level actions, `PageHeader`/session drawers for session context, composer
  or chat-docked panels for chat workflow controls, and feature panels for
  feature-specific tools.
- Keep the Header Bar compact. The shared `AppHeaderBar` shell intentionally
  uses a low 2.25rem desktop toolbar height plus minimal safe-area padding on
  mobile/PWA surfaces. New header content should fit the compact density rather
  than increasing the global bar height.
- The websocket connection dot is currently tolerated as a compact global/debug
  indicator. Do not expand it into a prominent status widget in the Header Bar;
  move richer diagnostics to Settings or an explicit debug surface.

## Destination-named navigation controls

- Name app-shell navigation controls after their **destination**, not their
  current layout effect. The user-facing label should answer “where does this
  take me?” not “what panel does this show/hide?”
- The control then renders responsively for that destination: on desktop the
  destination may be a side panel; on mobile it may be a full-screen sheet/page;
  from another route it may be inline-open or a navigation. The control stays a
  single button with one icon, one tooltip, and one `aria-label` everywhere.
- Concrete reference: the **Sessions** button in the Topbar uses lucide `List`
  with tooltip `"Sessions"` and `aria-label="Open sessions"`. App computes the
  responsive behavior; `Topbar` stays route-unaware and only receives an
  `onOpenSessions` callback plus a `sessionsActive` boolean for the indicator
  dot.
- Do not render disabled placeholders for these controls based on viewport or
  route. If a destination is reachable, the control must remain enabled even
  when the rendering style changes. If a destination is genuinely unreachable
  from the current context, remove the control rather than disabling it.
- Reserve `data-session-row` (or an equivalent focus target) on the destination
  surface so a focus-on-open token can land the keyboard on the most relevant
  row when the user activates the control.

## Unread dot indicators

- Use the shared `UnreadDot` component for compact binary attention markers:
  unread session responses, pending global state, or similar “something needs
  attention” states where a count would add clutter.
- The dot means presence, not quantity. Do not use it for progress, severity,
  exact counts, or statuses where the user must distinguish multiple levels at a
  glance.
- Keep the dot attached to the relevant icon/avatar/action and preserve an
  accessible label or title on the parent control that explains the state.
- Header/toolbars: use `UnreadDot` with the default `toolbar` placement on a
  `relative size-8` icon button. This intentionally places a small dot at
  `right-1 top-1 size-1.5`, inside the button's top-right corner, so sidebar,
  drawer, and other toolbar indicators align vertically.
- Avatars/list rows: use `placement="avatar"` when the dot should sit just
  outside a circular/avatar target with a panel-colored border, such as unread
  session responses in the sidebar.
- Prefer local text inside an opened popover, list, or detail panel when the
  exact count matters; the compact dot should only get the user to the right
  surface.

## Transient toasts

- Use the global toast store (`lib/toast.ts`, rendered by the single
  `ToastViewport` mounted at the app root) for ephemeral confirmations such as
  "Copied to clipboard". Trigger them with `showToast(message, { tone })` from
  anywhere — handlers or helpers — without threading a provider through props.
- Toasts auto-dismiss and carry no persistent alert state. Use them only for
  ephemeral feedback; durable follow-up belongs in the originating UI surface.
- A toast may include one short action only for immediate, local undo of the
  just-completed optimistic operation. Use a stable `key` so the next operation
  replaces the prior undo offer, keep duration finite, and dismiss/replace it on
  rollback. Richer follow-up actions belong in the originating UI surface.
- For copy affordances use the shared clipboard helpers in `lib/clipboard.ts`:
  `copyTextToClipboard` returns success and falls back to a legacy `execCommand`
  path so copy works in insecure contexts (mobile over a plain-HTTP LAN IP,
  where `navigator.clipboard` is `undefined`); `copyWithToast` also surfaces the
  standard success/failure toast. Prefer these over calling
  `navigator.clipboard` directly.

## Keyboard shortcuts

- There is one app-wide shortcut system in `components/ui/shortcuts.tsx`: a
  `ShortcutsProvider` (mounted once around the app in `main.tsx`), a
  `useShortcuts(group)` hook that registers a `ShortcutGroup` while the calling
  surface is mounted, and a `?` help overlay that lists every
  currently-registered group. Do not add ad-hoc `window` `keydown` listeners for
  feature shortcuts — register a group instead so the keys stay discoverable.
- Registration is context-sensitive: a group only appears in `?` (and only
  dispatches globally) while its surface is mounted. The always-present
  `General` group (⌘K search, `?` help) is registered from `App.tsx` with a low
  priority so it sorts to the bottom.
- Prefer Gmail-style, single-key row actions on lists/trees where items can be
  removed or archived: `e` archives (recoverable), `#` (or `Delete`) deletes
  (always confirm destructive deletes, e.g. `window.confirm`). Reuse these
  letters across surfaces for muscle memory.
- Row-scoped keys that must act on the focused item are handled by the widget
  that owns focus, not the global dispatcher. The generic `Tree`
  (`components/ui/Tree.tsx`) takes `rowActions` (keys + label +
  `run(targetIds)`, acting on the whole multi-selection when the focused row is
  part of one) and a `shortcutsTitle` that registers those keys `display`-only
  in the help overlay. Flat lists like the sidebar `SessionRow` handle the same
  keys inline and register a matching display-only group. Never give a
  display-only entry a `run`, or the key fires twice.
- Skip shortcuts while a text input/textarea/contenteditable is focused unless
  the shortcut opts in with `allowInInput`.

## Message actions

- Do not show assistant message avatar/icons in chat transcripts on mobile or
  desktop; the icon does not add useful information and harms text alignment.
  Wide chat widgets should center against the chat area without compensating for
  an avatar column.
- Per-message chat actions should use the shared below-message icon action row
  pattern (`MessageActionsBar`) rather than hover overlays. Keep actions
  compact, low-emphasis, and accessible with `title`/`aria-label` text.
- Use message-level actions for transcript operations such as copy, fork,
  retry/edit, labeling, or export. Actions that operate on a specific rich card
  or tool payload should stay inside that card/widget.

## Task management surfaces

- User-facing labels should call session-scoped items “Session Tasks” and
  durable/global items “Tasks” or “Backlog items” depending on context. Keep
  `session`/`global` as internal/API scope names only when needed for
  persistence or tool compatibility.
- Frame the top-level durable Task workspace as the “Backlog”: a personal
  continuity layer for persistent commitments, project work, agent handoffs, and
  cross-session follow-ups. Avoid presenting it as a generic separate todo app.
- Treat the Backlog as core-first: the mandatory shape of a Task is a title plus
  a `todo`/`doing`/`done` status. The sidebar Backlog tab is the compact
  normal-hierarchy browse/triage/reorder surface alongside Sessions and
  Projects. The dedicated `/tasks` route is the full Backlog workspace for
  broader list modes such as grouping by Project, and `/tasks/:id` remains the
  Task detail route. Avoid showing the compact sidebar list and full workspace
  list as duplicate default surfaces.
- Manual Backlog ordering persists via a `sortOrder` field and the
  `reorderTodos` action; tasks without a `sortOrder` yet float to the top by
  recency so fresh captures stay visible until positioned. Backlog hierarchy
  uses `parentId` for unlimited Task/subtask nesting and shows parent progress
  as a visual child-status rollup rather than changing parent status
  automatically. Parent rows are collapsible: put the chevron in the adaptive
  second row aligned with the drag handle, place the icon-only subtask progress
  counter immediately next to it aligned under the status toggle column, keep
  progress counting the full subtree while collapsed, and persist collapse state
  in browser-local storage. Leaf rows do not reserve empty chevron space; when
  they have second-row metadata, vertically center the drag handle across the
  row height and align metadata under the status toggle column. Collapse is
  render-only — hidden children keep their `parentId`/`sortOrder` and follow
  their parent through drag/reorder and persistence (visible rows drive the
  optimistic order; hidden descendants are merged back by id). Nested rows
  should indent the whole card boundary, not only the row contents, with subtle
  gutter connector lines and slightly softer child-row chrome so hierarchy reads
  visually. List reordering uses Pointer Events without a drag-and-drop
  dependency, via the shared `hooks/useBacklogDragReorder` hook so it works for
  mouse, touch, and pen. During drag, keep reordering client-side: float the
  dragged row above the list, animate sibling rows with transforms to open a
  visible drop gap, let horizontal movement indent/outdent within the current
  drop context, auto-scroll near the list edges, send `reorderTodos` only on
  drop, and rollback the optimistic order/hierarchy with an inline error if the
  server rejects it. The hook is parameterized by indent width and supports
  activation modes such as a dedicated drag handle (`touch-action: none`,
  immediate) or whole-row activation via a small movement threshold so the same
  row can also be a click/tap target with no extra handle column (used by the
  sidebar Backlog tab; it exposes a click-suppression ref so the drop's
  synthetic click does not also open the row). Prefer this hook for other
  reorderable Task lists.
- The full Backlog workspace route (`/tasks`) may show list-level modes that are
  too broad for the compact sidebar, such as Project-grouped browsing. Grouped
  views should be render-only unless a task explicitly owns grouped editing: do
  not mutate `projectId`, hierarchy, or sort order merely by changing modes, and
  keep ambiguous hierarchy/reorder interactions in the normal view.
- Task detail routes (`/tasks/:id`) are detail-only main content surfaces linked
  from the sidebar Backlog list and full Backlog workspace rows. They show
  status, title, parent progress, markdown description, links/Jira metadata, and
  linked sessions; title/description editing uses the shared `InlineEdit`
  pattern. A Back/Open-list control should reveal the sidebar Backlog tab rather
  than rendering a second master list inside the route.
- In the list, tapping anywhere on a row (the whole card is a `role="button"`
  target) selects the Task and opens its detail; the inner controls stop
  propagation so they keep their own actions (status icon cycles, drag handle
  reorders, parent chevron collapses). There is no inline rename or extra open
  affordance in the row — title editing lives in the detail view, which keeps
  rows compact and gives a large, predictable tap target. The selected row is
  highlighted. Keep rich or editable metadata in the detail panel; the list may
  show compact derived rollups in an adaptive second row only when useful, such
  as linked-session count or icon-only subtask progress. If a linked session is
  running, show a compact spinning circular progress indicator at the far right
  of the title row, sized and vertically aligned like the status toggle.
- The data model and agent todo tools still carry richer fields (description,
  priority, due date, reminder, project, Jira, dependencies, session links). Not
  surfacing a field in the Backlog UI must not break those fields: manual saves
  send only the fields they change, and the server merges partial updates
  (`undefined` keeps, `null`/`""` clears). The Backlog list fetches with
  `includeDescriptions` so the detail panel can render the full markdown body
  without a second round-trip.
- A Task can be a small work hub: the detail panel has a **Sessions** section to
  list linked sessions and one compact action to start a new session with the
  Task attached. The action opens the normal new-session flow, queues the Task
  as a hidden attachment for that session's first prompt (`attachTaskId` on
  `prompt`/`claudeSend`), and the server builds a server-authoritative
  `role: "task-context"` attachment (id/title/description + a nudge to use
  `task_read`/`task_manage`) so the model receives it through the existing
  attachment path for all agent kinds. The pending attach is shown as a compact
  composer chip and rides along on the first send only.
- Task↔session links live on `TodoSessionRef.origin`: `task-start` (the session
  was created from the Task) vs `reference` (it merely touched the Task). The
  Sessions list joins `sessionRefs` to live `state.sessions` for status (title,
  running, message count, recency), marks `task-start` rows as "started here",
  and click-through opens the session. A session's origin Task is derived
  (`SessionState.originTask`) and merged with linked/session-scoped Tasks into
  the Session Inspector's single **Tasks** section rather than shown as
  duplicate "Working on" or "Session Tasks" blocks. The section uses a compact
  status-count summary on the right, task status icons in rows, and an
  always-expanded hierarchy for parent/subtask structure; task detail expansion
  belongs on the Task detail route. Linking happens on the first prompt (not on
  session creation) so abandoned drafts never dangle; the Backlog list refreshes
  on mount so returning to a Task shows newly linked sessions.
- Use the session task drawer only for compact, active-session progress. Use the
  sidebar Backlog tab for durable Task browsing/triage/reordering and Task
  detail routes for manual detail editing.
- Keep manual Task management non-chat: list interactions should call focused
  websocket actions rather than starting an agent turn.
- Treat Session Task/Task transitions as explicit user actions rather than
  implicit scope changes during normal editing.
- Cross-session agent assistance should use a Task as the coordination record
  once approved, with linked source/helper sessions and compact milestone/relay
  summaries instead of an untracked agent-to-agent side channel. Pending
  source/helper relay messages may appear in the session drawer as compact
  routing cards; keep full relay history in the linked Task/audit store and
  inject agent-visible relays as clearly labeled prompts. Relay delivery is
  trusted between agents and must not require a content-based approval step.
- **Project display and selection**: global Backlog Tasks and standalone Session
  drafts may carry or stage a `projectId` linking to a registry record. Projects
  define a required, unique short Jira-style `key` (for example `PD` for
  Pandeck); compact Backlog badges should show that key via `ProjectBadge` while
  keeping the full project name in titles/tooltips and selectors. Use
  `ProjectBadge` (`components/ProjectBadge.tsx`) for compact row, detail, and
  context display; color/stripe comes from `projectColor(projectOrId)` in
  `lib/projectDisplay.ts` — registry records may carry an explicit user-selected
  `color`, with deterministic id-based fallback for older/unknown Projects. Use
  `resolveProjectDisplay`/`projectDisplayKey` for consistent
  short-label/full-label/fallback logic across surfaces. `buildProjectsById`
  builds a `Map<string, ProjectRecord>` from the registry list — memoize it once
  per page or component that renders rows. Project detail pages show Worktree
  controls only after the Project has a non-empty `repo` or `workspace` local
  path; without a configured repo checkout, keep the detail focused on metadata
  and local paths. Use `ProjectSelector` (`components/ProjectSelector.tsx`) when
  a compact searchable popover should select or clear one primary Project.
  Backlog rows show project identity with the compact badge/dot only; do not add
  a duplicate project-colored left border/bracket. Task detail shows
  `ProjectSelector` just below source links for global Tasks only; the
  new-session composer may show the same selector for standalone Project context
  before the first prompt. Selectors should offer only active (non-archived)
  registry projects; a project that is archived-but-already-linked/staged
  remains visible and clearable via `ProjectBadge`/`resolveProjectDisplay`
  fallback. Unlinked Tasks render no label; avoid "No project" text in rows. The
  web save path stays lenient (passes known ids or `""` to clear); validation
  lives in the agent `task_manage` tool, not in the web layer. `ProjectBadge`
  and `ProjectSelector` are reusable for Project-context Sessions.

## Session side drawers

- Session drawer and right Inspector content should be organized as compact
  named sections with a small aligned icon, optional one-line right-aligned
  summary metadata or compact header actions, consistent collapsible/expandable
  behavior, and separators between sections. Use the shared `InspectorSection`
  chrome for Inspector sections such as Workspace, Tasks, Actions, ToolGroups,
  Artifacts, task context, project task lists, and worktree status sections so
  the right panel does not drift into parallel header patterns. Persist section
  expansion per session/object so users can keep high-noise sections collapsed
  without changing other conversations.
- Keep drawer sections lean: avoid inline documentation, dashed instructional
  boxes, and long capability/tool lists. Empty states should be factual and
  short (for example “No tasks yet.”) and should not be duplicated in both
  header and body. If a section has no content beyond its empty summary, keep it
  non-expandable until content appears; detailed explanations belong in docs,
  settings, or agent answers.
- Capability rows in session drawers should show only glanceable state by
  default: status icon, name, and a compact right-aligned action. Put
  descriptions, reasons, warnings, or advanced details behind expansion and hide
  empty sections until there is real session data.
- Session Task rows in drawers should default to a single compact line with
  status and title. Put longer descriptions/details behind per-row expansion,
  and when expanded show the full available text rather than a clipped preview.
  Commit state should be glanceable as a compact icon/status, not a visible
  commit hash unless the user asks for exact commit details.
- On mobile/narrow layouts, sidebars and side drawers should become overlays
  below the full-width app topbar instead of participating in horizontal layout.
  Do not squeeze the chat column or cover the topbar. Avoid duplicating an X
  close button in mobile sidebar/drawer headers when the app topbar remains
  available as the panel toggle; close after navigation/select actions.
- Use a right-side session drawer for persistent, glanceable context that should
  remain visible while reading or composing chat, such as the current
  agent-maintained session task plan.
- Keep session drawers compact and contextual to the active conversation. They
  should not become full global management screens; use a dedicated page or
  route for cross-project browsing/editing.
- Prefer read-only or low-risk controls in session drawers unless the user
  explicitly enters an editing flow. Agents or focused tools should own
  structured updates when the drawer reflects agent-maintained state.
- Session-local capability controls, such as on-demand tool groups, may live in
  the session drawer when they directly affect the active agent context. Show
  activation source/status/reason and keep manual enable/disable controls
  compact and auditable.
- Browser tool-group surfaces should make the standard `browser_*` actions
  discoverable (`browser_navigate`, `browser_snapshot`, `browser_click`,
  `browser_fill`, `browser_resize_viewport`, `browser_screenshot`,
  `browser_console`, `browser_network`) and frame raw browser MCP as an advanced
  escape hatch only for missing capabilities.
- Session-scoped artifacts, such as browser screenshots, should be shown as
  compact thumbnails/links in the session drawer and stored under the session
  lifecycle rather than in the project working tree.
- Provide topbar toggles with clear icons, accessible titles, and active/open
  indicators for sidebars or drawers that can remain visible on desktop.
- Avoid extra X close buttons inside mobile/full-screen sidebar and drawer
  overlays unless a surface has no other obvious dismissal path. On desktop,
  prefer the main topbar toggle for collapse/expand instead of duplicating an X
  in the sidebar/drawer header.
- Sidebars and side drawers may use fast non-linear slide-in animations when the
  user explicitly opens them, but do not animate initial render or restored-open
  state after session/page switches. Keep animations subtle and locally
  configurable in Appearance settings, and respect reduced-motion preferences.
- If a session drawer can remain open during normal chat work, make its width
  user-resizable with the same separator pattern as the left sidebar: pointer
  dragging, keyboard Arrow/Home/End support, sensible min/max widths, and
  persisted preferences.

## Desktop right-panel tabs

- On wide layouts, use `RightPanelTabs` for additional right-panel surfaces. Its
  tabs are closeable and `+` opens the panel home; when none are open, the home
  is a centered list of available panels. Its open/active state is
  `sessionStorage`-scoped, so reload restores it only in the same browser tab.
  Register a panel once in `PANEL_DEFINITIONS` rather than adding parallel panel
  switchers. Gate optional panels in the host's chooser and restored tabs from
  persisted settings; show Personal Assistant disabled (not openable) until its
  configured model is available on a signed-in account. Use the existing
  `@dnd-kit` horizontal sortable treatment to reorder open tabs in place; that
  order is part of the same per-tab session state.
- Keep opened desktop tabs mounted while another tab or the panel home is
  visible, so their local state and fetched data survive tab switches; closing a
  tab is the explicit release. The small-screen right panel remains the direct
  Inspector object dock; do not carry tab state or tab chrome into its sheet.
- A tab bar names panel surfaces, not the inspected object. Object identity and
  actions stay in the main-page header/Inspector content according to the
  existing header and dock rules.

## Chat-docked panels

- Use `ChatDockPanel` for contextual chat/session controls that need more room
  than a small popover but should stay local to the composer/chat box. The panel
  is composer-width, opens upward from the chat box, has a title bar with
  minimize/close controls, optional compact title actions, and dismisses with
  Escape.
- Keep docked panels lightweight and quick: short lists, branch/session
  navigation, previews, or focused controls. Do not use them for global alerts,
  full settings flows, or long documents.
- Trigger docked panels from compact composer controls with clear icon buttons
  and accessible labels. Hide or de-emphasize triggers when the related context
  does not exist.
- On narrow/mobile composer layouts, combine space-heavy runtime controls such
  as model and thinking-level selection behind one compact docked-panel trigger
  instead of showing multiple wide selector pills in the action row.
- Prefer one scroll container per docked panel. Let the `ChatDockPanel` body own
  vertical scrolling instead of adding nested scroll regions in panel content.
- Keep minimization available for docked panels that may block chat content the
  user needs to reread. Minimized panels should collapse to a small restore pill
  above the composer and preserve the panel's parent-owned state.
- Put primary flow actions that must stay reachable (for example
  Back/Next/Submit) in the title bar actions slot. Do not duplicate close/cancel
  actions inside panel content when the generic title-bar close already performs
  that cancel/close behavior.
- Runtime-specific debug surfaces, such as a Claude Code terminal, should be
  capability-based controls in the normal chat chrome rather than separate
  session types. Prefer a compact icon button near the runtime/tool/thinking
  controls and show the terminal as a temporary overlay over the chat; it is for
  diagnostics, not the primary interaction path.
- Agent-requested question flows should also use a chat-docked panel above the
  composer. Keep them step-by-step, provide an explicit cancel/back-to-chat path
  via the panel close action, model per-question “discuss in chat” as a
  selectable answer state, and include a final review summary before submitting
  structured answers back to the agent. Preserve in-progress answers in
  browser-local storage keyed by the active question request so switching chats
  does not reset the form; clear that browser-local draft on submit/cancel.

## Composer collapse on read

- The composer auto-collapses to a single-row bar (placeholder hint + primary
  stop/send button) when the user is reading older messages — scrolled away from
  the bottom of the transcript, composer unfocused, no typed text or
  attachments, and no pending question/draft/review/dock-panel state. Clicking
  the bar or the inline button re-expands and focuses the textarea; the stop
  button stays functional while streaming.
- Surface the message-list scroll position with an `onNearBottomChange` callback
  so parent layouts can drive the composer's compact prop. Do not query scroll
  from the composer directly; let the message list report its actual post-layout
  scroll state.
- Use hysteresis for the near-bottom signal. Composer height changes alter the
  transcript viewport height, so a single scroll threshold can flicker near the
  bottom as collapse/expand changes feed back into the scroll calculation.
- Animate the compact ⇄ expanded transition with the CSS
  `grid-template-rows: 0fr ↔ 1fr` pattern plus an `overflow-hidden` inner cell,
  keeping both layouts mounted so focus, text state, and attachments are
  preserved across collapses. Use `ui/composerShell.ts`'s `composerFoldClass`
  rather than a hand-written variant, and never collapse a composer card by
  cutting its own height (`h-0`): a height animates from a pixel value, not from
  `auto`, so that surface snaps while every other one glides. Fold the card's
  BODY and let the card's height follow it.
- Every transition and animation is `motion-safe:` (or stilled under a
  `prefers-reduced-motion` rule in `index.css`), including fold/collapse
  transitions. Prefix the duration and easing utilities as well as the
  `transition-*` one: `duration-*` alone still animates, because the CSS default
  `transition-property` is `all`.
- On touch/mobile, expand-and-focus from the compact fake text field must happen
  synchronously within the tap gesture; avoid delayed focus that requires a
  second tap to open the keyboard. Once expanded, only the actual textarea
  should focus/compose; taps on non-text composer chrome should not open the
  keyboard, blur the textarea, or collapse the composer. Touch focus on the
  textarea itself should also use a controlled `preventDefault()` +
  `focus({ preventScroll: true })` path to avoid iOS Safari panning the whole
  fixed chat shell upward.
- For mobile keyboard avoidance, keep the app shell height on the normal
  closed-keyboard CSS path (`100dvh`, with standalone `100lvh` fallback) and
  move only the composer/footer by a computed keyboard inset from
  `visualViewport`. Do not globally replace the app height with
  `visualViewport.height`: iOS standalone/Home Screen mode can report a smaller
  safe visual viewport while the keyboard is closed, reintroducing empty space
  below fixed footers. While the keyboard is open, reduce composer bottom
  safe-area padding because the keyboard already owns that safe area.

## New session flow

- New sessions are staged at `/sessions/create` before any prompt is sent. The
  **New Session** button in the global Header Bar's left cluster navigates there
  regardless of agent kind. `/sessions` is reserved for the Sessions navigation
  surface (sidebar/sheet open and focused) and must not be reused as the
  empty-bootstrap landing.
- The `/sessions/create` page shows only the composer, centered vertically in
  the viewport (flex `justify-center` +
  `paddingBottom: var(--app-keyboard-inset-bottom, 0px)` for mobile keyboard
  safety). Do not add cards, onboarding panels, or empty-state content — keep
  the page minimal.
- Old home routes (`/`, `/assistant`, `/workshop`) redirect to
  `/sessions/create` once the server confirms the session is empty; they keep
  their parse-level routes so programmatic `/workshop` navigation (e.g. Backlog
  task start) still works.
- Agent kind selection on a new session uses the `AgentKindSelector` component
  inline in the composer's top-left slot (same position as `WorkshopMeta` on
  active workshop sessions). It uses the `composerPill` + `Popover` pattern from
  `ModelSelector` and `ThinkingSelector`. Selecting a kind closes the popup and
  calls `actions.newSession(kind)` without URL navigation; the session stays on
  the current `/sessions[/create]` route. The selector disappears automatically
  once the session has messages — it is only valid on empty/new sessions.
- The actual server session is pre-created (as assistant) when the user arrives
  at `/sessions/create` or `/sessions`, but the `AgentKindSelector` can switch
  it before the first prompt. On first send, the URL transitions to the
  canonical `/{kind}/c/:id` path.

## Sidebar navigation surface

- The bottom navigation bar uses the user's saved slot order, filtered by
  availability: during first-run account setup offer only Settings; show New
  Session once a signed-in account offers a model, and show integration-backed
  destinations only when configured and optional Knowledge navigation only when
  enabled in Settings. Filtering must not rewrite the saved order, so newly
  available slots regain their chosen positions.
- The primary left sidebar is the global navigation rail, not only a session
  list. Its `SidebarHeader` is a single compact row whose primary control is the
  Sessions/Backlog/Projects tab switch; the active tab already names the
  surface, so there is no separate identity/title row. Keep contextual sidebar
  actions (and low-emphasis counts) in that one row rather than adding header
  rows, and align its height with the chat header (`min-h-16`).
- The active tab persists browser-local (`assistant.sidebarTab.v1`) and selects
  the sidebar body: the unified Sessions list (`SessionList`), the compact
  Backlog tree (`BacklogTree`), or the Project registry list. Keep one vertical
  scroll owner for the sidebar body regardless of tab.
- The sidebar Backlog tab is the compact Backlog list view: a quick
  browse/triage/reorder/navigation view that reuses the shared
  `lib/backlogTree.ts` ordering/flatten/collapse logic and the shared
  `useBacklogDragReorder` hook for drag-to-reorder, cycles status in place, and
  opens a Task by routing to its detail (`/tasks/:id`). It may expose a
  contextual action to open the full Backlog workspace (`/tasks`) for list-level
  modes. The Backlog tab loads `state.todoList` on first view if it is still
  unloaded.
- The sidebar Projects tab is the canonical Project list view: a quick read-only
  browser for the local Project registry and its immediate work context. It uses
  the shared `Tree` chrome for Project hierarchy/reordering and may show bounded
  related child rows under a Project: direct Project-context Sessions,
  Worktrees, and recent Sessions nested under each Worktree. Related Session
  rows should reuse `SessionRowContent`, Worktree rows should reuse
  WorktreeBrowser status/session-limit helpers, and both Project-level and
  Worktree-level Sessions should page in small batches (currently 5) rather than
  flooding the sidebar. Project rows stay compact: collapsible chevrons when
  they have child Projects or related context, a deterministic colored dot, then
  `KEY · Project name` in one line. It loads the registry and worktree list on
  first view, highlights selected Project/Worktree/Session rows where possible,
  and opens Project detail pages at `/projects/:id`; manual registry writes
  remain agent/tool-owned until a deliberate editing flow is introduced.
- Prefer this tabbed sidebar list pattern for lightweight app-wide browse
  surfaces. Keep the main content area for the selected detail route,
  chat/session surface, or a deliberately introduced full workspace such as
  `/tasks`; when a full workspace is active, do not auto-open a duplicate
  sidebar list by default.
- Use the shared `SessionRow` component for compact session references in the
  Sessions sidebar and Task detail linked-session lists. It owns the kind
  avatar/icon, title, recency, running/awaiting-input/unread states, optional
  task progress/fork metadata, and subtle missing/not-loaded fallback rows.
- The Sessions inbox's sticky counter header should match the compact chat and
  right-panel bars at `h-11`. Keep its status glyphs and tabular counts in
  matching centered slots so zero and nonzero states do not shift the row.
- The Sessions tab should present chat navigation as one unified Sessions list
  rather than separate Assistant/Workshop scroll regions. Distinguish session
  kinds with compact icons/badges.
- Use the sidebar's own `SidebarHeader` shell for the fixed header. It is
  deliberately distinct from the global Header Bar; global Header Bar density
  changes must not affect it.
- Do not put persistent session-creation or app-level destination actions in the
  sidebar footer. New Session lives in the global Header Bar as an icon-only
  action. Backlog, Projects, and Settings all live in the sidebar as
  tabs/navigation: Sessions/Backlog/Projects are labeled tabs in a pill;
  Settings is a gear icon button at the right of the sidebar header. Clicking
  the Settings gear navigates to `/settings/theme` (or the current section);
  clicking another tab while on Settings navigates back to the current chat.
- Keep the first row of session items reserved for the title. Put secondary
  state such as recency, fork lineage, child counts, pending auto-rename, and
  compact task summaries in the second row; prefer visual markers for running
  and unread state when they are already clear.
- Secondary metadata should stay low-emphasis and single-line/truncated so it
  improves scanability without turning the sidebar into a tree browser.
  Fork/child metadata may be link-styled when it has a unique navigation target;
  keep multi-target navigation in the row overflow menu.
- Running-agent indicators should have a consistent visual treatment that does
  not depend on task progress or task status. While a session is running,
  prioritize the clear “agent is working” spinner; task progress can remain
  available in text/tooltips or return visually when the run is idle.
- Session row actions should not depend on hover. Prefer an explicit compact
  overflow menu, such as a vertical ellipsis, so rename/delete/parent/child
  actions remain reachable on mobile and other non-hover inputs.

## Forms and selectors

- Use one interaction model for the same domain. If a domain uses a rich
  picker/listbox elsewhere, prefer that family over adding a different native or
  custom control for the same choice.
- Keep option labels, grouping, active state, disabled state, helper text, and
  validation behavior consistent across call sites.
- Constraints should live close to the selector component or helper function so
  different screens cannot drift.
- For settings-style forms, use shared field labels, hints, input styling,
  buttons, and status/callout components when available.
- Never display stored secret values in the browser. Use explicit “configured,
  leave blank to keep” style behavior for secret replacement fields.

## Inline editing

- Prefer in-place inline editing over separate “Edit” buttons or modal dialogs
  for low-risk text edits (titles, names, descriptions). Use the shared
  `InlineEdit` component (`components/InlineEdit.tsx`) instead of
  re-implementing click-to-edit state and keyboard handling.
- `InlineEdit` shows a static display until activated, then swaps an editor in
  place. It owns its own editing/draft state; callers pass only `value` and
  `onSubmit`. No-op edits (unchanged value, or empty when `allowEmpty` is not
  set) revert without calling `onSubmit`.
- Single-line edits (`multiline` omitted) commit on Enter, cancel on Escape, and
  commit on blur. Use these for titles and short fields.
- Multiline edits (`multiline`) render a textarea with explicit Save/Cancel
  buttons, cancel on Escape, save on Cmd/Ctrl+Enter, and intentionally do NOT
  commit on blur (so newlines and accidental focus loss are safe). The textarea
  auto-grows to its content on entry and while typing so swapping from rendered
  prose to editing does not collapse the field. Use these for
  descriptions/longer prose, and render the static display via `renderDisplay`
  (e.g. through the shared `Markdown` component for rendered markdown).
- Use `renderDisplay` to preserve a caller's existing display styling/layout
  (truncation, strikethrough, markdown) and `editorClassName` to match
  surrounding field styling.

## Layout, cards, and tables

- Use the shared `AppHeaderBar` component for the compact shell of the global
  app Header Bar, full-screen pages (Settings, Backlog), and feature panel
  headers. It owns the consistent compact shell — fixed `min-h-9`/`h-9` desktop
  row, optional notch-safe top padding (`--app-safe-area-top` for iOS
  standalone/PWA), bottom border, and translucent blurred desktop background —
  so those surfaces never re-derive that styling or sit behind the notch. Keep
  `safeAreaTop` enabled for the full-width app topbar and true full-screen
  pages; set `safeAreaTop={false}` for panels that live below the app topbar to
  avoid double notch spacing. Callers pass the gap utility via `className`
  (default `gap-2`; denser panels use `gap-3`) plus the leading control, title
  block, and trailing actions as children. Do not use `AppHeaderBar` for the
  chat/session subheader or primary left sidebar header; those have distinct
  shells.
- Use `PageHeader` for every below-topbar sub-section/detail header: the chat
  session header, session-context drawers, and detail pages (Task detail,
  Project detail, Settings). It is deliberately distinct from the global Header
  Bar — it owns a taller `min-h-16` context-row shell that matches
  `SidebarHeader`, and global Header Bar density changes must not affect it.
  `PageHeader` provides one coherent layout: a leading slot (either the standard
  colored icon box via `icon`/`iconTone`, or a custom `leading` control such as
  a status toggle or back arrow), a `title`/`subtitle` block (string or node),
  and a trailing `actions` slot. Detail headers should not carry a redundant
  back arrow when the sidebar already owns that navigation; reserve `leading`
  controls for genuinely distinct affordances (e.g. Settings → back to chat) and
  put page actions (archive/delete/review) in `actions`. Use the chat/session
  header via the `sessionHeaderIcon(variant, kind)` helper plus
  `buildSessionContextSubtitle`; the drawer's `context` variant is for desktop
  drawers where the adjacent chat header already carries session metadata. Use
  `transparent` mode to reserve the row height over an already-visible matching
  header during overlay/slide animations.
- Destructive/lifecycle page actions belong in the `PageHeader` `actions` slot
  as compact icon buttons with accessible labels: archive (`Archive`, neutral
  hover) and delete (`Trash2`, danger hover, behind a confirm). Chat sessions
  and Projects both support archive (reversible hide) and delete; Tasks already
  do. Session archive is a reversible, kind-agnostic flag stored server-side in
  `archived-sessions.json` and surfaced as `SessionListItem.archived`; the
  sidebar Sessions list hides archived rows behind a collapsible “Archived (N)”
  toggle and offers archive/unarchive in the row overflow menu. Project
  archive/delete call the registry's `archiveProject`/`deleteProject`; archived
  projects drop out of the default registry list.
- Mobile chat layouts should lock browser/page scrolling and keep the composer
  anchored outside the transcript scroll area. The message transcript should own
  vertical scrolling; the full-width topbar, chat session subheader, and
  composer must not scroll away in long/old chats. Avoid putting the composer
  inside the transcript or page scroll container.
- Prefer shared shells for repeated layouts: page sections, panels, cards,
  callouts, empty states, tables, and expandable rows.
- Feature-local navigation rails inside a main-pane workspace (for example
  changed-file lists next to a diff) should stay close to the content they
  navigate, but they must be user-resizable/collapsible when they compete with
  the primary reading surface. Use the shared `ResizableSeparator` /
  `useResizeDrag` primitive for split-pane resizing so app-shell, task,
  workflow, and feature-local rails keep identical pointer-capture behavior,
  cursor handling, and separator styling. Worktree file/change navigation should
  use the reusable tree-based `WorktreeFileNavigator` so Changes, Files,
  History-adjacent surfaces, and Inspector summaries show folder context
  consistently while callers still own what selecting a file does. Keep the
  right Inspector for object summary, relationships, status, and next actions
  rather than making it the only navigation tree.
- Use `ChatWideCard` for rich chat widgets that intentionally break out of the
  normal message column. It clamps width against the chat area using
  `--chat-area-width`, so avoid copying viewport-width calculations into
  individual widgets.
- Tables should define consistent density, header style, empty state, row
  expansion behavior, horizontal overflow behavior, and responsive limits.
- Cards should expose clear slots for icon, title, subtitle, metadata, actions,
  body, and footer when those concepts repeat.

## Styling and theming

- Use Tailwind utility classes with semantic tokens from `index.css`.
- Prefer existing component-level class patterns over new ad hoc combinations.
- If a class string becomes repeated or semantically meaningful, consider moving
  it into a component, helper, or documented CSS utility.
- Keep light/dark behavior automatic through tokens; do not tune only one theme.

## Response expectations after UI changes

When reporting UI work, briefly mention:

- which existing component or pattern was reused;
- whether a new reusable component or convention was introduced;
- whether this document was updated because the change introduced a new durable
  UI convention.
