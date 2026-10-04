<!-- instruction-budget: bytes=2688 reason="The Markdown presentation rule prevents links silently becoming cards; the existing rendering and loading rules already exceed 2048." task=document-presentation date=2026-09-11 -->

# Web components

- Markdown: `[x](target)` is a link, `![x](target)` a chrome-free lazy embed,
  and tool output the ONLY card. `[![x](y)](z)` keeps the authored link z and
  nests no anchor or button in it. Origin-check before classifying/minting;
  foreign `/api/files/` lookalikes stay external. Untrusted HTML uses
  `rehype-raw` then `rehype-sanitize`; internal HTML runs only through opaque,
  source-scoped grants in `SandboxedDocument.tsx`. Never weaken either.
  `rehype-katex` runs LAST because sanitize strips MathML. Keep the `components`
  map at MODULE scope and per-render data in `MarkdownRenderContext`, or React
  remounts every element, losing scroll and re-running Shiki
  (`Markdown.test.tsx` re-renders; `docs/served-files.md`).
- Settings and integration pages are end-user surfaces: deployment details,
  protocol names, scopes, token diagnostics and test controls stay out of the
  primary flow; tokens and raw credential files never enter the UI.
- Rich tool cards tolerate partial, streaming or malformed output, aligned with
  the server `renderKind`. A new card registers in `tools/` with a focused
  `shouldRender…` predicate on normalized names and render kinds, never a
  provider-only label.
- An async region renders one of loading/refreshing/ready/empty/error: empty
  only once the source answered, refreshing never blanks an object's data (a
  different object gets a placeholder). That chrome comes from `ui/load.tsx` and
  `Button`'s `busy` (`loadingStateAudit.test.ts`;
  `../../docs/loading-states.md`).
- A memoized row (session, worktree, task, message) takes ids in its callbacks,
  never closes over the row, and gets stable handlers from its host; the parent
  file says why.
- Import `diff/`, `ui/ChartBlock.tsx` and `rehype-katex` lazily — statically
  they pull pierre/Shiki, Chart.js and KaTeX into the main bundle — and never
  call `ui/highlighter.ts` outside its cache on a render path.
- Nothing in a transcript row may rely on overflowing its box. Rows use
  `content-visibility: auto` off iOS, `visible` on iOS; portal popovers to the
  body. Keep hit-testable overlays and sticky headers off the transcript's top
  edge: `useTranscriptScroll` hits that edge to hold the reader's row on iOS.
  Blocks between rows are safe.
- Side activity follows `docs/chat-activity.md`: collapsed, one-line rows;
  actions addressed to the user and failure indicators stay visible.
