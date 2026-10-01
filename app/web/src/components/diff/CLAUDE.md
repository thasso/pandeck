# Diff and file surfaces

- Pierre renders in shadow DOM and ships no CSS. Never import a stylesheet for
  it or fork its internal selectors; typography is set only through the four
  supported host custom properties on `app-diff-host`.
- Pass a `cacheKey` that changes with the rendered content or patch, remount the
  pierre view on worker completion, and keep `useDiffScrollRestoration` on every
  surface so host/column replacement cannot reset either scroll axis.
- The `options`, file and annotation objects handed to pierre must be the SAME
  objects while their content is unchanged: its render effect compares them by
  identity, so a fresh one rebuilds the surface — the hover gutter blinks out
  under the reader and the file is re-highlighted. Callers build them inline, so
  the surfaces hold them by value (`useStableCommentsConfig`, the memos beside
  it); `DiffSurface.stability.test.tsx` pins it.
- Comment creation starts from Pierre's built-in GUTTER utility or a native text
  selection; the gutter opens its inline composer directly, while a selection
  arms the route's Add-comment action. A bare row tap never creates. Do not pass
  `renderGutterUtility` — it owns pointer capture, `touch-action` and selection
  ranges, and a slotted button races it on iOS. Disable selection and the gutter
  utility while a draft composer is open, and leave nothing SELECTED behind it.
- Slotted annotations inherit `white-space: pre`; reset it or comments never
  wrap.
- Never use React `autoFocus` on coarse pointers here: focusing as the
  annotation appears makes iOS Safari zoom and pan the visual viewport.
- Comments are created on the additions/current side only, and a deletions-side
  tap must say so rather than fail silently.
- Committed surfaces pass `refOid` so threads render at their immutable creation
  anchors; current-content surfaces re-anchor instead.
- Split is desktop-only: a mobile surface renders unified through override prefs
  and never writes the shared `usePrefs` display mode back.
