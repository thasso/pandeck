# Web app source

- `useAssistant` owns WebSocket state as the single reducer/effect layer. Never
  duplicate it.
- Routes follow `app/web/docs/ui-shell.md`: one shape per object type, no
  aliases, and real surfaces at section index routes. Back targets that index,
  never `history.back()`; only header arrows traverse history.
- Every `App.tsx` hook sits ABOVE the `showLoadingShell` early return. Hooks
  below it change the hook count on hydration, causing React #310 and a blank
  page. `appHookOrderAudit.test.ts` guards this; render tests cannot catch it.
- Use shadcn `components/ui/` per `app/web/docs/ui-components.md`. Theme tokens
  only, `text-xs`–`text-xl` only. New colors, tokens or ad hoc mixes require
  explicit approval. `uiConsistencyAudit.test.ts` counts may only drop.
- A `saveTask` not editing the title OMITS `title` but sends `status`, coerced
  to `todo` when missing. `taskSaveTitleAudit.test.ts` allowlists title saves.
- Props to transcript, composer, `Sidebar` and inbox cards stay referentially
  stable while their content does. Use `useCallback`, narrow `BacklogState`
  slices and content keys in `lib/transcriptKeys.ts` and `lib/sessionRows.ts`.
  Keys ignore ORDER because sessions re-sort by `updatedAt`. Handlers depending
  on the whole render (`sendPrompt…`) go through a REF; partial dependency lists
  send stale context. Assert render counts, never durations, in
  `uiLoadScenario.test.ts` and `transcriptRedrawScenario.test.tsx`, covering
  what broadcasts redraw.
- Scrolling lists retain position through `useListScroll` with a stable
  `listKey`; every row carries `data-list-row-id`. Without the hook, reopening
  starts at the top; without row ids, restoration drifts after reordering.
