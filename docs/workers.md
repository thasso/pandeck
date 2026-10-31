# Workers

Agent sessions run in Workers: separately deployed processes, on the far side of
an isolation boundary from the server, that host the engines and native tools
and reach the server only through the worker protocol. This document is the
agreed design. Phase 1 is under way: "Phases" gives the order it ships in and
"Phase 1 status" what has landed. The terms (Worker, worker protocol, credential
lease, credential gateway, placement, Worker id, isolation boundary, secret
store) are defined in [glossary.md](glossary.md), and the decisions that are
hard to reverse are recorded in [ADR-0001](adr/0001-worker-hosts-the-engine.md),
[ADR-0002](adr/0002-server-runs-under-its-own-account.md),
[ADR-0003](adr/0003-worker-owns-checkout-operations.md) and, proposed,
[ADR-0004](adr/0004-credential-gateway.md).

## Goals

In priority order:

1. **Pandeck's secrets are out of an agent's reach.** Today the engines run
   inside the server process, under the server's account, so an agent can read
   the database, every credential profile, the integration tokens and the auth
   token. A scrubbed environment does not stop a process under the same account
   (`credential-distribution.md`).
2. **The server can be updated while agents keep running.** Today a deploy
   drains running turns for up to an hour and then ends them.
3. **Several Workers, possibly on other machines.** This shapes the protocol
   from the start but ships last.

Stronger isolation of one session from another (bubblewrap, containers,
microVMs) is a later property of how a Worker starts sessions, not part of this
design.

## What runs where

Three services, each with its own lifetime:

- **Worker**, on the Worker's side of the isolation boundary: every session's
  engine (pi's loop, the Claude CLI and its hooks); native tools (shell, files,
  search, Monitor); every checkout operation (git, status, diff, the watcher,
  served files, worktree creation and removal, commit, push); the agent
  processes it starts (background work, stopping them before a removal, the OOM
  score sweep, container residue cleanup); and the full output of native tools.
- **Server**, on the server's side of the boundary: `DATA_DIR` and every store
  in it, app tools (`pa`), approvals, Tasks, the Knowledge Base, one-shot runs,
  credential profile metadata, account routing and login flows, external MCP
  servers, container image pulls, browser tools, desktop port forwarding, and
  the web client and API.
- **Credential gateway**, also on the server's side, on the server's host: the
  live model credentials and their only refresher, every model request any
  engine makes, and the package proxy.

Every session runs on a Worker, including Assistant sessions without native
tools and the Personal Assistant, so every session survives a server restart.
One-shot runs stay on the server. They have no native tools, at most a bounded
allowlist of app tools (task intake's research tools, for example), finish in
seconds, and reach the model through the gateway like everything else.

Helpers that hold Pandeck secrets stay on the server's side: container image
pulls (the registry credential) and external MCP servers (integration
credentials through `trustedEnv`) on the server, the package proxy (real
registry credentials behind placeholder tokens) in the gateway. Agents see the
MCP servers only as tools. A Worker-side MCP server, for one that must read the
Worker's files, is an explicit exception and not the default. A pulled image
reaches a Worker as image bytes the server streams into that Worker's own
container daemon, so private images work with a rootless daemon and the registry
credential never reaches a Worker.

The Knowledge Base, the skills and agent libraries, and the app's own tree are
server repositories by kind: Pandeck data, not checkouts. They stay outside
checkout placement, reachable only through their tools and, for the Knowledge
Base row, the worktree file surfaces. Checkout placement is typed and has no
path rule.

Registering the Knowledge Base folder, or anything inside `DATA_DIR`, as a
project makes it a checkout with checkout rights. Its git and reads run on the
Worker like any project's; nothing refuses or warns.

## Isolation boundary and secrets

The isolation boundary is what keeps Worker processes, and so agents, out of
Pandeck's secrets. It has two implementations: separate OS accounts on a server
host, described here, and separately signed processes with the platform key
store on a single-user desktop ("Bundled desktop mode" below). Nothing outside
these implementations assumes either one.

Every app-managed credential and key lives behind one **secret store** port:
model tokens (read only by the credential gateway), integration OAuth results,
API keys and personal access tokens (GitHub, Atlassian, Brave, Context7 and the
like), device and Worker credentials' server-side halves, the APNs key, the Web
Push VAPID private key and subscription secrets, the package proxy's CA private
key, and the secrets the server's environment file supplies today. `DATA_DIR`
then holds no app-managed secrets, so a copy of it carries none; what users and
agents write into transcripts and attachments is theirs and may contain
anything. On a server host the store is files only the server's account can
read; on a desktop it is the platform key store.

**A secret is stored with the destination it may be sent to**, such as an
integration's origin, and the server never sends a secret to a destination read
from anywhere else. Settings files can then name an origin for display, but
cannot redirect a token.

Two kinds of credential live on the Worker's side on purpose, as named
exceptions. A Worker's own enrollment credential is a Pandeck capability: the
server enforces its scope and revoking it ends it. Under the exclusive-lease
fallback, the Worker also holds a profile's live provider token, and that is
different: the provider knows nothing of placements, so an agent that copies the
token holds the profile's full provider authority outside Pandeck, and ending
the lease does not revoke the copy. Only rotating or revoking the token at the
provider does.

### On a server host

The server and the gateway run under a dedicated account. `DATA_DIR` belongs to
it, mode 0700, and the server refuses to boot when the Worker account can read
`DATA_DIR` or the server's environment file. Moving an existing `DATA_DIR` to
the new account is a runbook step the operator performs once, never an automatic
migration.

The Worker runs under an account the operator chooses. For a personal deployment
the intended default is the human user's own account: agents then use the user's
home, tools and credentials such as SSH keys, and the boundary protects
Pandeck's secrets, not the user's home. A dedicated agent account works too, at
the cost of granting it every repository and push credential explicitly.

**The boundary holds only if the Worker's account has no root-equivalent access
to the server's host.** Membership in a group that reaches a rootful Docker
daemon, or passwordless `sudo`, lets an agent mount `DATA_DIR` and read it as
root. The Worker reports its account's groups and whether it can reach a rootful
daemon or `sudo` without a password, and Settings warns when it can. The
recommended container setup for a Worker account is rootless Docker or Podman;
container residue cleanup then reclaims files through that daemon's user
namespace instead of a rootful `chown`.

### File paths in app tools

App tools run as the server, so an app tool must never open a path an agent
supplies. Every agent-supplied filesystem source resolves on the session's own
Worker, through the checkout port or the Worker's file access, or through a
scoped server-owned door such as attachments or the Knowledge Base. An absolute
path on the server's host is refused. Today several tools read such paths
directly as the server: Confluence attachment upload stages any absolute path as
a session attachment before approval, and `show_files`, the converters and
uploads take host paths too. Phase 3 does not ship until every such tool is
inventoried and moved.

## Checkouts and placement

Every checkout, meaning a Project's base clone and each managed worktree, is
placed on exactly one Worker, and only that Worker runs git or reads files in
it. A worktree is made only from a base clone on the same Worker. A Project may
have base clones on several Workers, each placed separately; until phase 4, each
Project has one.

A session whose working directory is a placed checkout runs on that checkout's
Worker. That covers worktree sessions and sessions working in a base clone, such
as the merge and squash conflict agents, which have no worktree link. Only a
session without a checkout has its own placement, by default the configured
default Worker; there is no load balancing until there is more than one Worker
to balance. Moving a checkout to another Worker is an explicit act, never
automatic.

A Project's local path is per Worker: the registry records one for each Worker
that holds a clone, and the Personal Assistant's working directory is a path on
its default Worker.

## Durable state

The server stays the system of record for everything durable about a session:
the app log, the engine's own record and resume handle, the Claude CLI's native
transcript, pi's session file, and the full output of native tools that the
transcript refers to. The Worker keeps a working copy, streams changes to the
server and rehydrates from the server when it takes a session. Native tool
output is written on the Worker first and uploaded through the same spool; until
the upload is acknowledged, the agent reads it on the Worker, and a reference
never points into `DATA_DIR` from the Worker's side.

What a Worker's disk holds falls in three classes:

- **Replicas and caches**: acknowledged working copies of session state and
  materialized skill bundles. All of it can be rebuilt from the server, which is
  what lets a Worker restart anywhere and later run as an ephemeral container or
  microVM.
- **The spool**: events, record changes and native output the server has not
  acknowledged yet. A planned restart or replacement drains it first. A Worker
  lost while the server is down loses what its spool held; that is the one crash
  loss this design accepts.
- **Checkouts**: persistent storage. Unpushed commits, uncommitted changes and
  ignored local files exist only there, so a checkout's disk needs the care a
  developer's working copy does, and moving a checkout carries them along.

Skills, agent definitions and prompt assets stay server-owned. A session's
frozen skill layout reaches its Worker as a content-addressed bundle, which the
Worker caches by hash and fetches only when missing.

## Worker protocol

A Worker dials the server; the server never dials a Worker and keeps no list of
Worker addresses. The first transport is local, a Unix socket on a server host
whose permissions the host implementation sets, and TCP with TLS comes with
remote Workers.

The protocol is versioned `major.minor`, separately from the app release. Minor
versions add without breaking either side. On a major mismatch the Worker
finishes the sessions it runs on the version it already speaks, takes no new
ones and is replaced.

**The server trusts no Worker request beyond its placements.** An agent runs on
the Worker's side of the boundary, so it can read the Worker's credential,
connect to the socket itself or read the Worker's memory: whatever the Worker
may do, an agent may do. A Worker may act only for sessions and checkouts placed
on it, hold credential leases only for those sessions, and call app tools only
with the authority each session has today. A compromised agent then gains
nothing beyond what its own Worker already runs.

### Protocol in phase 1

What runs today is protocol `1.5` (`1.0` plus the file methods, `1.2`'s path
methods for checkout reads, `1.3`'s `files.readlink` and inspect `mode` for the
workflows' reads, `1.4`'s watch methods for the worktree watcher, and `1.5`'s
lifecycle methods for creating, removing and provisioning checkouts), between
the server and the in-process Worker. The code lives in
`app/server/src/workerProtocol/` (the protocol), `worker/` (the Worker's side,
which imports no server state) and `workers/` (the server's side and placement);
`workerBoundary.test.ts` keeps that split. The protocol stays out of
`app/shared/`: the web client never speaks it.

- **Framing.** A connection is a byte stream of frames: two big-endian `u32`s
  (header length, payload length), a UTF-8 JSON header, then the payload. A
  frame's header is capped at 64 KiB and its payload at 1 MiB, checked on the
  length prefix before anything is buffered. A message is not capped: its
  streams travel as numbered `data` frames before the `request` or `response`
  frame that completes it, so only an executor's own parameters (`maxBuffer`,
  `maxChars`, the caller's input) bound what one moves. Anything malformed, out
  of sequence or over a cap is a protocol error that ends the connection.
- **Lossless payloads.** Byte streams (raw stdout, stdin) travel as bytes. Every
  string an executor produced (stdout, stderr, a truncated patch, an error
  message) travels as UTF-16LE, so it arrives code unit for code unit, lone
  surrogates included; UTF-8 is never used for them.
- **Handshake.** The Worker sends `hello` with its Worker id and version. The
  server answers `welcome` on the same major (a higher minor included) or
  `refused`, and closes. A second connection under a connected Worker id is
  refused. Requests made before the handshake wait for it. Either side may send
  requests; an unknown method gets a typed `unknown_method` error and the
  connection stays open.
- **Transport.** Phase 1 uses an in-process pair of byte endpoints:
  asynchronous, never re-entrant, holding no handle, so an idle pair never keeps
  a process alive. Tests and dev keep it after phase 2. The server dials the
  in-process Worker at boot and again on the first request after a connection
  ended, on a new connection epoch.
- **Placement.** Every checkout method names a
  `CheckoutLocation { workerId, path }`, and a Worker refuses a location naming
  another Worker id. The Worker id is derived until phase 4 (D2): every checkout
  is placed on the default Worker, `local`. A checkout's side is typed
  (`CheckoutSide`, `workers/placement.ts`), and `checkoutGitOn(side)` and
  `checkoutFilesOn(side)` run on it. They are the only way in: every caller
  names the side of what it holds — its row's or its project's main checkout's
  (`checkoutSideOf`), its session's for a path the session supplied
  (`sessionCheckoutSide`), or its pull-request card's
  (`pullRequestCardCheckout`). No path chooses a side.
- **What stays on the server.** The Knowledge Base, the skills and agent
  libraries, and the app's own tree run git through the server-local executor
  family, `serverRepoGit.ts`. The Knowledge Base _row_, browsed or committed as
  a checkout through the worktree file surfaces, runs its checkout git and reads
  on the server by kind: `checkoutSideOf(row)` answers the server for the row's
  id and the default Worker for every other row, never from a path or a setting.
  The modules that can hold that row take their side from it and are pinned
  symbol by symbol in `workerBoundary.test.ts`, so no KB-row request causes or
  joins Worker work. That includes the watcher: the KB row's tree and git-dir
  watches are native subscriptions on the server (`checkoutWatchOn("server")`),
  which a Worker connection end never touches. The KB's document grant is
  server-side by kind, beside session artifacts, and every served call there
  names its side by type. W3c replaced checkout placement's path rule with this
  typed choice, so checkout git and reads read no setting.
- **Served files keep their path rule.** If KB settings cannot be read,
  served-file placement keeps lexical and observed realpath matches for the last
  successfully resolved root from any KB/settings reader and the default KB root
  local. The owning settings module keeps this history; placement has no
  separate cache. One warning logs per failure episode; a successful settings
  read resets it. Readable settings are authoritative again, even if the
  configured root changed. Settings and KB readers still report their original
  errors. On a cold start, an unknown custom root cannot be recognized for a
  served file while settings are unreadable. This residual concerns served files
  only and is accepted only in phase 1, where the Worker shares the server
  process and account. It MUST be closed before the Worker leaves that process.
- **Known limits of the typed side.**
  - A project registered at the KB root is two rows for one repository: the KB
    row on the server and the project on the Worker. Fetch, watch and upstream
    reads run once per side, while both sides share the repository's one
    `withRepoLock` key, so a KB commit and a project commit serialize.
  - The served-file settings warning names served files: "Knowledge Base
    settings unavailable; keeping known/default KB paths local for served
    files."
  - Residuals the ratchet leaves to review: a pinned symbol that starts deriving
    a KB path from its non-path arguments (R1); a side-bound module passing a
    literal server side for a non-KB checkout, which is more local than RD-W3-1
    allows but cannot reach a Worker (R2); path data carried out through
    externally registered callbacks or broadcast payloads (R3); and a future
    KB-kind served source that sets no side and relies on the served path rule
    (R4). W6 removed the string executors, which closed R1's string-API reach;
    the rest of R1 stays with review.
  - Registry `localPaths` warnings still read the server's `node:fs`
    (Task-1153).
  - The `ls` app tool still reads session paths on the server's `node:fs`
    (Task-1174).
  - A session whose cwd is the Knowledge Base runs `/commit`, `/push` and `/pr`
    git on the default Worker, as before W6.
  - `sessionCheckoutSide` ignores its session until phase 4.
  - A card's presence read runs on its recorded side; a Worker failure there
    rejects the provider resolution, mutation key or card match that needed it,
    rather than choosing a root (RD-W3-2).
- **Served files.** `/api/files`, document grants and `show_files` read through
  `servedFileAccess.ts`, which calls the file methods `files.stat`,
  `files.realpath`, `files.open`, `files.read` and `files.close`
  (`workerProtocol/fileMethods.ts`). Each names a Worker id, which a Worker
  refuses when it is not its own, before touching the filesystem or its handle
  table. `files.open` says whether to stat the opened descriptor (grants do,
  `/api/files` does not) and answers either a handle or a failure tagged with
  the phase that failed, `open` or `stat`; a filesystem failure is an answer
  carrying its `code` and message, not a protocol error. Handles are bound to
  the connection that opened them: their reads and closes never reach another
  connection, ids are never reused, an open finishing after its connection ended
  is closed at once, and the Worker closes every handle it still holds before
  its quiescence resolves. On connection end, a native open still awaiting a
  descriptor is orphaned and no longer holds file-handler settlement or the
  sweep. The native call is not cancelled: if it later returns a descriptor,
  that descriptor is closed immediately without a stat or registration on either
  the old or replacement connection. Descriptors already returned, including
  their pending stats and reads, still settle and close before quiescence. A
  caller that gives up during an open on a live connection closes the handle
  when it arrives. Reads are positional and bounded; a stream pulls one chunk of
  at most 1 MiB, one `data` frame, only when its consumer has room. Placement
  keeps a path named inside `DATA_DIR` or the Knowledge Base (as named or as its
  observed real path, with the served-file settings fallback above) on the
  server, which reads it with the same `fileReads.ts`; session artifacts are
  server data by kind, whatever their path. Every other path goes to the default
  Worker as named: the server never resolves a requested path to choose its
  side, since following an agent's symlink there would let the server read for
  the agent what the Worker may not. When the Worker fails, the read fails;
  there is no local fallback.
- **Checkout files.** Checkout surfaces read checkout files only through
  `checkoutFileAccess.ts`. Protocol `1.2` adds three path methods beside W2's:
  `files.exists` answers as `existsSync` does and never a failure;
  `files.inspect` answers an entry's kind with `dev`, `ino`, `size` and
  `mtimeNs` as decimal strings from a `bigint` `stat` or `lstat`, signed as Node
  holds them (only `size` is never negative); and `files.readdir` answers names
  in `readdir` order, each with its own directory type, never followed. Each
  names a Worker id, refused before any filesystem call. The side is the
  checkout's typed side, the same as its git's (the server for the Knowledge
  Base row, else the default Worker), never from the path being read. Errors are
  categorized where their origin is known: a **Worker failure** (no answer: the
  connection ended or was refused, a request refused with any code, an unknown
  Worker id, a malformed answer), which the client brands and is never a
  filesystem answer; a **filesystem failure**, marked only for a failure the
  Worker answered (coded or not), an open's failure outcome, or a local
  primitive's rejection carrying a native string `code` and numeric `errno`; and
  the server's own **verdict**, `Invalid file path.`. Anything else propagates.
  A whole-file read follows production's `readFile` on the pinned Bun: it opens
  without a descriptor stat, applies no size limit, and reads 8 MiB requests
  until one comes back short; a capped read is one request for cap + 1 bytes.
  The file is always closed, and when the read and the close both fail, a Worker
  failure wins, then an unclassified error, then the read's filesystem failure,
  then the close's. The path methods hold no handle and take no cancellation: on
  connection end the caller is rejected once the handler settles, as for
  `files.stat`. Whole-file reads use `files.open` with `stat: false` and keep
  the handle rules above. On the dev and test runtime (Node), this means the
  reader does not stop at a file's opening size and reads files over 2 GiB,
  which Node's own `readFile` refuses. Protocol `1.3` adds `files.readlink`, a
  path method answering a symlink's target text as `readlink` decodes it, with
  the same Worker-id refusal; and an optional `mode` on `files.inspect`'s
  answer, from the same `bigint` stat as a decimal string. An answer without
  `mode` still decodes; only a caller asking for it (the commit fingerprint)
  treats its absence as a malformed answer.

  The worktree surfaces read through it: text, raw and tree reads with their
  containment (`worktreeDiff.ts`), comment working sources
  (`worktreeComments.ts`), status's existence check (`worktreeStatus.ts`) and
  worktree document grants. `repoLockKey`'s identity stat and common-dir
  canonicalization take injected reads (`gitFamily.ts`): `gitExec.ts` passes the
  placed ones, `serverRepoGit.ts` local reads marked by the same rule. Each
  surface maps only a filesystem failure or the verdict, exactly where base
  mapped its errors to a value. A public path that aggregates reads (the comment
  re-anchor pass) carries every other checkout-read error to its result: a
  listing rejects, retention counts the checkout failed and deletes nothing, and
  the pass forgets the HEAD it recorded, so the next listing runs it again.
  Roots written before the failing one stay written and are broadcast. Failures
  of the pass that are not checkout reads (git, the database) keep their old
  handling. Recorded exceptions to "no behavior change", with their limits:
  - **E1, FIFOs in a checkout.** With no writer, the open waits on the Worker,
    not the server thread, and a connection end abandons it; the orphaned open
    holds one threadpool slot until a writer appears (as Task-1181). With a
    writer, the positional read answers `ESPIPE` where base read the piped
    bytes; the surfaces map it as any read failure (empty text,
    `File not found.`, no comment source).
  - **E2, runtimes.** The reader follows the pinned Bun's `readFile`, so on Node
    it no longer stats the descriptor, stops at the opening size or refuses
    files over 2 GiB. Bun's own single internal `fstat` after its first 256 KiB
    is not made, so only a failure of that call could differ. `repoLockKey`'s
    identity stat reads only `ENOENT` as absence, as Bun's
    `statSync(…, {throwIfNoEntry: false})` does, and rejects `ENOTDIR` (a
    checkout path at or below a regular file). Node's base answered that path
    with the path itself, so on Node such a `repoLockKey` now rejects. The
    commit workflow's untracked summaries follow the same reader: on Node, a
    file over 2 GiB, which base refused (`could not read: File size …`), is now
    read whole and summarized as `large file (N bytes)`, as Bun's base does.
  - **E3, a ref anchor's post-insert remap.** A Worker failure there stays best
    effort: the comment is returned with its seeded position, no verdict is
    written for that root, and the cleared HEAD guard makes the next listing
    fail closed while the Worker is down.
  - **RD-W3-7.** Any other error in that remap, which only a programming error
    produces, reports the stored comment and then rejects the add; the row is
    kept, so a retry can create a duplicate comment.

  The checkout workflows read through it too, each placed by the checkout root
  its git runs in: the commit workflow's untracked fingerprint (`inspect` with
  `mode`, then `readlink` for a link) and untracked summaries (`inspect`, then
  `readlink` or a whole-file read), read one path at a time in base's order, and
  its operation-in-progress markers (`commitWorkflow.ts`); the merge, sync and
  rebase-repair sequencer probes (`worktreeMerge.ts`, `worktreeSync.ts`,
  `workflow/rebaseRepair.ts`); triage's operation markers
  (`workflow/operationTriage.ts`); and a by-path remote's existence check
  (`worktreeFetch.ts`). Read order, short circuits and git calls are base's; the
  synchronous findings take the awaited marker answer. The fingerprint maps only
  a filesystem failure (to `unreadable`), the summaries likewise (to
  `could not read: …`); every other site maps nothing, as `existsSync` threw
  nothing. `MERGE_HEAD` is probed as before: a linked worktree's `.git` gitfile
  still reads as no merge (Task-1185). The commit message file stays
  server-written (`commitMessageFile.ts`, which `workerBoundary.test.ts` keeps
  free of checkout imports) and is read by the Worker's git through
  `git commit -F`; phase 3 must settle that (Task-1154). Known limits of this
  move:
  - A Worker failure or an unclassified error at a former `existsSync` site
    rejects the operation instead of answering. In a restore
    (`restoreAfterRebaseFailure`, rebase repair's failed or blocked recovery,
    triage's abort and restore) it skips the rest of the restore and leaves the
    sequencer state to the existing recovery paths, as a Worker failure of the
    restore's own git already does.
  - Outer workflow failure handling (cancellation, boot recovery, a prompt
    failure in `workflow/engine.ts` and `workflow/agentExecutor.ts`) is
    unchanged; nothing promises a successful restoration after any error.
  - `reconcileWorktreeMergesOnBoot` stops at the first row whose probe rejects
    and logs it; later rows keep their phase until the next boot.
  - A rejection of the merge's conflict probe or the rebase's in-progress probe
    ends the merge `failed` with that message; whatever git left in the main
    checkout stays, as after a non-conflict merge failure.
  - The summaries read each untracked file whole into memory, including files
    over 256,000 bytes, to report the exact length, as base did.
  - W2's limit for a stuck path call applies to `files.readlink`.

- **Watches.** The worktree watcher subscribes only through
  `checkoutWatchAccess.ts`: `checkoutWatchOn(side)` makes the native
  subscription on the row's side, so every checkout but the KB row is watched by
  the Worker that runs its git. Its reads (`.gitignore` walks, the git dir's
  `HEAD` files, a checkout's presence) go through `checkoutFilesOn(side)`.
  Protocol `1.4` (`workerProtocol/watchMethods.ts`) adds three methods and
  changes no earlier method's meaning, payload or failure shape:
  - `watch.subscribe` and `watch.unsubscribe` go from the server to the Worker
    and name a Worker id, refused when it is not the Worker's own. The server
    allocates the subscription id, a positive integer never reused on its
    connection, and registers it as pending before sending, so `watch.events`
    that precede the answer reach the callback as a live subscription's do. A
    native failure is an answer carrying only its message (parcel's rejections
    carry no `code`), which the watcher classifies as a filesystem failure.
  - The outcome of `{}`, an answered failure or `unknown_method` is definite.
    Any other Worker failure on a connection still open leaves it uncertain: the
    server keeps the slot and id and sends `watch.unsubscribe` until absence is
    proven (`{}`), and if that fails too it ends the connection and waits for
    the release. An unsubscribe joins a subscribe still in progress.
  - `watch.events` goes from the Worker to the server and is acknowledged. The
    Worker keeps one FIFO of batches per subscription, with parcel's batch
    boundaries, and has at most one delivery in flight per subscription; on
    acknowledgement the next carries the whole queue, so there is no timer.
    Above 20,000 queued paths the queue collapses into one overflow marker,
    which the watcher handles as a bulk batch for a tree and a full rescan for a
    git dir.
  - The Worker's release owner (`worker/watch.ts`) alone holds native
    subscribes, unsubscribes and live subscriptions; handlers settle on abort.
    On a connection end it stops deliveries, unsubscribes everything it holds,
    orphans subscribes in progress (unsubscribing them once they resolve) and
    retries failed unsubscribes at 5 s doubling to 60 s. Its `watchesReleased`
    resolves once it holds nothing. Only then does the server report each live
    subscription lost (`onLost`) and reject pending ones, so the watcher's cap
    of eight tree subscriptions never counts a slot free while a native
    subscription of it may live. The watcher resubscribes on the new connection
    and rescans in full (see `docs/child-processes.md`, "Watching checkouts").
  - Known limits. While the Worker is down no events arrive, and status and
    changes stay at their last broadcast; scans fail and log, and a Worker
    failure is never read as a missing checkout or an empty ignore walk. This
    outage visibility is accepted for phase 1 only; phase 2 revisits it
    (Task-1153). A native unsubscribe that never settles holds its tree's settle
    chain, as before. An orphaned native subscribe or unsubscribe that never
    settles holds its connection's `watchesReleased`, and so delays loss,
    pending rejections and recovery for every watch on that connection (in phase
    1, every checkout watch) until restart; a cleanup unsubscribe joining such a
    subscribe holds that tree's slot. Git and file requests stay independent of
    all of these.

- **Checkout lifecycle (W5).** Creating, removing and provisioning a checkout,
  and the idle view's existence check, run their filesystem and process work on
  the checkout's Worker through `checkoutLifecycleOn(side)` and
  `checkoutFilesOn(side)` (`checkoutLifecycle.ts`, `workers/lifecycleClient.ts`;
  the Worker's side is `worker/lifecycle.ts`). Protocol `1.5`
  (`workerProtocol/lifecycleMethods.ts`) adds seven server-to-Worker methods and
  changes no earlier method's meaning, payload or failure shape:
  - The methods run base code with its production defaults, and no option
    crosses the wire: `lifecycle.mkdir` is a recursive `mkdirSync`;
    `lifecycle.createDir` is the exclusive create below; `lifecycle.scanResidue`
    is `scanTreeResidue` with the default budget and the Worker's own uid;
    `lifecycle.removeTree` runs `removeManagedTree` without options at stage
    `initial` and `removeAfterReclaim` at `afterReclaim`;
    `lifecycle.discardTree` is a failed create's `rmSync` (10 retries 200 ms
    apart, owner access restored on a throw), whose failure is an answer
    (`{failed}`), not a failed request; `lifecycle.removeAll` is a forced
    recursive `rm`; `lifecycle.stopProcesses` is below. A filesystem failure is
    answered with its code and message, as `files.*` answers one.
  - Path domain. A location names a Worker id, refused (`wrong_worker`) before
    any effect, and a non-empty path used as given: a relative path resolves
    against the Worker process's cwd, as `files.*` and base `node:fs` did. The
    four destructive methods also refuse a path that resolves to `/`
    (`invalid_params`), which no production caller can send. Nothing is
    normalized lexically.
  - Quiescence. The handlers hold nothing across requests and ignore
    cancellation: on a connection end each runs to its last deletion or signal
    and settles before the Worker is quiescent, so the caller's rejection, and
    the release of its repo lock, come after it. A stop's SIGKILL is sent, not
    awaited. The client never retries. Every method but `createDir` is
    idempotent on its target, and recovery is the callers' existing row and git
    state.
  - Exclusive create. A creation's checkout folder is made by
    `lifecycle.createDir` on the checkout's Worker: the leading directories as a
    recursive `mkdirSync`, never the attempt's, then `mkdirSync(path)` alone. It
    answers `{dir: "created"}` when that call made the folder, or
    `{dir: "exists"}` when it failed with `EEXIST`, whatever kind of entry is
    there (a directory, empty or not, a file, a dangling link). Any other
    failure, including an `EEXIST` from a leading directory that is a file, is a
    filesystem failure answered with its code and message. Only `created` makes
    the folder the attempt's (`docs/pull-requests.md`): `exists` refuses the
    create with `'<path>' already exists` before any branch is made, and a
    Worker failure rejects with nothing claimed. No naming probe proves a folder
    free; the create's answer does. The repo lock, the claim and git stay on the
    server, and git calls stay git.
  - Placement. A lifecycle side is a spawned row's `checkoutSideOf(row)` or the
    project's main side, `checkoutSideOf({id: mainWorktreeId(projectId)})`, for
    creation and provisioning. `checkoutLifecycleOn("server")` throws, so the
    Knowledge Base row never reaches a lifecycle method. The repo lock stays on
    the server, and so does the reclaim of foreign-owned residue
    (`containerResidue.ts`), which runs between the two removal stages
    (`removeManagedTreeOn`).
  - Stop authority. Only `removeWorktree` stops processes, naming an active
    spawned row's path under the repo lock, after every refusal of the app's
    own. The Worker chooses the processes, relative to its own pid: descendants
    at least two levels down whose cwd, sampled when the scan finds them, is at
    or below the location's realpath, never an ancestor. Before each signal it
    re-checks only pid and start time. From phase 3 the server runs under its
    own account and could not signal agent processes, while the Worker runs as
    the agent account and parents the engines, and the kernel keeps it from
    signalling the server's. In phase 1 the Worker pid is the server's, so the
    candidates are base's (`docs/child-processes.md`, "Stopping what runs in a
    checkout before removal").
  - Failures. A Worker failure in a moved operation rejects: it is never
    residue, a missing folder, `false`, `unavailable`, a free name or "no
    processes", and removal never finalizes a record or forgets presence on one.
    `project_create` keeps a failure's classification through its step texts
    (`carryCheckoutFailure`); one after the remote repository and the project
    exist fails like a clone failure, and `project_registry` `cloneRepo` with
    `confirm` recovers it. An idle row whose existence check fails is `unknown`
    with the existing warning. Two operations continue past one instead:
    - Naming. In both naming searches a candidate whose folder probe fails is
      not free. When no candidate is free and a probe failed, the search
      rethrows that failure before any claim, add or unchecked random-name
      fallback. Naming probes are raw reads and never write presence.
    - A failed create's discard deletes only the folder and branch the attempt
      created, as Task-1228 made it (`docs/pull-requests.md`). It logs each
      step's failure with path and branch (`existence check`, `worktree remove`,
      `directory removal`, `settle check`, `branch delete`, `branch config`) and
      goes on, and prunes only on a proven absence. The owned branch is
      compare-and-deleted without dereferencing, by `update-ref --no-deref -d`
      at its start commit and then its `branch.<name>` config, unless a worktree
      has it checked out. A branch it keeps (not provably created, checked out,
      or moved) is logged with `kept branch <name>:` and the reason.
  - Known limits. During a Worker failure every moved operation fails closed,
    except naming and the discard steps above (E-W5-1). A create that fails
    after the add, whose discard cannot remove the checkout either, leaves an
    orphan logged as `directory remained after bounded cleanup` with path and
    branch; there is no sweep (E-W5-2). A Worker failure after `createDir` made
    the folder leaves it empty and unclaimed, never discarded; naming then
    counts it as taken. Under Node, removal's `<gitdir>/modules` probe rejects a
    non-`ENOENT` failure, as packaged Bun's base did (E-W5-3). Git calls and
    their failure mappings are unchanged, so a Worker failure of git keeps W2's
    mapping: the naming branch probe reads it as a free branch, and submodule
    init, the discard's git steps, the `project_create` HEAD probe,
    `refreshRemovalBase` and the PR view checkout's reads absorb it as before
    (E-W5-4, Task-1227).
  - Base behavior kept, not fixed. In broker mode, a lock-free git read running
    in the checkout is stopped with it (BB-W5-1). A process whose cwd was
    deleted is never a candidate (BB-W5-2). A managed-clone delete neither stops
    processes nor takes the repo lock (BB-W5-3). The discard's retries never
    retry `EACCES` (BB-W5-4). Two that W5 found are fixed by Task-1228 instead.
    A failed add's discard no longer deletes a pre-existing branch or folder
    (BB-W5-5); two residuals stay: the checked-out guard is not atomic with an
    outsider's checkout, and a symref placed at the owned name is removed by
    name only, its target untouched. Creation refuses a relative
    `worktrees.root` before making any folder, so the Worker's cwd and the main
    checkout can no longer name two different folders (BB-W5-6).
  - Phase 2 (Task-1153) fences these handlers like the others and keeps the
    two-level rule relative to the Worker's pid. A relative projects root
    resolves against the Worker's cwd, so a separate Worker must start in the
    server's cwd, or that root must become absolute. Phase 3 (Task-1154) settles
    the reclaim's container run and its uid, and a `projectsRoot` given with
    `~`, which the server expands against its own home.

- **Checkout presence (W3d).** Whether a session's checkout exists is a Worker
  answer (`files.exists`), held in `worktrees/checkoutPresence.ts`. Protocol and
  wire shapes are unchanged.
  - Key universe. One entry per `checkoutSideKey(side)` and path: active spawned
    rows and the main checkout's candidate paths and resolved root, each on its
    registry side. The Knowledge Base row never resolves to a checkout here, so
    it never reaches a Worker; a checkout inside `DATA_DIR` is an ordinary
    checkout and is probed on its Worker.
  - Views read the cache synchronously (`presenceNow`): the session list's
    `worktreeMissing`, session state, the interactive prompt pre-check
    (`guardMissingWorktree`) and the watcher's viewer gate. A read answers the
    last verified answer at once and queues one background probe, at most eight
    running, coalescing onto a queued or running one. Never-verified is
    `unverified`, which is not missing.
  - Notification. A changed answer notifies its key; the hub rebroadcasts the
    list and resends state to resident engines and detached viewers that read
    it, with no further read. A resolved main root answered absent is dropped
    and notifies `main:<projectId>`, so its readers rebuild, which starts the
    candidate rescan; the rescan notifies again when its answer changes.
    Worktree watch events (W4) never answer presence.
  - Acting paths decide from their OWN answer: a Worker check requested after
    the caller started. Two kinds:
    - Run decisions: the run door, provider turns, the recovery continuation and
      host commands (`/commit`, `/push`, `/pr`, `/compact`, queued). They start
      no engine and read no cwd, so they compare no edge; the run lease taken
      before the check keeps the worktree's removal out. The door refuses a DB
      verdict synchronously before its lease and decides presence after lease
      and admission.
    - Constructions: every engine open, rename, fork and creation with an edge.
      Each compares the checked edge in the continuation the check resumed in
      and consumes it with no yield (`withCheckedCheckout`); three consecutive
      changed edges refuse with "the session's worktree changed while opening;
      try again". An explicit creation target is checked once and not compared.
    - Acknowledge records only the edge it checked. The shared resolver
      (`resolveUsableWorktree`, used by creation context, spawn and handoff)
      checks the id it was given.
  - Exemptions, with no Worker call: a session with no edge; a DB verdict
    (removed or inactive row, unknown project); the main checkout's cached "no
    repository" within its 60 s TTL. Run decisions also exempt non-coding
    personas, decided before any contact. A construction with an edge checks
    whatever the persona.
  - Store errors. The run decisions' store reads stay synchronous, apart from
    the awaited Worker check, and keep base's handling: the door, provider
    turns, recovery and the connection's host commands fail open on a store
    error and log it; a queued command's store error throws out of the drain. A
    Worker failure is never a store error.
  - Main candidate. A cold main scans `localPaths` on the Worker in base's
    candidate order (existence, then realpath), then makes one final
    `files.exists` call on the chosen path. False there is `none`
    (`missing-absent`), a Worker failure propagates, and the call adds no
    presence key. A realpath filesystem error on a present folder keeps the
    chosen path. A resolved root is re-checked by presence and dropped when
    absent, after which readers see `unverified` until the rescan answers. "No
    repository" stays cached for 60 s with no Worker request, then rescans;
    project edits and `invalidateMainRepo` forget every key the project read.
  - Stable root (D15). Once a resolve is cached, the synchronous main path is
    its git root, for a nested `localPath` too. A commit moving the stamp and
    TTL expiry leave it unchanged; only a drop or a newer async resolve replaces
    it.
  - Lifecycle. Creating a worktree seeds it present; removal forgets it, and a
    probe answering later writes nothing.
  - Outage. A Worker failure (a coded refusal, a malformed answer, the
    connection ending) is never an answer: views keep the last answer and log
    once, and an acting path rejects with the branded failure. There is no
    filesystem, lexical or app-CWD fallback, and no retry of a main generation.
  - Latency ("own" is one Worker round trip, +RTT, requested by the caller):

    | Caller                                            | Base                                      | After W3d                                                                                       |
    | ------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
    | Session list `worktreeMissing`, session banner    | Stat at each build                        | The first build after a change shows the old answer and probes; the fix follows +RTT +25–250 ms |
    | Cold start, after a project edit                  | Correct in the first payload              | No missing flag until the first probes answer                                                   |
    | Interactive prompt pre-check, watcher viewer gate | Exact                                     | Cache; the door still decides from its own check                                                |
    | Run door, provider turn, recovery, host commands  | Exact                                     | Own, +RTT per coding run start or command                                                       |
    | Engine construction with an edge                  | Exact                                     | Own, +RTT per non-resident open, rename, fork or creation; a cold main adds the final call      |
    | Creation context, spawn, handoff, acknowledge     | Exact                                     | Own, +RTT                                                                                       |
    | Newly created spawned worktree                    | Present at once                           | Present at once (seeded)                                                                        |
    | Main path after a commit or TTL expiry, nested    | Subdirectory until the next async resolve | Root (D15)                                                                                      |
    | Main candidate change                             | Next synchronous call                     | First read shows the old state; corrected after +RTT and the debounce                           |
    | Main "no repository" verdict                      | Cached 60 s                               | Cached 60 s                                                                                     |

  - Known limits. E-W3d-1: the cached rows above are not exact. E-W3d-2: a
    nested `localPath` gets the git root once resolved. E-W3d-3: during a Worker
    outage, coding runs, provider turns and host commands with an edge,
    constructions with an edge, spawns, handoffs and acknowledgements with a
    target, and main-row resolution refuse with the Worker error where base
    failed open or stat locally; flags freeze at the last verified answer
    (Task-1153). E-W3d-4: the +RTT above. E-W3d-5: a construction relinked
    during three consecutive checks refuses with the retryable error above.

- **Executors.** Both families share one implementation (`gitFamily.ts`) over a
  runner that only starts the process: one read fan-out bound of six, one repo
  lock map, one execution counter and one error class. The fan-out bound and the
  counting stay on the server in phase 1.
- **No rejection before quiescence.** The Worker runs git through the spawn
  broker with an exit receipt: the broker answers only once it has seen the
  child's actual exit, and a child still running 2 s after SIGTERM gets SIGKILL.
  When a connection ends, a request the Worker received is rejected only after
  the Worker reports that everything it started has settled, so a caller never
  releases its repo lock beside a running git child. For file methods this means
  handler settlement plus the completed handle sweep, excluding native opens
  orphaned before returning a descriptor as described above. Those uncancellable
  opens retain only their pending native operation and late-close owner, not
  other handles or unrelated requests. A FIFO substituted between stat and open
  can still block that native operation until a writer arrives, as before. Git's
  exit-receipt requirement is unchanged. Processes git itself starts (hooks,
  ssh) are not covered, as they are not when a caller cancels. Watch handlers
  settle on abort, so quiescence never waits for a native watch operation; the
  watch release is separate (`watchesReleased`) and holds no git or file
  request. In-process, the server observes the Worker's quiescence and watch
  release directly; phase 2's plan must replace both with fencing for a Worker
  in another process.
- **Failure and restart: broker death.** A dead broker cannot report its child's
  exit. A request with the exit receipt then answers only once the broker's
  whole process group has exited: signal 0 to the group finds no member (ESRCH),
  or a complete `/proc` scan proves every member has exited. A zombie leader
  alone is not proof: the scan reads its `/proc/<pid>/task` entries and then
  requires a still-dead leader with `num_threads=1`. This final count prevents a
  task born during enumeration from being missed. Unreadable, missing or
  malformed task data fails closed until a later scan or probe. Any other
  uncertain answer, an unreadable `/proc` included, counts as members remaining.
  The guarantee stays the immediate git child's exit; waiting for the group is
  only how a dead broker's child is observed. A group member in uninterruptible
  sleep, including a sibling request's child or a git hook, may therefore hold
  that call, its repo lock and the Worker's quiescence indefinitely. This fails
  closed, like a child in uninterruptible sleep on any cancel, and logs one
  warning at 10 s naming the group and its survivors' process or thread states.
  Synchronous scans start after a 20 ms grace and run at most once per second;
  the warning uses the latest scan under that same limit. There is no release
  deadline. Requests without the receipt fail at once, as before.
- **Decisions kept for phase 1.** Engine transcripts and records keep their
  current write path; streaming them over the protocol comes in phase 2 (D1).
  The Worker id is derived, with no worktree-row column (D2).
  `/api/workers/<id>/files` arrives in phase 4 (D3).

### Enrollment and identity

The operator adds a Worker in Settings, choosing its Worker id, and gets a
one-time, short-lived code. Run as the Worker, the Worker's enroll command
exchanges the code for the Worker's credential, stored in the Worker's config
directory with mode 0600. Revoking a Worker in Settings ends its credential and
every lease it holds. Revocation and server-side scoping are the defense, not
the secrecy of that file.

A Worker id is short and readable, unique, and never changes or gets reused. It
is not the machine's hostname: moving a Worker to new hardware re-enrolls the
same Worker under the same id with a fresh credential. The display name is
separate and free to change.

### Device pairing

Browsers and apps pair the way Workers enroll. A new device gets a one-time
code, shown on a device that is already paired or printed by a server command,
and exchanges it for its own credential: an HttpOnly cookie in a browser, the
Keychain in the macOS app. Each device can be revoked in Settings. There is no
shared auth token, and the served web shell carries none: anything that can
reach the server's port, a Worker on the same host included, gets nothing from
fetching a page.

A cookie is ambient: the browser attaches it to requests that other pages start,
and cookies are not scoped by port. So a cookie-authenticated request, the
WebSocket upgrade included, is accepted only from the exact origins the operator
configured, never from any loopback origin or any port of the server's hostname
as today's origin check allows, and a mutation also carries a CSRF token tied to
the device's session. A malicious page served by an agent's dev server on the
same host, on another port, gets nothing.

## Credentials

Each credential profile has exactly one refresher at a time. An OAuth refresh
usually rotates the refresh token, so a second holder refreshing on its own
would invalidate the first. Today that holds only because every holder shares
one directory on one disk: the Claude CLI refreshes `.credentials.json` under
its `CLAUDE_CONFIG_DIR`, pi refreshes the profile's `auth.json`.

The target is the **credential gateway**. Engines send their model requests to
it with a lease token instead of a credential; the gateway checks the lease and
forwards the request with the real one. It owns the live tokens and is their
only refresher. The server keeps profile metadata, account routing and the login
flows, and hands freshly obtained tokens to the gateway; its own one-shot runs
and usage queries go through the gateway too. Engines hold no refresh token, so
the number of Workers and machines never changes the refresh story, and an agent
can read no model credential at all.

The server pushes leases and revocations to the gateway, which keeps them and
checks lease tokens locally. Model requests therefore keep working while the
server restarts, and a revocation takes effect as soon as the push arrives. A
live account switch ends one lease and grants another inside the gateway.

The gateway runs centrally, on the server's host, as its own long-lived service
on the server's side of the boundary; remote Workers reach it over TLS. A
gateway on every Worker host would put model credentials on each of those
machines. The package proxy lives in the same service, so builds keep working
through server deploys and remote Workers reach registries the same way. Its
public trust material lives outside `DATA_DIR`, where Workers can read it.

The gateway depends on both engines accepting a custom endpoint with a bearer
token on subscription credentials. Phase 3 starts with a spike that tests this.
If it fails, the fallback is **exclusive leases**: one Worker, or the server,
holds a profile at a time, refreshes it and writes the result back; sessions on
that account then run only on its holder, and server one-shots borrow the
holder's current token. In that case the package proxy stays in the server
process, and builds through it fail for the few seconds a server restart takes.

## When the server is down

A running turn keeps going. Native tools never need the server, and model
requests go through the gateway, so most of a coding turn proceeds untouched.
The Worker spools the session's events, record changes and native output durably
until the server acknowledges them. App tool calls and approval hooks wait for
the server for a bound of about ten minutes and then fail as an ordinary tool
error the agent sees.

When the spool reaches its size cap, the Worker holds the turn before its next
model request until the server is back, rather than drop events.

When the server starts, it does not assume that nothing is running. Today's boot
recovery marks every open run interrupted, reconciles background work as lost
and admits new work at once. With Workers, recovery waits until each Worker that
was connected reports what it runs, or until a reconnect deadline passes. Runs
and Worker connections carry epochs, so the server fences a stale Worker's late
reports, deduplicates replayed spool entries, and marks a run interrupted only
when its Worker has said it is gone or never came back.

## When a Worker stops

A Worker restart drains the way the server does today: no new turns, running
turns finish within a bound, then the process exits. Idle sessions do not hold
it up; they reattach to the restarted Worker or to another one, since the server
holds their state.

When a Worker dies or vanishes, its running turns end as interrupted turns
([interrupted-turns.md](interrupted-turns.md)). Sessions without a checkout can
resume on any Worker. Sessions in a checkout wait for their Worker, or for an
explicit move of the checkout.

## Served files

A Worker's files have their own route,
`/api/workers/<worker id>/files/<absolute path>`, and the server streams the
bytes from that Worker. Typed file targets carry the Worker id. The unqualified
`/api/files/<absolute path>`, the form in existing transcripts and documents,
means the default Worker. A separate route needs no reserved names: a Worker id
can never be mistaken for the first segment of a path. Session artifacts and
attachments stay server-side, as [served-files.md](served-files.md) describes.

## Deployment

The Worker and the gateway ship in the same release artifact as the server, each
with its own entry point and its own service unit, and the server never starts
or stops either. A Worker started by the server would share its cgroup and stop
with every deploy. A deploy does not restart Workers or the gateway implicitly:
the operator restarts one on purpose, or when the server reports a major
protocol mismatch. The server no longer needs to drain turns before a restart.
The drain and out-of-memory rules in [deployment.md](deployment.md) move to the
Worker's unit, since that is where the agent processes run.

The development server and the test suite run an in-process Worker over the real
protocol, so there is one code path and no mock transport. Each PR preview runs
its own Worker beside its server and never shares production's.

## What the user sees

Each session shows its Worker. Settings has a Workers page: health, version,
protocol version, sessions, placed checkouts, root-equivalent access warnings,
and revoking enrollment. An offline Worker or a protocol mismatch is a condition
in the app status slot ([messaging.md](messaging.md)).

## Bundled desktop mode

A future mode of the macOS app runs the whole application on the user's machine
instead of connecting to a remote server. iOS stays a thin client, and the
desktop app can still connect to a remote server as it does today. Bundled mode
is a deployment of this design, not a fork: the same three services, the same
protocol, one machine and one user.

With one user there is no second account, so the isolation boundary is built
from what macOS enforces between processes of the same user:

- **Secrets in the Keychain.** The secret store is the Keychain, in an access
  group only the server's and the gateway's signed binaries are entitled to. The
  Worker's binary carries no such entitlement, and neither does anything an
  agent runs.
- **Hardened runtime.** The server and the gateway run with the hardened runtime
  and without debugging entitlements, so another process of the same user cannot
  read their memory.
- **Separate launchd jobs.** The Worker and the gateway are separately signed
  launchd agents the app registers, so they keep running when the app quits or
  updates. The server lives with the app. Stopping the agents entirely is an
  explicit menu action. A Worker's processes must not be attributed to the app
  or inherit any of its permissions; registration alone does not guarantee that,
  so the desktop spike has to show a topology that does.
- **Launch constraints.** The entitled server and gateway binaries may be
  started only by the app and launchd, never by an agent with hostile arguments,
  environment or configuration.
- **The app is the only paired device.** Its credential stays in the Keychain,
  and the webview's session stays in memory, never in WebKit's on-disk storage,
  which agents of the same user can read.

ADR-0003 is what makes this feasible: the server never touches checkouts, so it
needs only its own data, the network and the key store.

**Desktop mode protects secrets, not data.** `DATA_DIR` stays readable and
writable by agents: keeping it out of their reach would rely on App Sandbox
container protection, which is a prompt the user can dismiss and depends on
process attribution and the macOS version. Since `DATA_DIR` holds no app-managed
secrets, what an agent can read there is the user's own sessions and Tasks,
which agents reach through tools anyway.

Because agents can write it, `DATA_DIR` is untrusted input on desktop.
Everything that decides what the trusted side executes or where a secret goes,
such as external MCP launch configurations, helper paths and integration
origins, lives in the secret store or is sealed with a key held there. The rule
that a secret travels only to its stored destination covers the rest.

If the gateway spike fails, desktop mode accepts the exclusive-lease fallback:
the Worker holds the live model token and agents can read it, while integration
secrets stay protected. On one machine with one Worker exclusive leases are the
natural shape anyway.

## Phases

1. **Seams in-process.** A checkout port in front of every module that runs git
   or reads checkouts, and an engine-host interface, served by an in-process
   Worker over the real protocol codec. No behavior change. The isolation
   boundary and the secret store are ports from the start, so nothing in phases
   1–3 assumes "a different account" outside the server-host implementation.
2. **The Worker as its own process and unit, same account.** Turns survive a
   server restart (goal 2). Done when the server's boot recovery waits for
   Worker inventories and fences stale reports, rather than marking live Worker
   runs interrupted.
3. **The server under its own account** (goal 1). Starts with the gateway spike,
   then ships the credential gateway (or exclusive leases), moves every
   app-managed secret behind the secret store with its destination binding in an
   audited migration that removes the old plaintext copies, replaces the shared
   auth token with device pairing (gated on a hostile same-host, different-port
   page test), moves `DATA_DIR`, adds the boot check and the root-equivalent
   access warning, and moves every app tool that opens agent-supplied paths. It
   comes after phase 2 because before it, the server would have nothing to hand
   checkout work to.
4. **Several Workers, then remote Workers** over TCP with TLS, with tunnels for
   the server's loopback features.
5. **Isolation levels** inside a Worker: bubblewrap, containers, microVMs.
6. **Bundled desktop mode**, not scheduled. Starts with the desktop spike under
   "Open questions".

### Phase 1 status

Phase 1 ships as slices; each keeps behavior unchanged.

| Slice  | Change                                                                               | State   |
| ------ | ------------------------------------------------------------------------------------ | ------- |
| W1     | Protocol 1.0, in-process transport and Worker; every checkout git process crosses it | landed  |
| W2     | Served files (`/api/files`, `show_files`) read through the Worker                    | landed  |
| W3a    | Protocol 1.2; worktree surfaces' checkout reads through the Worker (Task-1170)       | landed  |
| W3b    | Workflow checkout reads through the same access, protocol 1.3 (Task-1182)            | landed  |
| W3c    | The KB row's typed server-local side for its git and checkout reads (Task-1183)      | landed  |
| W3d    | Synchronous checkout probes: session cwd and main-repo resolution (Task-1184)        | landed  |
| W4     | Protocol 1.4; the worktree watcher's watches and reads on the Worker (Task-1171)     | landed  |
| W5     | Protocol 1.5; checkout create, removal and provisioning on the Worker (Task-1172)    | landed  |
| W6     | Callers pass their own side; the string-cwd executors and both pin lists are gone    | landed  |
| W7–W10 | The engine host: app tools, approvals and hooks, then pi and Claude sessions         | planned |
| W11    | Isolation boundary and secret store ports                                            | planned |

`workerBoundary.test.ts` asserts that no module of the checkout family imports
`node:fs`, that `gitExec.ts` and `checkoutFileAccess.ts` export no read or
executor without a side, and that only the side derivations and the Worker's own
clients name the default Worker. It also closes the value imports of the modules
that can hold the Knowledge Base row, each external symbol pinned to its
declaration.

## Open questions

- **The gateway spike.** Whether the Claude CLI and pi run on subscription
  credentials through a custom endpoint, how each behaves on a 401 and in a
  long-running process, and whether the provider's terms allow routing the
  operator's own subscription through the operator's own gateway. The answer
  picks between the gateway and exclusive leases.
- **The desktop spike.** Before phase 6: whether a Developer ID build can use a
  Keychain access group without a provisioning profile; whether the hardened
  runtime keeps same-user processes out of the server's and the gateway's
  memory; which launchd registration topology keeps a Worker's processes from
  being attributed to the app; whether launch constraints keep agents from
  starting the entitled binaries; whether the webview session can stay out of
  on-disk storage; and hostile tests that rewrite `DATA_DIR` and launch the
  entitled binaries with hostile arguments and environment.
- **Remote reach for loopback features.** Desktop port forwarding and browser
  tools reach Worker processes over loopback until phase 4 adds tunnels.
