# Persistence

- Keep SQL in this folder. Consumers call `sessionStore` or a narrower facade.
- Session CONTENT never enters SQLite; conversation bodies live in session logs
  or harness stores. Durable locators are session/provider ids, not derived
  local paths.
- Preserve `sessionStore.upsert` merge semantics: omitted optional fields do not
  clear metadata. `projectStore.put` instead replaces child tables and edges, so
  callers pass a complete record.
- `session_index.scope` is DEFAULT-CLOSED and INSERT-ONLY: reads without
  explicit `scopes` cover `user` only; live lists use persisted scope
  (`liveDefaultScopeGate`) and exclude unreadable rows; registration claims
  scope FIRST with `claimScope`, which throws on contradiction; later writes
  never reclassify a session.
- Projects keep stable TEXT slug ids referenced by `in_project` edges and
  `knowledge/projects/<id>/`; never switch them to integer sequences.
- Every `subagentStore`/`backgroundWorkStore` mutation uses its
  transaction-aware touched-id seam, and capacity takes its limit from the
  caller. Background work stores no vendor address, pid, command, path, env,
  credential, or output. Boot may call a planned drain stopped only when Stop
  was not `unconfirmed`; an abandoned unconfirmed drain is `lost`. Accepted
  residual window: force-exit during grace or the first Stop attempt still reads
  as planned `stopped`, since the process ended the work and nothing resumes.
- Write edges only through `links.ts`, whose counters invalidate list memos; add
  relations to its fixed vocabulary, not per-call strings.
- Add a NEW forward migration rather than editing a shipped one. Update row
  mapping, run `migrations:lock`, and commit `migrations.lock.json`.
- A migration VERSION NUMBER is its identity in every database that applied it.
  If a rebase collides, renumber YOUR never-applied migration to the next free
  version, never the one on `main`, and never hand-edit or drop a lock entry.
  `docs/migrations.md` has the repair runbook.
