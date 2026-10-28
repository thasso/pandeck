<!-- instruction-budget: bytes=3584 reason="seven independent contracts: repo locking, synthetic main, managed delivery, removal consistency under foreign ownership, review tombstones, status refresh tiers, and context resolution" task=659 date=2026-09-23 -->

# Worktrees

- Mutating git operations go through `withRepoLock` (`../gitExec.ts`); read-only
  scans stay lock-free. Network-bound exceptions live ONLY in `../CLAUDE.md`.
- Paths that ACT on a checkout decide from their OWN `checkWorktreeCheckout`:
  edge compared, consumed yield-free in that continuation
  (`withCheckedCheckout`); views read the cache. A Worker failure rejects, never
  reads as missing (`docs/workers.md`).
- The project's main checkout is derived live from project `localPaths` and
  surfaced as the synthetic `main:<projectId>` record; it is never a DB row. DB
  rows are spawned worktrees only, removed softly (`status='removed'`).
- Agent delivery targets only an active persisted spawned-worktree id: the
  server derives path/branch, revalidates under the caller-aware mutation
  reservation, and never admits synthetic main or caller-supplied refs. PR
  creation proves a same-named upstream at exact local HEAD, resolves hosting
  from that push repository, and anchors the card on the caller timeline with
  the target worktree. Finishing takes the per-PR lock on the row's ONE open PR:
  a merge re-derives readiness through the shared check-watch function and needs
  a currently supported method, unknown capabilities fail closed, a base EXACTLY
  equal to the provider-reported default branch merges only through a
  revalidating approval, and a close needs a reason and keeps branch, worktree
  and Task.
- Checkout removal is consistency-bound: refuse before any git mutation when the
  tree holds a directory another uid owns (never force past it; reclaim it
  first), never finalize a record on a prune whose success is unproven
  (re-probe: a locked worktree survives it), and when git unregisters a checkout
  whose directory survives, finalize the record anyway and report the residue.
- Spawned-worktree review comments are object-bounded: after checkout removal,
  atomically tombstone the row and purge comments under the repo lock, then
  broadcast empty before optional branch cleanup. A retry requires its persisted
  expected ref oid, re-read under the repo lock; refuse a checked-out ref;
  require base semantic containment, merged-head ancestry or freshly verified
  remote ancestry. Clear only on proven absence or success/ref reuse. Ordinary
  tombstones are never retryable. Synthetic-main root threads holding this
  worktree as their branch subject are purged when its merge finishes or its
  identity-bound branch is proven deleted.
- Live git state (dirty, ahead/behind, merged) is computed on demand, never
  persisted. Remote-only batches use ONE root map and one row-context read per
  invisible OWN branch; exact visible OWN targets and missing/stale baselines
  full-scan. Every ref batch full-scans symbolic refs. Plain reads coalesce onto
  an in-flight scan; a FORCED read is authoritative and never adopts a scan that
  started before its caller's change, which would report pre-change counts as
  current. Root-visible tracking is authoritative for targeting; manual
  per-worktree or `includeIf` overrides can leave OWN counters stale after fetch
  and are an accepted limitation. Never memoize/gate an invisible-row context
  read from root-context state.
- Naming must never block creation: every naming failure falls back to a
  timestamp suffix.
