# Web diff viewer — implementation reference

Relocated from `app/web/src/components/diff/CLAUDE.md` (Task-274) so it stops
costing agent context on every visit. This is a descriptive snapshot of what the
modules in that subtree own; the rules an agent must not violate stay in that
folder's `CLAUDE.md`. Correct or delete a section here when the code moves on.
Relative paths in the body are relative to the original subtree.

## Purpose

The shared diff/file rendering stack on `@pierre/diffs`: one surface for every
diff and code-file view in the app, with remembered display modes.

## Module ownership

- `DiffSurface.tsx` owns diff rendering (full old/new contents preferred for
  Pierre's native context expansion; patch text is the fallback for callers
  without contents). It also owns the IDENTITY of everything handed to Pierre.
  Pierre's render effect carries no dependency array — it runs on every render
  of its React wrapper and compares `options` (shallowly), the file objects and
  the annotations array by reference — so a fresh object rebuilds the surface:
  the hover gutter that opens a comment blinks out under the pointer, and the
  file is re-parsed and re-highlighted. Every caller builds those objects inline
  (`oldFile={{ name, contents }}`, `comments={commentsConfigFor(path)}`) under a
  page that re-renders on each socket broadcast, so the surface holds them by
  value instead: `useStableCommentsConfig` (comments.tsx) plus the memos beside
  it, and `useCallback` for the option handlers.
  `DiffSurface.stability.test.tsx` pins it with a mocked Pierre. `App.tsx`
  closes the other half by handing each worktree ONE `CommentActions` object for
  the life of the app.
- `FileSurface.tsx` owns plain-file rendering with the same theme/wrap behavior,
  the same line-comment machinery, and the same identity discipline.
- `DiffWorkerProvider.tsx` owns @pierre/diffs worker-pool setup, render-option
  sync, syntax-highlighting progress UI, and completion versioning for diff/file
  surfaces. Its progress pill is a `role="status"` region drawing the shared
  `common/load.tsx` `Spinner` (Task-361 Phase 3c): the app has ONE loading
  glyph, and its own pulsing dot said "something is happening" in a second
  visual language.
- `useDiffScrollRestoration.ts` owns scroll continuity across Pierre host and
  shadow-column replacement: it remembers the surrounding viewport's axes and
  each shadow-root code pane's horizontal offset without causing React renders.
- `DiffModeToolbar.tsx` owns the display-mode controls (unified/split,
  word-level, ignore-whitespace, wrap, context). Its `stacked` popover layout
  keeps unified/split segmented and presents Words/Ignore
  whitespace/Wrap/Context as a regular vertical checkbox menu; `showStyleToggle`
  hides the style control where unified mode is forced.
- `diffOptions.ts` owns the pure prefs → pierre options mapping (Catppuccin
  Latte/Mocha themes, matching `common/highlighter.ts`). Word-level maps to
  Pierre's `word-alt` (joins adjacent changed spans — its own default — not
  plain `word`, which leaves per-token boxes fragmented). Ignore-whitespace maps
  to `parseDiffOptions.ignoreWhitespace`, which Pierre only consults when it
  computes the diff from `oldFile`/`newFile` contents (not for pre-parsed patch
  text).
- `comments.tsx` owns the compact line-comment widgets (thread card and
  composer) and the `useLineComments` hook both surfaces share. The thread card
  is the app-wide thread SHAPE: author, body (Markdown, through the shared
  `common/CommentBody` — one comment body look for the whole app, at the size it
  was typed at rather than the diff's mono caption), replies, then ONE bottom
  row of icon actions — reply (the shared `common/CommentComposer`),
  resolve/reopen, and delete at the far right behind a Yes/No confirm, which it
  previously performed on a single unguarded tap. It offers no per-comment
  handoff to an agent (that is a review, submitted as a batch from `../review/`)
  and no jump (it renders on the line it annotates), and it badges the anchor
  only when it has MOVED. Two anchor modes via `LineCommentsConfig`:
  current-content surfaces (no `refOid`) display threads at re-anchored
  `current` positions; committed surfaces pass `refOid` (the resolved commit oid
  of the displayed new side) — threads then display at their immutable creation
  anchors for exactly that commit, and new comments are created with
  `NewWorktreeCommentAnchor.ref` so the server snapshots them at that commit.

## Contract notes and rationale

- Import this folder only lazily (`React.lazy`) — it pulls the pierre + Shiki
  stack into its own chunk; never static-import it from the main bundle.
- Diff display modes live in `usePrefs` (`diffStyle`, `diffWordLevel`,
  `diffWrap`, `diffExpandContext`) so every surface follows one remembered
  configuration. Exception: split is a desktop-only mode — mobile surfaces
  render unified regardless of the pref (the worktree page passes override prefs
  and hides the style toggle) without writing the pref back.
- Pierre renders in shadow DOM and ships no CSS; do not add stylesheet imports
  for it. Typography is set ONLY through the four supported host custom
  properties: every `File`/`FileDiff`/`MultiFileDiff` carries the
  `app-diff-host` class (`index.css`), which maps `--diffs-font-family`→central
  mono, `--diffs-header-font-family`→central sans, `--diffs-font-size`→scaled
  `caption` token, and `--diffs-line-height`→the `caption` line height, so
  diff/file code matches Shiki exactly and tracks the text-scale preference. Do
  not fork Pierre's internal selectors or use render options for fonts.
- Pass a `cacheKey` that changes with the rendered content/patch so pierre's
  worker highlight caching stays correct.
- Diff/file surfaces should subscribe to `DiffWorkerProvider` completion
  versioning and remount their pierre view when background highlighting
  finishes; this makes cached highlighted output appear automatically even if
  the underlying web component misses an async paint. Every surface also runs
  `useDiffScrollRestoration`: Pierre owns horizontal scrolling in shadow-root
  code panes while the page owns vertical scrolling outside them, and a host or
  column replacement must restore both independently. Mutation and resize
  observation covers asynchronous highlight paints and layout changes as well as
  React remounts.
- A bare tap on a diff row never creates a comment. Pierre's built-in gutter
  plus button (`enableGutterUtility` + `onGutterUtilityClick`) is the primary
  named affordance and opens its inline composer directly; native single-line
  text selection is the secondary, sub-line path. `DiffCommentBarProvider`
  coordinates selected targets from lazily mounted files in a changeset and
  publishes `{ canComment, onComment, pendingCount, onSubmitReview }` through
  `review/CommentActuation.tsx`. The shell's Add-comment action activates the
  selected target from the page header on wide layouts and the object dock on
  small layouts; the inspector carries that same action. The built-in plus
  remains a small (roughly 20 px) thumb target and has been reported as easy to
  miss on a phone. That is an accepted trade-off: a bare row tap is not a
  deliberate named affordance, while replacing or overlaying Pierre's
  shadow-owned target loses its pointer handling. This integration does not
  enlarge the hit area, and this change was not regression-tested on a physical
  phone; the secondary selection path and Chrome checks do not erase that
  residual touch risk.
- Keep controlled `selectedLines`, `enableLineSelection`, `enableGutterUtility`,
  `onLineSelectionChange`, and `onGutterUtilityClick`. Do NOT pass
  `renderGutterUtility`: Pierre's built-in utility owns pointer capture,
  `touch-action`, range dragging, and pointerup dispatch, and its dedicated
  callback is isolated from `onLineClick`. A custom slotted button races that
  machinery on iOS and can degrade into double-tap zoom. Disable
  selection/utility while a draft composer is open and clear selection on
  submit/cancel. Pierre leaves code text natively selectable but exposes only
  line-range callbacks, so `useDiffTextSelection` snapshots one selected line
  from the open shadow root and maps it to offsets in the shown new-file text.
  It uses `Selection.getComposedRanges({ shadowRoots })` where available because
  Safari clamps ordinary `getRangeAt()` results at a shadow boundary, with the
  variadic `getComposedRanges(...shadowRoots)` fallback shipped by Safari
  17–18.1. If neither signature works (or the API is absent), this secondary
  path fails closed without throwing; the gutter remains the supported primary
  path. The snapshot clears on a collapsed/invalid selection, an outside
  pointer-down, or Escape. Pointer-down on `[data-comment-actuation]` (and the
  legacy `[data-comment-bar]`) is exempt from dismissal, and shell actuation
  controls prevent its default so their click can consume the snapshot before
  iOS collapses the native selection.
- Diffs only create comments on the additions/current side, and a deletions-side
  gutter activation or selection SAYS SO (a toast) rather than failing silently.
- The new-comment composer sits one line down and is JUST the shared
  `common/CommentComposer` row — send inside the field, Enter (Shift+Enter for a
  newline), cancel beside send, growing with the text. It states no line: it
  opens under the one the reader just pressed the gutter on, and the caption
  that used to say so existed only to carry a ✕, which is now the composer's own
  action. Opening it also CLEARS pierre's line selection, so no highlight is
  left painted behind it. Escape cancels in both states, and an EMPTY composer
  is also dismissed by a tap AWAY from the diff
  (`useDismissEmptyComposerOnOutsideTap` — Pierre retargets shadow-DOM taps to
  its `.app-diff-host` element, so one class check distinguishes "inside a diff"
  from "outside", and taps inside stay the line handler's business).
- Following a comment LANDS ON IT: `LineCommentsConfig.focus` ({ commentId,
  nonce }) names a thread, and `useFocusComment` scrolls the annotation into
  view and rings it briefly. Each thread's annotation carries a
  `data-comment-anchor` marker for exactly that lookup — the annotation itself
  is Pierre's, so nothing of ours could find it otherwise — and the search
  RETRIES for a bounded number of frames, because the annotation arrives
  asynchronously and in changeset mode the file's section only mounts once the
  scroll brings it near the viewport. The surfaces wrap their Pierre element in
  a `display: contents` div purely to have a light-DOM root to query; it adds no
  box.
- Comment/reply textareas mirror the chat composer's typography (`16px`, relaxed
  line height, inherited sans font) on every viewport. Do NOT use React
  `autoFocus` on coarse pointers: focusing as Pierre inserts the annotation
  makes iOS Safari zoom/pan the visual viewport to a corner despite the 16px
  field. Fine pointers may focus with `focus({ preventScroll: true })`; touch
  users deliberately tap the field after opening it. Keep annotation chrome
  compact: subtle edge accent rather than a nested card, transparent field, two
  rows, and short action controls.

## Verification commands

- Run `pnpm --filter @assistant/web build` (chunk budgets) for changes here.
