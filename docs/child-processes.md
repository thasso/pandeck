# Child processes

How the server starts other programs without stalling itself, and what it stops
before it deletes a checkout.

## Why the server does not fork itself

libuv starts every child with a plain `fork()`. Fork copies the parent's page
tables and blocks the calling thread until the child has `exec`'d, so its cost
grows with the parent, not with the program being started. Measured on the
production server (1.3 GB resident, ~14 MB of page tables) during a worktree
cleanup: a median of 60 ms per spawn, up to 230 ms, and about 200 git spawns in
13 seconds during which the event loop was never idle — every session load,
WebSocket message and health check waited behind them.

## The spawn broker

`app/server/src/spawnBroker.ts` is one small, long-lived helper process. The
server writes one JSON line per request (program, arguments, cwd, full
environment, optional stdin, output limit) and reads one back; the helper runs
the same `execFile`/`spawn` call the server used to make, so exit codes, error
codes and truncation keep their meaning. Cancelling a request kills its child.
In a process of the production server's size, 60 git calls stalled the event
loop for at most 0.8 ms through the broker, against 266 ms per call forked
directly.

- The broker is `process.execPath -e <script>`: plain JavaScript on Node
  built-ins, so it runs on the packaged Bun in production and on Node in
  development, and the package ships no file for it.
- It starts at boot, after the instance environment is scrubbed, while the
  server is still small: its own start is the last fork of the server.
- Each request carries the caller's environment (`childProcessEnv()`, which adds
  the package proxy's bundle to `process.env`), so later changes to either reach
  children exactly as before (`docs/package-proxy.md`).
- Unavailable broker: requests that never reached it run in-process through the
  same handler; a request the broker accepted and then lost is an execution
  failure, because only the caller may decide to retry a mutation. The broker
  runs in its own process group, and that group is sent SIGKILL before any
  in-flight request is answered, so no child it started keeps writing once a
  caller releases its repo lock. A failed start is retried after a minute.
  `ASSISTANT_SPAWN_BROKER=0` disables it.
- The package's install check runs this under the packaged Bun: the broker's
  executable and process group, a cancel, a broker killed while git's own child
  runs (the whole group dies and the broker restarts), and the in-process
  fallback (`docs/deployment.md#bun-package`). The tests run it on Node. In the
  package, synchronous spawns go through a `child_process` shim, because Bun
  would otherwise start them with the environment from before the boot scrub.
- `gitExec.ts` is the broker's first client and the only one today. Claude
  sessions fork once per run to start the CLI (its tools are the CLI's own
  children); pi runs agent commands in-process and still forks per command.

## Fewer spawns in the first place

- A project's main checkout resolves with ONE `rev-parse` and stays cached while
  its HEAD, the ref HEAD names, `packed-refs` and a reftable stack are unchanged
  (`worktreeResolve.ts`); a project without a repository is retried after a
  minute. Every worktree-list broadcast used to resolve every project with three
  git processes each, every three seconds.
- `repoLockKey` remembers each answered path: a checkout's common git dir does
  not change.
- pi's grep and find tools resolve `rg`/`fd` on every call. Its tools manager
  checks `<agent dir>/bin` with `existsSync` first and otherwise runs
  `spawnSync(name, ["--version"])` to probe PATH, a synchronous fork of the
  whole server: 61–85 ms of blocked event loop per call on production, 62 ms in
  a 1.1 GB test process. At boot, after `verifyRequiredHostTools()`,
  `piSdk/toolBinaries.ts` symlinks the host's `rg` and `fd` (or `fdfind`) from
  PATH into that directory, which brings the lookup down to 0.01 ms with no
  spawn and leaves pi's tools unpatched. pi reads the directory once, when its
  module loads, from the process-wide agent dir (`PI_CODING_AGENT_DIR`, else
  `~/.pi/agent`): per-credential-profile agent dirs never reach it, so one link
  serves every session and every profile added later. Links are only ever
  created, and exclusively: pi's download and an operator write the same names,
  and no rename can compare-and-swap against them, so a writer that lands first
  always wins. An existing entry is never replaced or removed, not even a link
  this app made earlier. A working one already passes pi's check. A broken one
  is logged at boot with the manual fix (`rm` it, and the next start links the
  host binary); until then pi keeps probing, which costs time but not
  correctness. Targets are absolute (a relative PATH entry resolves against the
  boot cwd), and PATH entries that are the bin dir or an alias of it are
  skipped, so a link never points at itself. A binary missing from PATH is
  logged once and left to pi, which probes and then downloads. Running `rg`/`fd`
  still takes one spawn per tool call; this removes only the extra probe.
- A linked worktree's HEAD vanishing with its admin directory is a removal and
  rescans nobody; an unknown linked HEAD whose admin directory exists still
  fails safe to a full rescan.

## Watching checkouts

`worktrees/worktreeWatcher.ts` watches with @parcel/watcher: one always-on
subscription per repository's `.git` dir (commits, ref moves), and a recursive
tree subscription per checkout someone is viewing (edits, rescanned as
`git status`). A tree subscribe crawls the whole checkout on the libuv pool that
file I/O and WebSocket compression share, holds one inotify watch per directory,
and keeps an in-memory tree of every entry it crawled. On production, 47,000
watches were held, most of them in build output, virtualenvs, data directories
and submodules.

- **Only what can change `git status` is watched.** The tree tier ignores `.git`
  plus, at the root, `node_modules`, `dist` and `.DS_Store`. It also ignores
  every directory git ignores and every submodule working tree. The ignored
  directories come from
  `git ls-files --others --ignored --exclude-standard --directory`, confirmed by
  `git check-ignore`: `--directory` also names a directory whose every file
  happens to be ignored (a source folder holding only `__pycache__`), and a new
  source file there would show in status. Such a directory stays watched whole.
  Submodule paths come from `.gitmodules`. A submodule is its own repository,
  and the parent's status sees it through its gitlink, which the git-state tier
  sees move. A user's edit inside a submodule's files is not picked up by the
  watch. It shows at the next tool call, commit or view. The git-state tier
  likewise skips every object store (`objects`, `lfs`, and each submodule's
  under `modules/`), where no ref or HEAD lives. It holds most of that
  directory's watches.
- **Every entry is an explicit PATH, never a glob.** @parcel/watcher matches a
  glob as a regex against every path it crawls. Four `**` globs made four
  concurrent subscribes of a 17,000-directory checkout take 2.96 s and held a
  concurrent `fs.stat` for as long, where explicit paths took 0.34 s. Names that
  its wrapper could read as a glob are skipped, and the list is capped at 500
  entries, shallowest first, because parcel compares each crawled path against
  all of them.
- **The ignore set follows `.gitignore`.** An event batch touching a
  `.gitignore`, or of 1,000 or more events (an install, a build), marks the set
  stale. After the next scan it is derived again, at most every 30 seconds, and
  the tree re-subscribes only if the set changed. A stale set whose refresh is
  throttled, or whose derivation failed, schedules its own next attempt: an
  un-ignored directory sends no event that would ask again. Re-subscribing
  releases the old subscription FIRST and then rescans for the gap, because
  parcel keeps one crawled tree per directory whatever the ignore list. A
  subscription made while the old one lives inherits its crawl and never watches
  a newly un-ignored directory. `.git/info/exclude` and a global excludes file
  are read at subscribe time only. The Bun install check derives this set for a
  repository with a root and a nested ignored directory and subscribes the
  packaged watcher with it.
- **A viewer leaving does not end the watch.** A tree subscription outlives its
  last viewer by ten minutes, so moving between sessions costs no re-crawl.
  Events on an idle subscription schedule no scan: nobody would receive it, and
  the next viewer takes its own fresh read. Parcel frees its heap on
  unsubscribe, but glibc keeps the pages, and each re-subscribe grew resident
  memory further. One 21,000-directory tree used 33 MB after one subscribe and
  75 MB after ten cycles.
- **At most eight tree subscriptions are live.** Viewed trees rank before idle
  ones, then by most recent view, and the top eight SHOULD be watched. Admission
  is separate and strict: every subscription held or being made occupies a slot,
  whatever its watch's state (active, displaced by a newer view and still
  releasing, or retired). A ranked tree subscribes only while fewer than eight
  are held; otherwise it waits, and the re-rank after each successful release
  admits it. A displaced tree's release runs on its own chain, so it starts at
  once and never waits behind the newcomer. An idle tree without a slot is
  dropped. A ninth concurrently viewed tree gets no tree watch: its viewers see
  agent edits (tool-call rescans), commits and ref moves (git-dir rescans), but
  an editor edit only at the next of those or the next view. It gets its slot
  back when it ranks high enough again, and the server logs once each time a
  viewed tree is denied one.
- **A failed subscribe is retried while the tree is viewed**, after 5 s,
  doubling up to 60 s, and stops when nobody views it or the checkout is gone. A
  subscription is dropped only once parcel confirms its release, because a new
  subscription made while the old one lives would inherit its crawl. A watch
  whose demand ended (linger over, no slot, worktree removed) is RETIRED: it
  stays registered, and counts against the cap, until its release succeeds. A
  failed unsubscribe keeps the reference and retries on the same backoff. Only
  that armed timer retries a failed subscribe or release: a re-rank (another
  viewer arriving or leaving) leaves it alone, so churn never hammers a native
  call that keeps failing. A re-view of that path reuses the retiring watch,
  whose serialized chain either keeps the still-live subscription or subscribes
  only after the release completes. So there are never two subscriptions of one
  path. A release that never succeeds keeps its old subscription, and its slot,
  until restart. The first failure is logged, and every tenth after it. A viewed
  tree without a watch is logged once, naming the reason: the cap, or a checkout
  that is gone.
- **Agent edits do not depend on the watch.** Every finished tool call of a
  session linked to a worktree (`subscribeSessionToolCompleted`) schedules that
  worktree's scan while anyone views it. It shares the watch's 400 ms debounce,
  so an edit both see costs one scan. This covers submodule files and trees past
  the cap. There is no polling.

Measured on nine real checkouts on this host (a standalone script, one process
per measurement, native heap in use from `mallinfo2`). The largest are an
Android monorepo with a Gradle build tree and a checkout with OpenCV submodules
and a 14,500-directory tool with data, a virtualenv and `node_modules`:

| All nine subscribed together         |   Before |   After |
| ------------------------------------ | -------: | ------: |
| inotify watches (tree tier)          |   47,326 |   2,535 |
| Subscribe crawl, wall time           | 1,045 ms |   90 ms |
| Native heap in use after subscribe   |  84.6 MB |  5.3 MB |
| Resident growth after subscribe      |  93.4 MB | 12.3 MB |
| Resident growth after 10 more cycles |   233 MB | 15.6 MB |
| inotify watches (git-state tier)     |    1,790 |     824 |

Deriving the ignore set takes 7–23 ms of git per checkout; one `git status` of
the same trees takes 7–60 ms.

## Stopping what runs in a checkout before removal

Under the repo lock, after every refusal of the app's own (dirty tree, unmerged
branch, foreign-owned files, review-comment scope, unpushed submodule work) and
immediately before `git worktree remove`, removal stops what still runs in the
checkout (`worktrees/checkoutProcesses.ts`, `worktreeRemoval.ts`). What can
still refuse afterwards is only git's own check of a tree that changed in the
meantime:

1. Tracked background work of every session linked to the worktree is stopped
   through the background-work supervisor, bounded at three seconds. A live
   session with running work already refuses the removal, so this reaches work
   left behind by settled or archived sessions.
2. Any remaining process whose working directory is inside the checkout gets
   SIGTERM, then SIGKILL after two seconds — only if the server provably started
   it: a descendant at least two levels down. The server's direct children are
   its own harnesses and helpers (an idle Claude session's CLI runs in its
   checkout) and are never signalled, while anything an agent started sits below
   them. Nothing is inferred from sharing the service cgroup: a deliberately
   detached process (`nohup`/`setsid`) whose parent already exited cannot be
   told apart from an app helper and is left alone. A user's shell or editor in
   the same folder is never our descendant. Each process is identified by pid
   AND start time, re-checked before SIGTERM and again before SIGKILL, so a pid
   recycled during the grace is never signalled.

The scan is one `readlink` per process (about 10 ms for a few hundred), so a
removal only waits when something was actually running. Without it, a dev server
left running recreated its cache (`.vite/deps`) in the deleted folder.
