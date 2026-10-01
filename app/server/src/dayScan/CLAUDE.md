# Daily scanner

Product contract: `docs/day-scan.md`.

- Raw API payloads and message bodies go ONLY to the non-Git cache (the privacy
  hybrid). Committed facts carry no verbose worklog descriptions of others and
  no per-person hours reports. The one explicit owner exception: ATTENDANCE
  facts for the user's OWN (confirmed, see below) meetings and huddles may
  commit attendee display names and present durations — names, status and
  durations only, never emails or bodies.
- ATTENDANCE requires a participant-session match for the configured user: a
  Meet session of theirs, or a huddle they joined. An accepted invitation or a
  listed conference record is NOT attendance — never tagged `own`/`attended`,
  never `attendedSeconds`, never a Tempo duration, and never presenting the
  conference duration or others' attendance as the user's. Where a Meet session
  cannot exist (in person, another provider), the accepted slot may still be
  used, marked as resting on acceptance alone.
- Snapshots, manifest, deltas and rollup are committed KB assets under
  `daily-summaries/<date>/assets/`. The day entry's machine-data region is the
  ONLY generated part of its `index.md`; narrative and `## Notes` are never
  touched by collection.
- Every collection/synthesis KB commit uses the `day-scan`/`day-synthesis` actor
  names: the PA collector's self-exclusion and the `pathGuard` bypass both key
  on them. Synthesis applies ONLY through `applySynthesis` (journaled,
  idempotent), and ordinary agent tools never write day-scan-owned artifacts.
- The synthesis runner MUST return the `synthesisSchema` structured result;
  free-form entry edits are never trusted, and source-derived text stays
  untrusted data bounded by validation and the link allowlist.
- Task status changes carry provenance (`UpdateTaskInput.actor`); a call site
  that omits it degrades to `system`.
