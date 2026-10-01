# Web app source

- `useAssistant` is the single reducer/effect layer for WebSocket protocol
  state; never duplicate that state elsewhere.
- Routes are canonical per `app/web/docs/ui-shell.md`: one shape per object type
  plus section index routes, no aliases, and an index route renders a real
  surface. Back targets that index route, never `history.back()` — only the
  header's arrows do.
- Every hook in `App.tsx` must sit ABOVE the `showLoadingShell` early return: a
  hook below it changes the hook count on the hydrating render (React #310,
  blank app on a fresh profile). `appHookOrderAudit.test.ts` enforces it; no
  render test catches it.
- `index.css` owns typography: components select the six size roles, never font
  sizes, `leading-*` or arbitrary Tailwind sizes (`typographyAudit.test.ts`).
- A `saveTask` not editing the title OMITS `title` (an update without one keeps
  it) but must still send `status`, coerced to `todo` when missing
  (`taskSaveTitleAudit.test.ts` allowlists the two title saves).
- Every prop handed to the transcript, composer, `Sidebar` or an inbox card must
  be referentially stable while its content is: `useCallback` handlers, the
  narrow `BacklogState` slice, and the content keys in `lib/transcriptKeys.ts`
  and `lib/sessionRows.ts` — which ignore ORDER, since the session list re-sorts
  by `updatedAt` constantly. A handler whose honest dependency list is the whole
  render (`sendPrompt…`) goes down over a REF instead: a hand-kept list there
  sends stale context. This fails in speed alone, so assert counts, never
  durations, in `uiLoadScenario.test.ts` and `transcriptRedrawScenario.test.tsx`
  (what a broadcast may redraw or re-render).
- A scrolling list owns its reading position through `useListScroll` (stable
  `listKey`) and every row carries `data-list-row-id`. Both fail silently:
  without the hook a phone reopens the list at the top, without the id a restore
  drifts once the list re-sorts.
