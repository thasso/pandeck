# Server worktrees — implementation reference

Relocated from `app/server/src/worktrees/CLAUDE.md` (Task-274) so it stops
costing agent context on every visit. This is a descriptive snapshot of what the
modules in that subtree own; the rules an agent must not violate stay in that
folder's `CLAUDE.md`. Correct or delete a section here when the code moves on.
Relative paths in the body are relative to the original subtree.

## Purpose

Git worktree domain: spawn worktrees from a project's main checkout, name them
via the naming agent, list them with resolved edges, and remove them safely.
Worktrees are first-class objects that own changes; sessions and tasks link to
them. The project's **main checkout** is a first-class worktree too, emitted as
a synthetic record (never a DB row).

## Module ownership

- `worktreeResolve.ts` owns identity and resolution — main-repo resolution from
  project localPaths (TTL-cached, generation-guarded), the synthetic
  `main:<projectId>` id, and `resolveWorktreeRow`. It is the layer's LEAF:
  lifecycle, status, comments and the watcher all resolve through it, so it may
  not import them (`docs/linting.md`, the cycle gates).
- `worktrees.ts` owns the lifecycle: `git worktree add/remove` (under
  `withRepoLock`), unmerged/dirty removal guards, listing, and `worktreeList`
  broadcasts. The containment guards absorb expected non-zero git exits, but
  execution failures propagate rather than answering the removal-safety question
  permissively. After checkout removal (or required pruning) succeeds,
  `removeWorktree` atomically tombstones the row and purges scoped comments
  under the repo lock, broadcasts empty, then performs optional branch cleanup.
  The tombstone persists the expected branch oid only while cleanup is pending;
  retry re-reads the claim under the repo lock, distinguishes proven ref absence
  from probe failure, refuses a branch checked out in any worktree, and uses the
  same ancestry-or-tree-equality base containment as removal. It clears the
  claim only on success, proven absence, or ref reuse. Completed tombstones are
  not retryable. A typed cleanup failure means checkout removal succeeded:
  `../worktreeRemoval.ts` settles sessions before rethrowing the branch error,
  and Retire accepts the pending tombstone as the reachable retry. That module
  also owns the settle gates and run hold, so the worktree page and `/pr` card
  cannot diverge.
- Removal consistency (Task 659): a pre-mutation scan (`managedTreeRemoval.ts`)
  refuses a checkout holding a directory owned by another uid, for FORCED
  removals too, after first trying to hand it back through the container runtime
  (`containerResidue.ts`). `git worktree remove` is not atomic — it deletes its
  admin directory even when the working tree removal failed — so a failure is
  re-probed: still registered means nothing durable happened and the error
  propagates untouched; unregistered means the directory is finished off here,
  the record is finalized anyway, and `WorktreeDirectoryResidueError` reports
  what is still on disk. A path that exists but is no longer registered takes
  the same finishing route, which is what unsticks a row left by an earlier
  partial removal. `git worktree prune` exiting 0 is NOT evidence that Git let
  go — a LOCKED worktree with a missing folder survives it (verified on git
  2.54) — so registration is re-probed after a prune that is the only evidence
  (the missing-folder and unregistered-with-folder branches), and a
  still-registered checkout refuses before the record is finalized. The
  caught-failure branch needs no second probe: it already proved Git let go
  before it pruned.
- Submodules and removal: Git refuses `worktree remove` for any checkout
  carrying submodules ("working trees containing submodules cannot be moved or
  removed") and only `--force` skips that check, so `removeWorktree` derives
  `--force` when `hasSubmoduleCheckout` sees the worktree's private `modules`
  gitdir or a populated gitlink in its index — Git's own
  `validate_no_submodules` conditions. Creation initializes submodules, so
  without this NO worktree of a superproject could be removed unforced. What
  Git's refusal protected is replaced, not dropped: `deriveSubmoduleForce` runs
  under the repo lock and refuses (`WorktreeRemovalBlockedError`) when the
  checkout is dirty — REPEATING the caller-side check, because the derived force
  also skips Git's own at-removal cleanliness check — or when
  `submoduleWorkAtRisk` finds a populated submodule (recursively) holding
  commits or stash entries that neither a remote nor a tag has. That interior
  check is the one the superproject cannot express: a branch or stash made
  inside a submodule, or a commit on its detached HEAD reset back to the
  gitlink, leaves superproject status clean while living only in the gitdir
  removal deletes. Both negations in
  `rev-list --count -1 --all --not --remotes --tags` are load-bearing, because
  `submodule update` CLONES: `--remotes` lets the clone's own branches pass, and
  `--tags` lets an upstream tag on history no branch reaches pass — without it
  such a superproject would again be permanently unremovable unforced. The
  residue is a commit whose only local ref is a user-made tag. Every probe fails
  CLOSED: an unreadable submodule index or a failed `status`/`rev-list` refuses
  rather than returning the force that disables the guard (an unreadable ROOT
  index instead derives no force, handing the decision back to Git's refusal). A
  caller-requested force skips the whole derivation: it has already accepted the
  loss.
- Synthetic main worktree (in `worktreeResolve.ts`, the layer's leaf): id
  `main:<projectId>`
  (`mainWorktreeId`/`isMainWorktreeId`/`projectIdFromMainWorktreeId`).
  `resolveWorktreeRow(id)` is the resolver seam every read/watch/comment surface
  uses instead of `getWorktree` — it returns a spawned row or, for a `main:` id,
  a synthetic `WorktreeRow` (`resolveMainWorktreeRow`, keyed on the CANONICAL
  `project.id`, `path=mainRepoRoot=root`, `baseBranch===branch` so status is
  dirty-only). Records carry `isMain`; main sorts first per project.
  `mergeWorktree`/`removeWorktree` reject a `main:` id (agent-lifecycle
  operations); user-initiated `commit`/`push` (worktreeWrite.ts) ARE permitted
  on main — decided 2026-07-19, Task 125. Session cwd binding stays synchronous
  via git-free `mainCheckoutPathForProject` (prefers a `.git`-backed localPath
  to match `resolveMainRepo`).
- Performance guards for synthetic-main resolution (each `resolveMainRepo`
  spawns up to 3 git processes per candidate path): `resolveMainWorktreeRow`
  goes through a short-TTL + in-flight-coalescing cache
  (`resolveMainRepoCached`) so bursty reads/scans resolve once;
  `listWorktreeRecords` fans out under `mapLimit` (bounded concurrency) across
  `listProjects()`. `mainCheckoutPathForProject` (sync cwd resolver) returns the
  cached git ROOT when a fresh resolution is cached (aligns with the synthetic
  row even for a localPath nested in a repo), else a realpath'd git-free
  fallback. Invalidate a project's cache with `invalidateMainRepo(projectId)`
  after localPath/worktreeRoot edits — wired in BOTH `connection.onSaveProject`
  and the `project_registry_write` tool
  (upsert/update/add/removeLocalPath/delete); the TTL still bounds branch-label
  staleness otherwise. Invalidation bumps a per-key generation and a cold
  resolve only writes back if the generation is unchanged, so an invalidation
  landing mid-resolve can't be clobbered by the older in-flight resolve
  completing. `canonicalWorktreeId`/`worktreeExistsSync` are git-free (in-memory
  registry) so the watcher canonicalizes + validates ids synchronously;
  `worktreeExistsSync` requires a main project to have an existing
  repo/workspace localPath, and `addWorktreeViewer` RELEASES its reserved ref
  (no inert entry) when the async resolve then finds no git-backed row.
- `broadcastWorktreeList` is COALESCED + SERIALIZED (one computation at a time;
  a request during a run flags a recompute so the last send reflects current
  state). Callers FIRE it (`void`), never await — lifecycle ops (create/remove)
  must not block on unrelated project probes, and serialization prevents an
  older fire-and-forget broadcast from landing after a newer one.
  `broadcastWorktreeEdgeChange()` is the shared fire-and-forget entry point for
  relation-only changes such as linking a newly created session. The `worktrees`
  topic subscription independently sends a complete authoritative SUMMARY list,
  so a browser that was unsubscribed during a mutation still converges when its
  Worktrees surface becomes visible. It does not fan out live git status; each
  visible row holds `watchWorktree`, whose first plain read coalesces with other
  first viewers instead of forcing a second scan. Test hooks:
  `mainRepoResolveCount`/`clearMainRepoCache`.
- `createWorktree` accepts an optional `baseBranch`. The deferred
  `worktree_set_base` tool can later replace that recorded merge-back and future
  pull-request target. It accepts only an active spawned worktree and an exact
  local branch, records its merge-base with the managed branch as the new
  whole-branch diff pivot, and invalidates status and hosting caches. The
  caller-aware mutation reservation excludes other sessions, while the
  repository lock serializes the ref read and row update with merge and sync
  actions. It refuses self-targeting, unrelated histories and an active merge.
  This is a metadata operation: it does not rebase commits, push, or retarget a
  provider pull request. Its result names and warns about open managed pull
  requests that still carry their provider base.

  Before taking the creation lock, `createWorktree` fire-and-forgets
  `worktreeFetch.ts`'s `fetchRepoIfDue`, reusing its production gate, user
  cadence (zero means off), per-repo coalescing and honest `fetchedAt` stamp;
  creation never awaits network. Under the lock the base still resolves as the
  LOCAL `refs/heads/<name>` and its oid is recorded; remote-tracking refs, tags
  and SHAs are refused because they cannot be merge-back targets. Without an
  explicit base, the main checkout's current branch remains the base (and only
  that default rejects detached HEAD). Its optional `signal` reaches creation
  and submodule Git commands; cancellation during `git worktree add` removes any
  partial checkout and branch while the creation lock is still held; later
  post-lock failures re-acquire that lock for cleanup, leaving no unregistered
  residue.

- `createWorktree` also takes an optional `source`, absent meaning today's
  `new-branch` behaviour byte-for-byte. `track-remote`
  ([Task-246](pa://task/246) 's other half, built for the Pull Requests view's
  review workflow) checks out an EXISTING remote branch: the worktree's own
  branch IS `headBranch` and tracks `<remote>/<headBranch>`, `name` becomes the
  FOLDER suffix alone, and the recorded `baseBranch` is the caller's
  `preferredBaseBranch` where it exists as a local branch, else the main
  checkout's current branch — the merge-back invariant (`worktreeMerge.ts`
  requires the main checkout to be ON that branch) is exactly why a
  remote-tracking ref is never recorded there. The branch is created AT the
  caller's `headCommit` and its upstream configured as a second step, never
  branched off the tracking ref: that ref moves with every fetch — including the
  `fetchRepoIfDue` this same function fires before taking the lock — so
  branching off it would check out a commit the caller never verified, under a
  name saying it is the verified one. The pin is re-verified under the lock (a
  prune or collection can have taken it) and its absence refused. Its refusals
  are a typed `WorktreeCreateRefusalError` with a `kind` (`branch-exists`,
  `head-unreachable`, `base-unresolvable`) so a caller reports them as data
  instead of pattern-matching Git's prose; the FETCH that puts the
  remote-tracking ref in reach is the caller's, outside the repo lock. Its
  folder search is folder-only (the branch is decided) and falls back to a
  timestamp instead of throwing, keeping "naming never blocks creation". Both
  variants add the checkout under one lock acquisition, claim their branch and
  folder immediately before the add, and share the same cleanup paths, so
  atomicity is identical.
- `createWorktree` takes an optional `onSubmodules` callback, fired only when
  the repository actually HAS submodules and only as that checkout starts: it is
  the one network-bound, minutes-long step, so a caller showing progress (the
  first-send provisioning card) can say so instead of leaving "creating…" up for
  the whole clone. The checkout itself stays non-fatal as before.
- `worktreeNaming.ts` owns the no-tool naming agent (suffix = branch name =
  folder suffix) with sanitizing and non-blocking fallbacks. Its context comes
  from `connection.ts`'s one `worktreeNamingContext` helper (caller text + the
  staged Task's title/body, project name as the last resort), shared by the
  dialog's `proposeWorktreeName` and the first-send provisioning path so the two
  cannot name from different evidence. `taskNaming.ts` chooses the Task's first
  linked Jira key as its naming reference, falling back to the internal Task id.
  With a Task staged, code prefixes the generated suffix with the lowercase Jira
  key or `t<taskId>`. It preserves the whole reference inside a 48-character
  Task-worktree name and clips only the descriptive suffix. The `taskIds` edge
  remains the exact relationship; the prefix is for humans and branch matching.
- `worktreeEvents.ts` owns the broadcaster seam; `hub.ts` injects both functions
  so this folder never imports the hub. Two, deliberately: `broadcast` is
  list-level (`worktreeList`, delivered to the connections showing worktrees —
  the `worktrees` `BroadcastTopic`), while `broadcastWorktree(worktreeId, …)`
  carries every PER-WORKTREE stream (status, changes, merge updates, comments)
  to the connections watching THAT worktree. The working-tree tier pushes a full
  changed-file list after each debounced dirty event and once when the tree
  becomes clean; repeat-clean events suppress that redundant empty push. Fanning
  those lists out meant one open worktree view made every connected browser pay.
- `sessionCwd.ts` owns session→cwd resolution: the
  `session —in_worktree→ worktree` edge is the durable source of truth; a
  synthetic `main:<projectId>` edge resolves to the project's main checkout (via
  `mainCheckoutPathForProject`); missing/removed worktrees fall back to the app
  CWD. `sessionWorktreeEdge` distinguishes the two fallbacks that used to look
  alike ([Task-321](pa://task/321)): `none` (no edge — the app CWD is the
  session's home by design) versus `missing` (the edge names a worktree that was
  removed or whose folder is gone, so running there would silently retarget the
  agent at the app's own checkout). `sessionWorktreeMissing` folds in the user's
  acknowledgement (`sessionStore.worktreeMissingAck`, per worktree id) for
  coding personas only and IS the `SessionListItem.worktreeMissing` wire flag;
  non-coding sessions may carry an edge for ownership/presentation without a
  missing-worktree refusal, because they cannot execute against its cwd.
  `acknowledgeMissingSessionWorktree` records the answer for the edge's current
  worktree. `worktreeMissingProbe()` is the list-build form: memoized per
  DISTINCT worktree id so the several-times-a-second session list pays one store
  read plus one `existsSync` per worktree, never per row. The cwd resolvers
  deliberately still fall back, so such a session can be opened and read; it is
  the shared run boundary (`../session/runtimePrompt.ts`, with an up-front check
  in `connection.ts` for the interactive paths) that refuses to RUN it.
- `worktreeStatus.ts` owns live git status (dirty/ahead/behind/merged incl.
  squash detection via `git cherry`), TTL-cached and coalesced, plus
  `branchContainedInBase` — the ancestry-or-no-op-merge containment predicate
  the merge/removal guards share with it. A base branch resolving to no LOCAL
  commit is reported as `baseUnresolved` with `merged: false` (counts that could
  not be taken are never a delivery claim): the ahead/behind rev-list fails
  there, and its 0 must not be read as delivery when removal's containment guard
  is about to refuse on the same ref. It is deliberately a LOCAL claim only: no
  absent ref proves a remote lacks the branch (a narrow refspec, a never-fetched
  or locally deleted tracking ref all look identical), and only
  `baseBranchTarget`'s fetch answers that — so a fetching flow's own refusal,
  never this field, is what establishes containment as unknowable. The probe
  distinguishing a missing base from an unresolvable tip runs only on that error
  path, so a normal scan pays nothing. Each remote-facing field has exactly one
  config context: OWN `upstream` is always resolved inside that worktree —
  porcelain-v2 `branch.upstream`/`branch.ab` on full reads, or a one-branch
  `for-each-ref` on remote patches when the root map is silent — honoring
  `includeIf`, `config.worktree`, and future Git config mechanisms.
  `baseUpstream` comes from one TTL-memoized `git for-each-ref` map evaluated in
  the main checkout's config context. Both projections preserve Git's resolved
  short upstream name alongside the counters, so a client can render an ad-hoc
  remote honestly instead of assuming `origin`. That map also supplies
  best-effort watcher targeting.

  **Accepted limitation — root-visible tracking overrides.** Git can make OWN
  tracking worktree-specific in two ways: (a) with
  `extensions.worktreeConfig=true`,
  `git config --worktree branch.<name>.remote/.merge` writes
  `.git/worktrees/<name>/config.worktree`; or (b) an
  `includeIf "gitdir:<worktree-gitdir>"` in shared `.git/config` OR global
  `~/.gitconfig` points to `branch.<name>.remote`/`.merge`. The include needs no
  extension, and a global include change emits no filesystem event this app can
  observe. When the main-context map is SILENT for the row, the patch tier
  handles both forms with one single-ref `for-each-ref` in that row's directory.
  When worktree context instead OVERRIDES a relationship the root map CAN see, a
  fetch moving only the overriding ref can leave the own-branch counter stale;
  the app does not detect that override. This is accepted, not an oversight: the
  app creates neither form — worktree creation and push/set-upstream write
  shared config, while sparse-checkout may enable the extension but writes only
  `core.*`, never branch tracking. There is NO sound root-observable memo or
  gate for the row-context read: extension probing, private-file checks,
  cached-value tests, and root-map silence/presence proxies all failed because
  the changing input is outside that context.

  `baseUpstream` is absent on synthetic main, whose same relationship is already
  `upstream`, and when the base has no tracking ref (including a configured
  upstream reported as `[gone]`). Known limitation: context-specific base
  tracking from another linked checkout is not visible in the main checkout's
  map; this is omission-on-uncertainty, not fabricated zero counts. A failed map
  read is never cached as an empty relationship answer, so the next ref event
  retries cold instead of going silent. It also owns `changedAt`: a `lastSeen`
  signature map (deliberately outliving the TTL cache, whose ref half mutations
  mark stale and watcher scans replace) carries the previous stamp forward
  whenever nothing meaningful moved, so the field means "when something
  happened" rather than "when we last looked" — `worktreeStatusSignature` is
  exported and tested for exactly which fields count. `baseUpstream` is
  excluded: ambient base drift is one repo-wide fact, not fresh activity on
  every worktree based on that branch. The FIRST observation deliberately
  reports NOTHING (`changedAt` absent) and only records a baseline: that map is
  in-memory, so every restart and deploy re-observes every worktree, and
  stamping `now` there would mark every quiet worktree freshly active on each
  deploy — the same false recency the field exists to remove, arriving on a
  schedule instead of continuously. It stamps `fetchedAt` from
  `worktreeFetch.ts` and is the one place that RECORDS INTEREST in a repo:
  reading a status is the only honest signal that a surface wants these numbers,
  so it is what keeps the remote refs being refreshed. The fetch it may trigger
  is never awaited — the response carries the PREVIOUS stamp and the watcher
  broadcasts a fresh status once new refs land. Full scans populate both the
  working-tree and reference halves; watcher setup subscribes before taking that
  baseline, and a tree event derives dirty/file counts and the parsed
  changed-file list from the same porcelain-v2 status + numstat reads while
  reusing branch/head/ahead/behind/upstream/merged. Mutation invalidation marks
  that ref half stale for plain reads without discarding it from the tree tier;
  only a failed initial baseline falls back to one full recovery scan. Synthetic
  main full reads skip the branch map because they never render `baseUpstream`;
  concurrent spawned-row reads still coalesce to one map.

- `worktreeFetch.ts` owns the background `git fetch --prune`, without which
  every `behind` count is only as current as your last manual pull — making the
  most useful thing the surface can say ("main has 5 commits to pull") the one
  it is least able to say honestly. Three scoping rules: PER REPOSITORY, not per
  worktree (linked worktrees share one object store and one set of
  remote-tracking refs, so a project with eight worktrees costs ONE fetch, keyed
  on `repoLockKey`); only on demand — while a surface has read status recently
  or once when creation asks before its repo lock; and PRODUCTION ONLY via
  `config.ts`'s `BACKGROUND_FETCH_ENABLED` (`ASSISTANT_BACKGROUND_FETCH`, set in
  the prod service's own environment rather than `baseEnv` — previews inherit
  that env AND share this instance's checkouts, so every live preview would
  otherwise fetch the same repos on its own timer). The global Worktrees setting
  controls cadence at runtime (10 minutes by default, capped at one day); zero
  disables background fetching but does not replace the production-only
  environment gate. Due-ness is checked every 15 seconds rather than once per
  configured interval, so cadence does not acquire a second interval of
  scheduler delay. Unwatched interest lives for the greater of 15 minutes or 1.5
  times the cadence, ensuring a longer cadence cannot evict a repo before its
  next fetch. It runs lock-free under the network-bound exception defined in the
  parent `../CLAUDE.md`, which is explicit rather than incidental — and
  `backgroundFetchArgs()` is what earns it: `--no-write-fetch-head` keeps the
  sweep out of `FETCH_HEAD`, which is per-working-tree and which this sweep
  would otherwise write in the MAIN checkout, exactly where a locked
  `pull-rebase` reads it to pick a rebase target. The argv is asserted in
  `worktreeFetch.test.ts` and its effect on a real repository in
  `worktreeSync.test.ts`, because a comment cannot hold that line. Interest is
  asked FRESH on every sweep through `setFetchInterestSource` — a remembered
  "last read a status" timestamp decays under a surface that is open but quiet,
  which is precisely when the numbers go stale unnoticed — and
  `onFetchCompleted` fires after every SUCCESSFUL fetch INCLUDING a no-op one,
  because a fetch that changes nothing writes no refs, so the filesystem watcher
  sees nothing and the `fetchedAt` stamp would otherwise freeze at the last
  fetch that happened to move something. `worktreeWatcher.ts` wires both ends
  and stamps cached statuses without another git scan; actual ref events perform
  the targeted scan. Only a SUCCESSFUL fetch moves the stamp — stamping a
  failure would present stale counts as fresh, which is the one thing this must
  not do.
- `worktreeHosting.ts` owns the worktree bridge to the provider-abstract
  git-hosting seam (`../gitHosting.ts`): GET `hosting` (open PR for the branch —
  never for `main:` ids — plus combined CI status for HEAD, TTL-cached 15s per
  worktree) and POST `create-pr` (branch → baseBranch; rejects `main:`). POST
  `merge-pr` is dispatched here too but IMPLEMENTED in `../pullRequestMerge.ts`,
  the one post-merge projection the chat card also goes through — the method is
  validated at the edge and never defaulted, the remote branch is deleted inside
  the same provider call unless the request carries the explicit
  `deleteBranch: false` opt-out (omitted still means delete), and the card, the
  linked Task's suggestion and this module's TTL cache are all updated from that
  one place so the two surfaces cannot drift. The LOCAL consequences (removing
  the worktree, settling the session) stay with the card, which is where the
  state that justifies them is visible. The session `/pr` workflow deliberately
  does NOT call that row-only endpoint: it resolves
  `hostingProviderForRepo(cwd)` directly so an ordinary unregistered repository
  is supported, while still borrowing a linked row's `baseBranch` when one
  exists. It also resolves the open PR's standing review (a SECOND round trip,
  made only once a PR is known to exist and be open).
  `worktreeHostingStatuses(rows)` is the bulk path behind
  `GET /api/worktrees/hosting` — bounded concurrency over the same per-worktree
  TTL cache, so an open detail page and the list do not double up, and a row
  whose PULL-REQUEST lookup THROWS is omitted rather than returned empty (every
  reader takes absence as unknown and emptiness as "no PR, no CI", so inventing
  the second from a failure would turn an outage into clean-looking rows). The
  other reads are isolated from that one: a failed local-head CI or review read
  leaves only its own field absent, since an ANSWERED pull request must not
  disappear over an unrelated outage — the Pull Requests inventory reads this
  projection to find the merged pull request a checkout is still waiting on.
  Such a payload is answered but not cached, so the failed read is retried.
  `projectPullRequests(rows)` is the sibling list, keyed off each project's MAIN
  checkout — a PR belongs to the REPOSITORY, not to whichever worktree happens
  to exist. It has no HTTP route of its own any more: `pullRequestInventory.ts`
  is its one caller, and it is the OPEN half of that inventory's selection. It
  caches per project on a longer TTL (a PR list changes on human time and this
  is a browse surface, not a state indicator) and omits an unlistable project on
  the same rule. `listWorktreeRows()` in `worktrees.ts` is the input to both:
  the same set as `listWorktreeRecords` but as rows, mains included. Spawned
  rows resolve the branch's derived upstream/push remote (falling back to
  `origin` before one is unambiguous), so their badge observes the same
  repository managed delivery publishes to. No provider match = a provider-less
  payload and the UI shows nothing.
- `tools/workshop/worktreeDeliveryTools.ts` owns agent-facing checked delivery.
  Deferred `worktree_commit` accepts only an active spawned-worktree id plus
  bounded intent context and a `stagedOnly` switch, derives path/branch from the
  row, and composes `runCommitWorkflow` with the caller's session context and no
  force. `stagedOnly` makes the workflow review and commit the index as-is
  (`git diff --cached`, status filtered to index entries, no untracked reads, no
  `git add -A`); the contract is in `docs/pull-requests.md`. Deferred
  `worktree_push` accepts only that id plus `forceWithLease`, requires the
  non-ignored tree/index clean, derives remote and same-named destination, and
  passes exact local branch/HEAD preconditions to `runPushWorkflow`. An ordinary
  first push publishes the exact HEAD oid, then explicitly sets the local
  branch's derived remote/merge tracking config; it reports `setUpstream` only
  after that second step succeeds. Its forced mode requires a matching existing
  upstream, reads the current remote oid with non-interactive `ls-remote`, and
  pushes with `--force-with-lease=refs/heads/<branch>:<oid>`; the provider
  atomically refuses a remote advance. Deferred `worktree_create_pull_request`
  adds only optional exact linked Task, bounded authoring context, and draft
  inputs. It reuses the same local/target checks, requires the authoritative
  remote oid to equal local HEAD, resolves hosting from that remote's push
  repository, and invokes the canonical live PR-card service with caller
  timeline ownership but the trusted target worktree id. Existing PR detail must
  match head/base/SHA; post-create movement keeps the landed card visible with a
  stale warning and partial-success result. Deferred
  `worktree_finish_pull_request` adds only `action` (`merge`/`close`), a merge
  `method`, `deleteRemoteBranch` and a bounded `reason` that is required for a
  close and refused-with-the-merge-fields the other way round. It resolves the
  row's single open pull request, re-reads detail and repository capabilities,
  and closes directly (keeping branch, worktree and Task) or merges: a merge
  repeats the exact local/remote/PR head triangle, re-runs the shared readiness
  read, requires a currently supported method, and only merges a non-default
  base directly — a default base stages one human approval and merges nothing in
  that call. All four tools use the caller-aware reservation in
  `session/sessionRunLease.ts`, which permits the current run on its own target,
  refuses every other current writer, blocks new runs until release, and shares
  removal's hold map. Push and PR provider calls stay outside the repository
  lock across remote I/O. Synthetic main, arbitrary paths/remotes/refs/content,
  partial dirty delivery, raw force, first-push force and caller-supplied lease
  oids are not in the contract.
- `worktreeWrite.ts` owns user-initiated repository writes behind
  `POST /api/worktrees/:id/{commit,auto-commit,clean,push}` (request/response,
  not WS): manual commit stages (`add -A`, or a validated path subset) + commits
  under `withRepoLock`; auto-commit reuses the exact `/commit` safety/message
  workflow without guessing a linked session; clean is deliberately HEAD-scoped
  under `withRepoLock` (`reset --hard HEAD` + `clean -fd`), preserving commits
  and ignored files; push reuses `pushWorkflow.ts` (non-interactive ssh env,
  upstream resolution + first-push `--set-upstream`, `--force-with-lease`) and
  intentionally runs lock-free like `/push`. All mark cached reference state
  stale; the watcher's git-state tier broadcasts resulting status.
- `worktreeSync.ts` owns the direct, no-agent synchronization POST actions:
  `pull-rebase` for every checkout, plus spawned-worktree-only `rebase-main` and
  `fast-forward-main`. `rebase-main` targets the base branch AS THE REMOTE HAS
  IT: it fetches `<remote>/<baseBranch>` (the branch's configured remote, else
  `origin`, else the repository's ONLY one — several remotes with neither
  `origin` nor `branch.<base>.remote` is ambiguity, and it refuses rather than
  rewrite the branch against a history nobody named) and rebases onto that,
  falling back to the local base ref only when the repository has no remote at
  all. It no longer looks at the local main checkout — that checkout is one
  clone among several, so "rebase onto main" meaning "onto whatever this
  machine's main happens to be at" was ambiguous, and the old requirement that
  the main checkout be clean and on its base branch is gone with it.
  `fast-forward-main` keeps its local semantics and is no longer offered in the
  worktree panel (landing a branch on main is merge-back, which names the
  strategy); the worktree inbox's quick action still uses it. `pull-rebase` is
  the app's ONLY update path — the Project page offers no pull, since a working
  copy's branch and dirty state live here — so it also runs
  `git submodule update --init --recursive` (non-interactive env) after the
  rebase, the step `projectProvision.pullProjectRepo` used to own before it was
  deleted. They serialize on the common repo lock, require clean participating
  checkouts on their expected branches, pin mutation targets to oids, and
  restore the original HEAD after any failed/conflicted rebase or ff-only merge
  before reporting the failure. A rebase that stopped on a CONFLICT throws the
  typed `WorktreeSyncConflictError` rather than a plain one, so a caller with
  something better to offer — the `/pr` card hands the conflict to the session's
  agent — need not pattern-match on wording to tell a conflict from a refusal.
  `pull-rebase` also accepts a `WorktreeSyncExpectation` (current HEAD, upstream
  oid, AND the upstream's identity — `branch.<name>.remote` plus `.merge`),
  re-read UNDER the lock and BEFORE any mutation, the symbolic branch and the
  remote/merge pair before the fetch even happens: a caller that decided outside
  the lock — the Pull Requests view's review checkout, which verifies the pull
  request's head, the checkout's ancestry and its upstream with only read
  commands — would otherwise have this operation's OWN reads choose the target,
  landing on an upstream that moved after the check, replaying a commit that
  appeared since, or following an upstream repointed since (the configured
  upstream is ordinary local config, and any two refs at one commit satisfy an
  oid). A mismatch throws the typed `WorktreeSyncPreconditionError`, which that
  caller reports as a RACE rather than as a failed update; callers that pass no
  expectation are unaffected. An expectation whose `head` already EQUALS its
  `upstream` is that caller's "nothing to do": those same guards run, and then
  `up-to-date` is returned without consulting dirt (nothing is being changed)
  and without fetching — so "already up to date" is an answer given under the
  lock rather than asserted from outside it, where a repointed upstream or a
  detached checkout would otherwise pass for one.
- `baseCheckoutRefresh.ts` owns the targeted local consequence of a provider
  merge initiated through `pullRequestMerge.ts`. From the merged spawned row it
  considers only that project's synthetic main plus active DB rows in the same
  repository — never `git worktree list` and never another project. The exact
  remote base target is fetched lock-free through `baseBranchTarget`; for a
  configured remote name that fetch also advances
  `refs/remotes/<remote>/<base>`, keeping behind counters current. A clean
  managed checkout holding the base is revalidated under the repo lock,
  fast-forwarded and followed by recursive submodule setup. If no managed
  checkout holds an existing local base ref, a locked no-force fetch refspec
  fast-forwards it; Git's refusal when an unmanaged worktree has it checked out
  is an outcome, not an exception. An absent ref is not created, and dirty,
  detached or diverged state is never written. It invalidates only the selected
  base/main row and merged worktree status ids. The merge projection catches
  unexpected refresh failures because the provider merge has already landed.
- `worktreeDiff.ts` owns the read surfaces (change lists, per-file diffs as raw
  patches plus text-sized full old/new contents, file contents, log,
  gitignore-aware tree), parameterized by `WorktreeDiffScope`; `worktreeHttp.ts`
  serves them under `/api/worktrees/:id/*`. `getWorktreeFileRaw` serves raw
  bytes with a content type (working tree via `containedRealPath`, or `git show`
  at a ref through `gitExec.gitRawStdout` so binaries survive; 20 MB cap,
  refuse-not-truncate); the `file-raw` verb streams it non-JSON for
  `<img>`/`<iframe>` sources, which authenticate via the token query parameter.
- `worktreeWatcher.ts` owns event-driven change detection (@parcel/watcher): an
  always-on git-state tier per main repo `.git` dir (commit/ref changes → status
  broadcasts + git-state listeners) and a refcounted per-worktree working-tree
  tier while clients watch (`watchWorktree`/`unwatchWorktree`), lingering ten
  minutes after the last viewer, capped at eight live subscriptions, blind to
  git-ignored and submodule paths, and backed by a rescan after every tool call
  of a linked session (`docs/child-processes.md#watching-checkouts`). A
  branch-ref or linked-HEAD event scans only that checkout; a local base-ref
  move targets rows naming it, while a remote move follows each branch's exact
  configured upstream (local and remote names may differ). An unassignable
  packed/global event fails safe to the fleet. A batch containing only
  `refs/remotes/**` reads the shared root map once. Rows whose visible OWN
  upstream moved take the authoritative full tier; other rows patch
  `baseUpstream`. For EVERY root-invisible own branch — genuinely never-pushed
  or context-private, indistinguishably — that patch spends one additional
  `for-each-ref` in the row's directory and refreshes or removes `upstream` from
  the context-correct answer. Missing/stale baselines and symbolic branch/base
  rows still full-scan. The root map is best-effort targeting: an exact
  relationship is authoritative when visible, while absent metadata falls back
  to the old same-name remote-tail heuristic. Context-only differently-named
  tracking can still miss an immediate event unless the row is also targeted
  through its base. The root map is never used to fabricate that row's own
  counter. Thus an ambient base fetch remains one process when all rows have
  root-visible tracking, and costs one extra process per invisible row
  otherwise; invisible never-pushed rows remain on the patch tier rather than
  paying a full scan. Watch registration primes the map once per repo, so a warm
  unrelated remote path still exits with zero git reads; cold/manual discovery
  costs two processes (repo key + map), while first registration totals three
  with its existing per-row HEAD read. A common `.git/config` write always
  re-reads the map: an unchanged relationship costs one process, while changing
  one active row costs about seven including its full scan. Exact main/linked
  `config.worktree` paths are watched unconditionally and full-scan their one
  row; submodule configs remain ignored. Tree writes recompute only working-tree
  fields. `isRelevantGitPath` includes `refs/remotes/` because a FETCH is what
  moves those refs, and a fetch is exactly what changes the upstream counts —
  without it the background fetch would update the refs and nothing would ever
  broadcast the new numbers. That watch set is also the DELIVERY set: every push
  goes through `broadcastWorktree`, addressed to the watchers.
- `worktrees.ts`'s `toRecord` projects an IN-FLIGHT merge phase onto the record
  (`mergeProjection`, from `merge_state_json`, excluding `idle`/`done`) together
  with that merge's own BOUNDED message. The phase is broadcast as an event too,
  but an event only reaches whoever was subscribed when it fired; the record is
  what a reconnecting or newly-subscribing browser reads. The message travels
  because a surface reporting a merge outcome must repeat what the merge SAID
  rather than assert anything about the resulting repository — a failure can
  land after a rebase has already rewritten the branch, or with the base
  checkout's index and tree already moved.
- `worktreeMerge.ts` owns merge-back (squash default / merge / rebase under
  `withRepoLock`), the merger agent (a real workshop session in the conflict
  directory; completion verified on run-state idle via git state),
  `worktreeMergeUpdate` phase broadcasts, and `merge_state_json` persistence
  with boot reconcile. Merged detection is tree-equality
  (`git merge-tree --write-tree`), covering multi-commit squashes.
- Merge invariants: the main checkout must be ON the recorded base branch —
  checked at merge start AND re-checked at conflict-resolution verification (the
  user can switch branches while the agent works); completion oracles per
  strategy: merge = ancestry containment (exact via the merge commit), squash =
  HEAD moved past the `mainHeadAtConflict` snapshot AND the commits since touch
  a recorded conflict path (containment cannot judge combined resolutions; bare
  HEAD movement would accept an abort + unrelated commit), rebase =
  branch-guarded `--ff-only`; an agent aborting the merge yields `failed`, never
  `done`; merge/squash agents run in the MAIN checkout and are NOT linked
  `in_worktree` (the edge would reopen them in the worktree) — their cwd
  persists via the session's own record/header.
- Worktree creation snapshots the base branch/head INSIDE the repo lock, in the
  same acquisition as suffix selection and `worktree add` — `baseCommit` must be
  exactly the commit the worktree forked from.
- Creation is ATOMIC for the caller: between `worktree add` and `insertWorktree`
  the checkout exists with nothing tracking it, so any throw in that window runs
  `discardUntrackedWorktree` (under the repo lock: `worktree remove --force`, or
  `worktree prune` when the folder is already gone, then `branch -D`) before
  rethrowing the ORIGINAL cause. An orphaned add would be invisible in the list,
  never cleaned up, and would hold the branch and folder name — the one-click
  retry on a failed first-send provisioning would then silently land on a `-2`
  suffix. Two throws reach that window, and neither is a git failure: the
  `onSubmodules` callback, and `insertWorktree` — sqlite. Suffix selection
  checks active Git/filesystem occupancy AND every retained worktree path,
  including soft-removed rows, so an ordinary retry never reaches the `path`
  UNIQUE constraint after provisioning. Cleanup never throws, but every step
  logs its own non-zero exit: a failed cleanup leaves the very orphan it exists
  to prevent, and the steps cascade (git refuses `branch -D` while the checkout
  is still registered). The prune is gated on the folder being gone precisely
  because it is repo-global — run unconditionally it would drop the registration
  of any OTHER worktree whose path is merely unreachable, leaving an `active`
  row pointing at a checkout git forgot. Past the insert the worktree is
  tracked, so later failures need no rollback (`registerWorktree` and the list
  broadcast already swallow their own errors).
- Submodules: `git worktree add` writes only the gitlinks, so `createWorktree`
  runs `git submodule update --init --recursive` in the new checkout (skipped
  when there is no `.gitmodules`) before recording the row — otherwise a spawned
  worktree of a submodule-using repo is unbuildable. A linked worktree gets its
  OWN submodule gitdir (`.git/worktrees/<wt>/modules/<name>`), so this is a real
  clone even when the main checkout already has the submodule: it runs OUTSIDE
  the repo lock (see the parent's network-bound exception: this one writes local
  state, and its safety is that the worktree is not yet recorded so nothing else
  can reach it — not per-ref locking) with the non-interactive `REMOTE_ENV`
  (`GIT_TERMINAL_PROMPT=0` + BatchMode ssh) so a credential prompt fails fast. A
  failure is logged, never fatal — the worktree is already added and usable.
  Note how completely `gitOptional` absorbs this: a non-zero exit and an
  execution failure (no git binary, vanished cwd) return as non-zero results, so
  either one is logged. The step therefore throws only out of `onSubmodules`.
- File-content reads go through `containedRealPath` (lexical containment +
  symlink resolution) so repo symlinks cannot read outside the worktree.
- `worktreeComments.ts` owns durable review comments: immutable creation anchors
  (HEAD oid + blob + line/context snapshot), re-anchoring from the anchor via
  `-U0` hunk mapping + rename detection + fuzzy context fallback (orphaned
  threads are kept and can revive), full-sync `worktreeComments` broadcasts, and
  the structured agent-handoff context. Clean roots map from the anchor commit;
  dirty new-side roots map from their written loose-blob snapshot while Git
  retains it; durable quote/context selectors remain the fallback because normal
  object pruning may remove an unreferenced blob (an unresolved blank-line root
  then preserves its prior verdict). Working bytes are containment-checked and
  read before hashing through stdin, so a later symlink swap cannot import an
  outside target into the repository object database. New-session handoffs carry
  the user's editable prompt separately: `connection.ts` creates the selected
  harness/persona/model in the worktree and sends comment context through
  runtime `contextBlock`, so only the clean user instruction enters the durable
  transcript; existing sessions can receive the same optional additional
  instruction. `NewWorktreeCommentAnchor.ref` anchors at an OLDER commit
  (reviewing one of several commits before sign-off): `buildAnchor` snapshots
  lines/blob from `ref:path` (ref validated by `isSafeRef`, resolved to a full
  oid, `dirty=false`), creation immediately re-anchors so `current` maps
  forward, and the ordinary re-anchor pass (generic over `anchorCommit`) keeps
  it tracking; `worktreeDiff.ts` resolves the committed new side of a range
  file-diff to `newOid` so the client can pass exactly that oid back.
  Re-anchoring runs on git-state watcher events and lazily on listing. Comments
  (and the attach-to-session edge) key off the CANONICAL resolved `row.id`, not
  the client-supplied id, so `main:` comments/threads match the `worktreeList`
  id. Agent-facing tools live in `../tools/workshop/worktreeReviewTools.ts`
  (worktree resolved from the calling session's `in_worktree` edge). Besides
  listing/replying/resolving, deferred authoring tools open and close durable
  review sets and create one severity-classified, file:line-anchored finding per
  thread. Comment and set authorship snapshots the session model/thinking level
  at write time. Set rollups derive open/addressed counts from member roots.
  Blind sets make agent listing session-private while any blind set in the round
  remains open; the browser projection is intentionally unfiltered — workflow
  runs publish visible sets from `../workflow/reviewSets.ts` and never a blind
  one. Set creation takes an optional caller-owned id for a publisher whose set
  identity is derived rather than fresh (the workflow one is its step's); an id
  already taken is refused, so a repeated publication cannot open a twin.
  `reviewHandoff.ts` renders the ONE handoff prompt both the browser's comment
  attachment and the workflow fix assignment send: a selection is either
  explicit thread roots or a whole review set, threads are listed at their
  re-anchored current location, and the shared findings-are-claims convention is
  part of that section rather than of either caller. Review comments work on the
  main checkout too (see below), but review sets are refused there because their
  object-bounded lifetime has no synthetic-main analogue. Spawned comments and
  sets are object-bounded and die on removal. Synthetic-main roots capture an
  unambiguous spawned-worktree subject at creation (`merge-in-flight` first,
  otherwise a branch-exclusive anchor commit), and matching threads die when
  that merge finishes or the branch is proven deleted; owner-less roots remain
  sweep-governed. Historical orphan rows are reported (without deletion by
  default) by `../db/sweepWorktreeComments.ts`; only its explicit `--delete`
  mode purges.
- Persistence lives in `../db/worktreeStore.ts` (rows + `in_worktree` edges);
  the SQL schema is `../db/migrations/0006_worktrees.sql`.
  `worktree_comments.worktree_id` carries NO FK (migration
  `0007_worktree_comments_main.sql` dropped it) so comments can be keyed to a
  synthetic `main:<projectId>` id; the `parent_id` reply cascade is kept.
  Migration `0045_worktree_comment_branch_owner.sql` adds the synthetic-main
  root's internal `owner_worktree_id`, diagnostic `owner_branch`, and ownership
  evidence `owner_source`, indexed by stable worktree identity for lifecycle
  purges. Migration `0048_worktree_review_sets.sql` adds review sets and
  nullable comment attribution/severity/membership fields, preserving historical
  rows. Existing rows are intentionally not backfilled.

## Contract notes and rationale

- All mutating git operations against a repo root go through `withRepoLock` from
  `../gitExec.ts`; read-only scans stay lock-free. The network-bound exception
  (submodule setup, pushes, `worktreeFetch.ts`'s remote-ref fetch) is defined in
  the PARENT `../CLAUDE.md` — a child cannot loosen a parent contract, so read
  the rule and its bounds there. Two things that doc spells out and this one
  must not restate loosely: the protected category is the working tree, the
  index, and BRANCH OR TAG refs — `refs/remotes/*` are local refs too, and
  fetch/push are the named remote-tracking exception to a rule about the others,
  not an exemption from ref locking in general. Remote-tracking refs are NOT
  exclusively ours (`git push` writes them too, so the argument is Git's per-ref
  locking plus retry, never ownership), and submodule setup DOES write local
  state — its safety is that it runs against a just-created, not-yet-recorded
  worktree nothing else can address, not per-ref locking.
- The project's main checkout is derived live from project localPaths, never
  stored as a worktree row; it is surfaced as a synthetic `main:<projectId>`
  record via `resolveWorktreeRow`. DB rows are spawned worktrees only,
  soft-removed (`status='removed'`).
- Live git state (dirty, ahead/behind, merged) is computed on demand, never
  persisted.
- Naming must never block creation: every naming failure falls back to a
  timestamp suffix.
- Do not import agent SDKs directly; one-shot runs go through `runOneShot`
  (`../harnesses/oneShot.ts`).

## Verification commands

- Run `pnpm --filter @assistant/server test src/worktrees/worktrees.test.ts` for
  the domain tests (real temp git repos).
- Run `pnpm --filter @assistant/server typecheck` for changes in this subtree.
