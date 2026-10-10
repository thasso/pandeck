# Web hooks

- Do not duplicate global app state outside `useAssistant` unless it is strictly
  a browser-local preference or cache.
- For the viewed chat, derive run state only from runtime snapshots/events —
  never from session-list rows. The transcript is a WINDOWED suffix: gapless,
  anchored to the live tail, extended only by a `loadTimelineRange` answer that
  joins its first entry, and seeded for turn stats by `turnStatsSeed`. A corrupt
  local range falls back to a fresh windowed snapshot, never a splice.
- Domain lists arrive by SUBSCRIPTION, not with `ready`: a surface that reads
  `tasks`, `projects` or `worktrees` must be covered by `App.tsx`'s topic
  derivation, and each subscription's answer is authoritative over any cached
  list.
- Task lists are SUMMARIES only. Markdown bodies are bounded per-id
  `LoadState<TaskItem | null>` entries in `state.taskDetails`; only a ready body
  may save, while loading, failure, `ready(null)` not-found, and empty differ.
- Worktree comments and approval/peer-prompt cards are authoritative per-object
  projections from their broadcasts, keyed by id and rebuilt in place — never
  tail-appended to the transcript or mutated on the durable timeline.
- `normalizeCachedSessions` must keep dropping every live-derived field and the
  `personal-assistant` singleton row on shell-cache hydration, and an optimistic
  `settleSession` must not move `updatedAt` and must send its row's OBSERVED
  attention revision (0 when absent).
- Pending session routes wait for the addressed snapshot, even offline. A
  session absent from the cached list never justifies reverting to the old chat.
- Transcript display changes call `useTranscriptScroll`'s `holdViewChange` in
  the flipping EVENT, then `commitViewChange` in the commit with the new flags,
  which starts the deadline. Never capture in render or time from the click:
  React may abandon or defer that render. Both halves preserve reading position.
