# Web UI primitives — implementation reference

Relocated from `app/web/src/components/ui/CLAUDE.md` (Task-274) so it stops
costing agent context on every visit. This is a descriptive snapshot of what the
modules in that subtree own; the rules an agent must not violate stay in that
folder's `CLAUDE.md`. Correct or delete a section here when the code moves on.
Relative paths in the body are relative to the original subtree.

## Purpose

Reusable low-level UI primitives and generic render helpers used across chat,
tool cards, and feature pages.

## Module ownership

- Button, tree, resize separator, collapsible output, copy, diff, code, JSON,
  ANSI, provider icon, and model thinking controls live here.
- `load.tsx` owns EVERY loading, empty and error affordance the client draws:
  `Spinner` (the one `LoaderCircle` glyph, sizes 10/13/16/22 as
  `xs`/`sm`/`md`/`lg`, `motion-safe:animate-spin`, `aria-hidden` because the
  region around it does the announcing, plus a `ring` variant that draws the
  transcript's bordered circle at the same tokens — one element and no icon
  module for the streaming tool-call and thinking headers), `PaneLoading`
  (centered spinner + label, `role="status"`, deliberately NOT `aria-busy`,
  which on a live region licenses assistive tech to defer the announcement),
  `Skeleton` (`motion-safe:animate-pulse` `bg-raised`, sized by the caller to
  the content it reserves, and renderable `as="span"` where it stands inside
  phrasing content such as a meter track in a card button), `RefreshIndicator`
  (the stale-while-refresh marker: small spinner, sr-only label,
  `role="status"`), `EmptyBox` (the dashed-border empty state with an optional
  action, in three geometries — `box`, `inline`, and the `item` a horizontal
  scroller's empty row needs) and `ErrorNote` (danger-toned inline box with an
  optional retry). `Button`'s `busy` prop draws its spinner from here too, which
  is why `load.tsx` imports nothing from `Button.tsx`. It is ONE module so the
  audit can name one owner: `src/loadingStateAudit.test.ts` forbids
  `animate-spin`, `animate-pulse`, `LoaderCircle`/`Loader2` and `border-dashed`
  anywhere else, with NO allowlist since Task-391 finished the migration. The
  two treatments that only look like loading states are named class tokens here
  rather than exemptions: `LIVE_PULSE` (the dictation mic arming, a worktree
  card's streaming underline — nothing has been asked for, so a spinner would
  pose an unanswerable question) and `DASHED_EDGE` (a fillable slot, a
  provisional object, an unresolved reference — never a region with nothing in
  it, which is `EmptyBox`). The sizes are tokens because the code it replaces
  used every value between 9 and 22. Contract: `app/web/docs/loading-states.md`.
- `UsageCycleMeters.tsx` owns the provider card's subscription-usage slot: two
  generic cycle rows (`5h`, `wk`), each a micro meter with the number
  right-aligned and a fixed label column so rows align across cards. Fill is
  USED, never remaining, and length + colour + number are redundant channels.
  The slot keeps its height in every state — `—` with a `Skeleton` shimmer (the
  shared primitive, `as="span"`, at the track's exact geometry) only while the
  indicator's `refreshing` says a fetch is actually running (a flat track means
  nothing is known and nothing is running), solid when fresh, dimmed + `⟳` when
  stale, `—` once the cache is too old or its window rolled over — and where
  there is no meter the row states why (`no plan limits`, `sign in`,
  `no weekly limit`) instead of showing an empty one. It derives staleness
  itself from `fetchedAt` with the shared thresholds, so nothing has to push for
  a card to degrade. Contract: `docs/usage.md`.
- `ChartBlock.tsx` owns the Markdown/KB `chart` fence renderer (Task 139): it
  parses the constrained spec (`../../lib/chartSpec.ts`), lazy-loads
  `chart.js/auto` ONLY when a valid spec mounts (a separate build chunk, never
  in the main bundle), and always exposes an accessible data table (shown
  outright if the chart library fails to load). A malformed/oversized spec
  degrades to a plain data block. `Markdown.tsx` routes the `chart` language to
  it. Chart.js needs numeric canvas pixels (documented Task-184 typography
  exception), so `readChartFonts()` READS the computed central sans stack and
  the resolved `caption`/`body` role sizes off the DOM and passes those numbers
  to axes/ticks/legend/title/tooltip — never an independent chart scale; the
  canvas rebuilds when the root `data-text-scale` changes (MutationObserver).
- `bottomSheet.ts` owns the ONE bottom-sheet look (gutter, radius, border,
  background, shadow, height cap) shared by `Sheet.tsx`, the shell's
  `ObjectDock`, and `KnowledgeEntryViewer`'s mobile thread popover. Each of
  those had grown its own radius/border/background, so the same gesture at the
  same edge produced three different objects. The tokens carry NO padding and NO
  chrome: a title row with a close, a drag grabber, or a comment card is
  genuinely per surface. The horizontal gutter is deliberate — a card that stops
  short of the screen edges reads as something lying on the page, and it keeps
  the rounded top corners from looking like a cropped rectangle. A fixed sheet's
  CARD bleeds to the bottom of the LAYOUT viewport, which on iOS Safari is
  behind the floating address bar: that is correct for a background (no sliver
  of page between the sheet and the browser chrome) but wrong for content, and
  `env(safe-area-inset-bottom)` cannot fix it because Safari reports 0 there and
  shrinks the VISUAL viewport instead. Hence `BOTTOM_SHEET_BOTTOM_PADDING_CLASS`
  = `max(0.75rem, safe-area)`, the same trick `--app-composer-bottom-padding`
  uses. The shell's `BottomCard` (the object dock, the phone's nav bar) is the
  deliberate exception and does NOT use that padding: it is one card that RESTS
  on screen showing a header you have to be able to hit, so it is positioned
  inside the `100dvh` root rather than fixed, keeping it above the address bar
  at the cost of the bleed. Only its backdrop is fixed. A trigger you cannot tap
  is worse than a gap. It pays for that with the home-indicator inset, which a
  resting card must not simply leave empty — a bar with the page showing through
  below it is not docked — so `BOTTOM_SHEET_SKIRT_CLASS` continues the card's
  background and side borders over the inset as a separate strip, the way a
  native tab bar does. Separate rather than padding on the card because the
  card's own height is what the drag measures.
- `ImageLightbox.tsx` owns the full-screen image viewer (Task-636): a portaled
  band-100 takeover with Escape/backdrop dismissal and exactly two sizes — fit
  to the viewport, or natural resolution in a scroll container, toggled by
  clicking the picture. It renders the `src` it is given, so the caller owns
  origin and token; `ServedFileCard` and the session inspector's artifact
  preview raise it. Focus behaves like `dialog.tsx`: the surface takes focus on
  open (`preventScroll`, since it is fixed over the transcript), Tab wraps
  through its own controls, and focus returns to the thumbnail on close. Escape
  is read by the surface's own `onKeyDown` and stopped there rather than by a
  `document` listener — an older document listener would run FIRST, so a viewer
  opened over the expanded mobile `BottomCard` would collapse that card on its
  way out.
- `Sheet.tsx` owns the portaled edge-anchored modal sheet for content-heavy
  transient mobile surfaces (Escape/backdrop dismissal): `side="bottom"`
  (default, safe-area padded) or `side="top"`, which drops out of a header — the
  caller passes that header's bottom edge as `offsetTop` so the sheet hangs off
  it instead of covering it. Use `Popover` for anchored menus and
  `ChatDockPanel` for composer-local panels.
- `CodeBlock.tsx` owns the standalone Shiki block: language from
  `language`/`filename`, an optional gutter (`showLineNumbers`) that starts at
  `startLine` so a file excerpt keeps the file's own numbering (CSS counter
  offset via `--cb-line-start`), and opt-in `wrap` (default: horizontal scroll).
  Opt-in `copyable` puts an `InlineCopyButton` in the `CollapsibleOutput` footer
  that copies the WHOLE `code`, not the truncated slice on screen — what fenced
  Markdown code blocks use. It paints UN-highlighted first and upgrades in an
  idle slot (`hasCachedHighlight` skips that deferral, so a re-expand never
  flashes) — the plaintext and highlighted shells are visually identical apart
  from colour, so many blocks appearing at once cannot block the first paint.
- `useNearViewport.ts` owns the shared "element is at/near the viewport" hooks
  (caller-owned ref, 600px root margin). `useNearViewport` is the LATCHED flag
  used to defer expensive children until they can be seen (the worktree
  changeset list's file diffs); it releases its observer once it fires.
  `useViewportProximity` reports two facts from one observer — `everNear`, the
  same latch, and `near`, whether the element is at the viewport RIGHT NOW — for
  the transcript's tool-call and thinking bodies: `ToolCallBlock` and
  `ThinkingBlock` build the body on `everNear` (mark the body element
  `aria-busy` and fill it with a height spacer until then, so the flag clears in
  place; a mounted body is never torn down while scrolling) and report
  `onBodyVisibilityChange(open && near)` so a withheld body is fetched, and a
  live one subscribed to, for exactly as long as it can be seen ([Task-697]
  (pa://task/697)). `ToolCallBlock` takes its body as a render FUNCTION for the
  same reason: JSON parsing, diffing and highlighting happen only after the body
  is expanded and has been near. `ThinkingBlock`'s `bodyAvailable` says there is
  reasoning to show when the text has not arrived yet (a lazy or live ref), and
  a live block opens itself until the reader collapses it — which is also what
  stops its text being sent. Both hooks report true when `IntersectionObserver`
  is missing, so the degrade is eager rendering, never blank content.
- `WaveformStrip.tsx` owns the live dictation trace drawn in the collapsed
  composer bar. It is a canvas that reads a `../../lib/waveform.ts` `PeakRing`
  inside its OWN animation frame and never re-renders while recording — ~40 bars
  a second through React state would re-render the composer (and re-layout the
  bar) for one small picture. It draws in the inherited `color`, so callers
  theme it with a text utility, and keeps a visible baseline for silence so
  "nothing is arriving" never looks identical to "not recording". The canvas is
  ABSOLUTELY POSITIONED inside the box the caller sizes and must stay that way:
  a canvas is a replaced element whose device-pixel backing store is also its
  intrinsic size, and iOS Safari sized the composer's recording row from it,
  pushing the stop button off the bar's edge (Chromium shrinks it correctly, so
  this is only reproducible on the device). Out of flow it contributes no width
  to any layout.
- `CommentComposer.tsx` owns the app's ONE shape for appending a comment: one
  row, send button inside it, growing with the text up to a cap — deliberately
  the chat composer's silhouette, because it is the same act. Used by the Task
  activity trace, a Knowledge entry's comments and a worktree diff's line
  comments/replies, so they cannot drift. Enter submits and Shift+Enter breaks
  the line, the chat composer's rule and its touch exception
  (`hooks/useTouchComposerMode`), with ⌘/Ctrl+Enter still accepted: a comment is
  the same act as a prompt, and two different Enters in one app is a coin toss
  every time. `onDirtyChange` reports whether the draft holds anything, so a
  host such as the diff line composer can treat an empty draft as disposable and
  a written one as protected. Its `card` layout is the same composer wearing the
  chat composer's shell (`composerShell.ts`) for a host that OWNS a surface's
  bottom edge — field on top, every control in the action row beneath it — and
  `collapsed` keeps that card mounted with no height, because a field the host
  can focus inside a tap is the only way iOS raises the keyboard on the first
  press. `onCancel`/`onDelete` add the two answers such a host needs beside
  send; delete appears only when the composer holds an EXISTING comment, since a
  draft is what cancel is for. Collapsing ENDS that composer's work: the
  recorder is cancelled, and a refinement from before the close is dropped by a
  work EPOCH the close bumps — that request cannot be recalled, and by the time
  it answers the card may be open again for a different comment, so "is it
  closed" alone would let it through. A card that stays mounted never gets the
  unmount a `row` composer relies on, so a microphone would otherwise keep
  recording behind it with no visible Stop. Telling one UTTERANCE from another
  is deliberately not done here: `useDictation` identifies its own work and
  never delivers a cancelled one, which is the only place that distinction
  exists. It is still NOT the chat composer — attachments, staged context, slash
  commands and plain-Enter send stay in `Composer.tsx`.
- `CommentBody.tsx` is the other half of that pair: how a comment READS. It
  renders the body as Markdown at `compact` density, and every surface that
  shows a whole comment goes through it — diff line threads, Knowledge passage
  threads, a Task's activity trace — so a comment looks the same wherever it is
  read. Markdown because a comment is Markdown wherever it is written (the
  composer accepts it, agents send it, and a body rendering `- item` as a
  literal dash was the app disagreeing with itself); `compact` because a comment
  always sits inside another surface rather than owning the column, and it is
  then the size it was typed at. A roster row's one-line summary is NOT this —
  that is `firstLineOf`, plain text on purpose.
- `composerShell.ts` holds that shell as TOKENS: the width clamp, the card and
  its collapsed skin, the field, the action row and its buttons — the strings
  `Composer.tsx` used to carry inline. A phone has one bottom edge, so whatever
  takes it must read as one object; tokens rather than a component because the
  hosts share only the look (pointer capture, drag-and-drop, collapse animation
  and focus handling are the chat composer's alone), and because importing
  `Composer.tsx` would pull its whole dependency tree into another chunk.
- `GhostIconButton.tsx` owns the standard inline-action pattern (edit-a-field,
  row hover actions); prefer it over making content clickable. Its `busy` is
  `Button`'s in the icon-only shape — the `Spinner` takes the icon's place and
  the button stops accepting clicks (R5), so an inline action does not need its
  own idea of what running looks like.
- `CopyButton.tsx` owns the two copy affordances: `CopyButton` (a ghost
  `Button`, for a row of regular controls) and `InlineCopyButton` (a
  `GhostIconButton` for copy that sits inside content — under a code block,
  beside a value). Both swap the icon for an accent check on success; the inline
  one also raises the copy toast, so its confirmation matches the transcript's
  message copy.
- `highlighter.ts` owns syntax highlighting setup AND the bounded (code,
  language) → hast memo cache in front of `highlightToHast` (insertion-ordered
  LRU, capped by entry count and total cached source length;
  `clearHighlightCache` is the test seam). Highlighting is the transcript's
  dominant cost — ~5 ms for a 12-line tool preview, so a few hundred file tool
  calls cost seconds of synchronous work — and callers re-render for unrelated
  reasons, so never call the highlighter on a hot render path without going
  through this cache (`CodeBlock` additionally memoizes the hast → JSX
  conversion).
- `tree-model.ts` owns generic tree data shaping for UI tree components.
- `SwipeRow.tsx` owns the row swipe: it takes an optional `SwipeAction` per side
  (`left` revealed by a leftward pull, on the row's right-hand edge, and `right`
  mirroring it) and commits one on a release that either passed the threshold or
  flicked that way at speed, with the math in `lib/swipeGesture.ts` and the
  shape fixed by `ui-shell.md` (touch only, edge guard, `touch-action: pan-y` so
  vertical scrolling stays native for the touches the row does not take). The
  engaged DIRECTION is held in a ref and is the whole of "is this engaged":
  reading the side off the travel's sign would let a finger dragging back
  through zero repaint the panel as the other action mid-gesture, and the two
  sides are archive and delete on the rows that have both. A `SwipeAction` may
  declare itself `danger`-toned, which colours the panel from the first px
  rather than at the threshold — arming says "release now", only colour says
  WHAT. It CLAIMS a leaning touch from the scroller the way the shell's
  edge-swipe back does, with a capture-phase, non-passive `touchmove` listener
  registered on the host node in an effect — React registers `touchmove`
  passively at the root, so an `onTouchMove` prop cannot `preventDefault` —
  answered from the touch's own coordinates rather than trusting the pointer
  move to have run first, and said before the row engages, while the moves are
  still cancelable. From then on vertical drift decides nothing. Without it
  `touch-action` was the whole arbitration and a pan starting underneath an
  in-flight swipe took the pointer with it, which is the unreliability the claim
  exists to remove. A release is judged by speed as well as distance: the last
  two moves give a velocity (zeroed when the finger has been still for
  `SWIPE_VELOCITY_STALE_MS`, or holding the row open and lifting would be read
  as the flick it arrived as), a flick commits below the armed threshold and a
  fast throw BACK — against the gesture's own direction — refuses above it, and
  a commit that never armed arms the panel AT the release so the confirmation
  still runs. Travel is kept in a REF and mirrored into state: a flick can
  deliver its last move and its release in one React batch, and a release
  judging the swipe by the rendered value would spring back under the finger.
  The completed swipe also outlives itself by one event, because the click that
  follows lands after the row has sprung back and would otherwise open the row
  the finger just archived. The panel carries the threshold as an ARMED state
  (`data-swipe-state`, filled accent, bolder text and an enlarged icon, while
  the label keeps naming the action throughout), recomputed on every move from
  `swipeArms` — distance alone, since the panel may only promise what a reader
  can see — against a row width measured when the gesture ENGAGES — arming is
  judged during the gesture, so the width must exist before the release, and
  measuring at touchdown instead would force a layout on every tap and every
  list scroll. It is cleared only when the spring-back ends (and not then if a
  finger is already back down, which owns the state and may be holding still),
  so the confirmation of a commit is not repainted away while the action runs;
  under `prefers-reduced-motion` there is no spring-back and the panel goes with
  the travel, so that hold has nothing to show. A gesture that ends any other
  way disarms at once — an accent flash on the way home would claim an archive
  that did not happen. `disabled` abandons a gesture in flight and is how a host
  hands the pointer to something else: `Tree` passes its `isDragging`, because a
  fast swipe cancels the drag sensor by itself (8 px of drift inside its 500 ms
  long press) while a finger that RESTS and then pulls activates the drag AND
  would engage the swipe — one gesture reordering the row and archiving it. The
  drag wins, being the one already under way. `Tree`'s `rowSwipe` is the only
  caller so far: it returns the sides per node, or `null` where the row has
  neither — an offered swipe that refuses on release is worse than no swipe, and
  a row with nothing on a side must not claim touches toward it — and it acts on
  the swiped row alone, never on a multi-selection, since a finger has selected
  nothing. A `run` that answers `true` — the action TOOK the row out of the list
  — ends the gesture in the row leaving rather than springing home: it carries
  on to `translateX(±100%)`, and the panel — a square full-width layer parked
  past the uncovered edge (`left-full` / `right-full`) that shares the row's
  transform, so it slides in glued to the row's edge — follows it across the
  width being vacated (a row body is transparent, so the panel is what covers
  the space, and never overlaps it), then the host's height closes from the
  height measured at release, which is what draws the rows below up into the
  gap. `onExited` fires at the end, and the host must keep the row mounted until
  then (`Tree`'s `rowSwipe.onExited`; `BacklogTreePane` holds the Task). The
  exit is three phases and one timer each, because each leg has to animate from
  what the previous leg painted — `height: auto` does not transition, and a gap
  closing while the row is still in it reads as one shrinking row.
  `prefers-reduced-motion` skips to the end: the row still goes, it just does
  not travel to say so. A row that has left is `inert` — the whole subtree out
  of the focus order and the accessibility tree at once, which `aria-hidden`
  cannot do, since the row's buttons are focusable and focusable content inside
  `aria-hidden` is the failure rather than the fix — plus `pointerEvents: none`,
  because `inert` only promises about clicks and a drag sensor reads
  pointerdown. Known limit: the `li` AROUND the swipe surface is the tree's, so
  it keeps its `treeitem` role for the ~340 ms the row is leaving, and arrow-key
  navigation still stops on it. A row still mounted `EXIT_ABANDON_MS` after it
  left is one the action did not remove (a rejected write), and it comes back
  rather than leaving a hole; that number is a ceiling on how long the answer
  may take rather than a beat in the animation, because ending the wait early on
  a slow link would flash a row back into a list about to drop it — an archive
  that worked, drawn as one that failed.
- `shortcuts.tsx` owns the app-wide keyboard-shortcut registry
  (`ShortcutsProvider`, `useShortcuts`) and the `?` help overlay; `Tree`
  registers its `rowActions` here display-only.

## Contract notes and rationale

- Keep primitives domain-light and reusable; do not import feature pages or
  socket state.
- Preserve dark/theme-compatible styling using existing CSS variables and
  Tailwind utility patterns.
- Expensive render helpers should cache or lazy-load where existing patterns do.

## Working notes

- Prefer extending primitives here when multiple feature components need the
  same interaction or rendering behavior.

## Verification commands

- Run `pnpm --filter @assistant/web build` for this subtree.
- Run root `pnpm run build` before closeout.
