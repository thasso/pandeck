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
[ADR-0003](adr/0003-worker-owns-checkout-operations.md),
[ADR-0004](adr/0004-credential-gateway.md) and
[ADR-0005](adr/0005-gateway-edge-and-vault.md).

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
these implementations assumes either one. The phase-1 ports are
`workers/isolationBoundary.ts` and `secretStore.ts`, each with a same-account
server-host implementation.

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

What runs today is protocol `1.10` (`1.0` plus the file methods, `1.2`'s path
methods for checkout reads, `1.3`'s `files.readlink` and inspect `mode` for the
workflows' reads, `1.4`'s watch methods for the worktree watcher, `1.5`'s
lifecycle methods for creating, removing and provisioning checkouts, `1.6`'s
app-tool methods for interactive sessions' app tools, `1.7`'s session-hook
methods for their permission and hook decisions and output artifacts, and
`1.8`'s engine methods for interactive pi and Claude sessions' engines, and
`1.9`'s background-work and skill methods for pi engines' background work and
frozen skills, and `1.10`'s gateway access on `engine.open`), between the server
and the in-process Worker. The code lives in `app/server/src/workerProtocol/`
(the protocol), `worker/` (the Worker's side, which imports no server state) and
`workers/` (the server's side and placement); `workerBoundary.test.ts` keeps
that split. The protocol stays out of `app/shared/`: the web client never speaks
it.

- **Framing.** A connection is a byte stream of frames: two big-endian `u32`s
  (header length, payload length), a UTF-8 JSON header, then the payload. A
  frame's header is capped at 64 KiB and its payload at 1 MiB, checked on the
  length prefix before anything is buffered. A message is not capped: its
  streams travel as numbered `data` frames before the `request` or `response`
  frame that completes it, so only an executor's own parameters (`maxBuffer`,
  `maxChars`, the caller's input) bound what one moves. Anything malformed, out
  of sequence or over a cap is a protocol error that ends the connection, and so
  is a header this side would encode over the cap. Nothing thrown while handling
  a peer's bytes escapes the connection: it ends that connection only, and an
  error other than a protocol error, which is this side's own defect, is logged
  as well.
- **Lossless payloads.** Byte streams (raw stdout, stdin) travel as bytes. Every
  string an executor produced (stdout, stderr, a truncated patch, an error
  message) travels as UTF-16LE, so it arrives code unit for code unit, lone
  surrogates included; UTF-8 is never used for them.
- **Handshake.** The Worker sends `hello` with its Worker id and version. The
  server answers `welcome` on the same major (a higher minor included) or
  `refused`, and closes. A second connection under a connected Worker id is
  refused. A refusal reason quotes the peer's version or Worker id as JSON, cut
  to its first 128 UTF-16 code units with `…` after the closing quote, so a
  refusal stays small however long the `hello`. Requests made before the
  handshake wait for it. Either side may send requests; an unknown method gets a
  typed `unknown_method` error and the connection stays open.
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
  - The `ls` app tool lists through its session's Worker but expands `~` with
    the server's home (`userHomeDir()`); the in-process Worker shares that
    account, so phase 3 must expand it on the Worker. In a session whose cwd is
    the Knowledge Base, `ls` lists through the default Worker too, as `/commit`
    does.
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
  when it arrives. An open answer that names a valid handle but is otherwise
  malformed (a bad `stat`, or no `stat` when one was asked for) is closed once
  by the client, which then rejects with the malformed answer; an answer naming
  no valid handle rejects the same way, and a handle the Worker did open then
  stays in its table until the connection ends (a known limit). Reads are
  positional and bounded: an answer with more bytes than asked for is a
  malformed answer, fewer is a short read. A stream pulls one chunk of at most 1
  MiB, one `data` frame, only when its consumer has room. Placement keeps a path
  named inside `DATA_DIR` or the Knowledge Base (as named or as its observed
  real path, with the served-file settings fallback above) on the server, which
  reads it with the same `fileReads.ts`; session artifacts are server data by
  kind, whatever their path. Every other path goes to the default Worker as
  named: the server never resolves a requested path to choose its side, since
  following an agent's symlink there would let the server read for the agent
  what the Worker may not. When the Worker fails, the read fails; there is no
  local fallback.
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

- **App tools (W7).** An interactive pi or Claude session's app tools (the
  catalog's `pa` tools) run on the server through the session's Worker. Protocol
  `1.6` (`workerProtocol/appToolMethods.ts`) adds two methods and changes no
  earlier method's meaning, payload or failure shape:
  - `appTools.call` goes from the Worker to the server and names the session,
    the tool, the engine's tool-call id and the arguments, with a call id the
    Worker mints. The server (`workers/appToolHost.ts`) takes the Worker id from
    the connection's admission, never the payload, and refuses a session not
    placed on that Worker (`not_placed`) before any lookup. It then resolves the
    binding the session's harness registered while its engine is live
    (`no_tool_session` without one), which applies that harness's own gate with
    its own text: Claude's unknown and inactive checks, pi's Plan denial (pi
    checks no active set at call time). The answer is the tool's result as JSON;
    a tool's failure is the call's failure, its message as text. Claude calls
    also carry a nonempty `queryEpoch`, captured by the calling engine. Its live
    session requires that epoch and refuses stale, closing, pending-Stop or
    quarantined epochs synchronously before tool execution. pi omits the field.
    This execution-time check also fences MCP calls that passed a native hook
    before Stop but reached the server afterward.
  - `appTools.progress` goes from the server to the Worker with one partial,
    sent only when the engine asked for progress (pi's `onUpdate`, a Claude
    `progressToken`). The Worker hands it to the waiting call synchronously, so
    every partial reaches the engine, in order, before the call's answer.
  - Aborting the engine's signal (pi's, or an MCP `notifications/cancelled`) is
    the protocol's `cancel`, which aborts the tool's `ctx.signal`; the tool's
    own outcome still settles the call.
  - Only catalog app tools cross. pi's `find_tools`, which changes the engine's
    active set inside its execute window, and pi's background `bash` and
    `monitor`, which are native tools, execute in the engine with the gate
    applied there. One-shot runs and task intake execute their tools directly on
    the server.
  - Known limits: a result's `details` reach the engine in their JSON form,
    which is what the transcript already stores; a call whose signal is aborted
    before it is sent is withdrawn without running the tool; a binding closes
    over the live session's objects, which phase 2 replaces when engines leave
    the server process.

- **Session hooks (W8).** An interactive session's permission and hook callbacks
  run with its engine; where one reads the session's live state, writes the
  server's stores or settles the server's bookkeeping, it asks the server
  through the session's Worker. Protocol `1.7`
  (`workerProtocol/sessionHookMethods.ts`) adds five Worker → server methods and
  changes no earlier method's meaning, payload or failure shape:
  - `sessionHooks.canUseTool` answers Claude's permission verdict from the
    session's tool allowlist and live mode, with today's texts (Plan's app-tool
    and native refusals, "Tool X is not enabled for this session."). The engine
    keeps its own input on an allow.
  - `sessionHooks.preToolUse` answers Claude's `PreToolUse` decision: Plan's
    refusal of a mutating native against the live mode first, then the calling
    query epoch's admission fence for every tool, then background admission of
    `Bash` with `run_in_background` and of `Monitor`, with the job's context on
    an admitted launch. Stale, closing, pending-Stop and quarantined epochs
    cannot start tools. Background admission rechecks after its asynchronous
    reservation and releases a refused, unexecuted launch. Stop/task lifecycle
    reconciliation remains available so existing work can finish. Read hooks
    recheck admission after their asynchronous file metadata preparation too.
  - `sessionHooks.stop` and `sessionHooks.postCompact` carry Claude's `Stop`
    tasks and compact summary; each answers `{}` only once the server has run
    the session's reconciliation or recorded the summary, and the hook waits for
    that answer.
  - `sessionHooks.persistOutput` serves both harnesses (Claude's `PostToolUse`,
    pi's `tool_result`): when output is elided, the server writes the full
    output as a session artifact and answers its path and URL. A vendor
    full-output file, named explicitly or in the output text, is streamed from
    the session's Worker (`files.open`), one read piece in memory at a time,
    never read on the server; any failure writes the output text instead.
  - The decoder refuses a session id that is not one artifact-safe path segment
    (empty, `/`, `\`, `.` or `..`) as `invalid_params` before any lookup or
    effect. The server (`workers/sessionHookHost.ts`) then takes the Worker id
    from the connection's admission and refuses a session not placed on that
    Worker (`not_placed`). The four Claude methods apply the binding the session
    registered while live (`no_session_hooks` without one; the newest
    registration serves, and a disposer removes only its own); a binding's error
    reaches the hook with its message. Requests carry the query's epoch key, so
    a late hook from an ended query is attributed to its own epoch.
  - The engine's own policy stays with it and moved with it in W9/W10: the
    `Read` window (a `stat` relative to the engine's cwd), output bounding and
    the artifact notice, and the Bash failure guidance. One-shot runs, the
    standalone `/compact` query (no tools, its own summary capture) and pi's
    background `bash`/`monitor` shadows, whose admission runs inside their own
    `execute`, send no session-hook request.
  - Known limits: a hook whose connection ends mid-request rejects, as a
    throwing hook does today; a binding closes over the live session's objects,
    which phase 2 replaces.

- **pi engine construction (W9b-1).** The Worker's pi engine factory calls the
  opener (W9b-2, below). `openPiEngine(spec, ctx)` (`piSdk/piEngineHost.ts`) is
  the only production code that creates or opens an interactive pi session;
  one-shot runs keep their own (`oneShot.ts`).
  - The `PiEngineOpenSpec` is JSON: the transcript (`new` with its cwd, `open`
    with its file, expected id and checked cwd, `fork` with the parent's file
    and id, pi's entry, the position and the app log's origin entry), the
    account, the model as `{ provider, id }` (resolved in that account's own
    registry), thinking level, the start records, persona options, integration
    gates and compaction window the server resolved (W9c-1, below), the
    Build/Plan mode, and the `staged` and `canonicalize` flags. The answer is a
    `PiEngineHandle` and a JSON `PiEngineOpenInfo` (id, file, cwd, notices).
    `piStore` holds only these; the server keeps its own state (modes, app-tool
    bindings, scope claims, enterprise and ownership checks) and drives the
    engine's tools by command: `setToolMode`, `setIntegrationGates`,
    `commitStaged({ mode, integrationGates })` once an account swap commits,
    `discard` for a refused open, and `submit`'s `userTurnIdleMs`, on which the
    engine prunes cold tool loads before calling pi.
  - The `PiEngineHostContext` is host wiring and never crosses: `childEnv()` is
    the base environment of pi's shell children (foreground `bash` and
    background launches; pi's bin dir is added on top), `appToolExecutor` routes
    the session's app tools, `models` is the model port and `persistOutput`
    stores an elided native result's full output (W9c-1). The Worker's pi
    factory passes its own child env (the isolation boundary's) and its
    `appTools.call`, which waits for the engine's items first (W9b-2).
  - App tools see the transcript only through the handle's
    `toolSessionManager()`. The server's binding keeps the routed call's order,
    gate → `onExecute` → execute: its `onExecute` notes the use on the engine
    (`markToolUsed`), so a Plan denial never counts as a use and a failed run
    still does.
  - The opener reads no server state. Since W9c-2 (below) skills and background
    work reach the server only through the engine's Worker, and its imports are
    pure or the engine's own: `../config.ts`, `../mcp/tool.ts`,
    `../tools/toolPolicy.ts`, `../agents/agentDefinitionPolicy.ts`,
    `../sessionStorage.ts`, `./options.ts`, `./backgroundWorkExecutor.ts`,
    `./sessionOpen.ts`, `./forkOrigin.ts`, `./agentToolAdapter.ts`,
    `./compactionWindow.ts`, `./toolActivation.ts`, `./toolPayloadProbe.ts` and
    `./piEngine.ts`. `harnessBoundary.test.ts` ("the pi engine opener reaches
    only the pinned server modules") pins the list, and its companion pins that
    `./options.ts` and `./backgroundWorkExecutor.ts` import neither the
    supervisor, the background-work store, output capture nor the skill library
    and materializer; a new reach is a plan change.

- **pi engine start resolution (W9c-1).** Everything the server owns that the
  engine reads at open is resolved before the open, into the spec, by
  `resolvePiEngineStart` (`piSdk/piEngineStart.ts`); the engine reads no
  settings, session record or frozen row.
  - Spec fields: `start` (prompt conditions, skill names and agent definition: a
    reopen's stored records, a new session's or fork's computed ones), `persona`
    (the persona's prompt and tool policy), `compactionWindow` (a reopen's
    stored window) and `integrationGates` (the gates at resolution, read last).
  - Freeze after open. A new session or fork freezes exactly its spec's `start`
    under the id the open minted, after a successful open and before `track`. A
    refused open or a failed freeze is undone (`discardRefused`): the id's tool
    groups, the engine and the transcript it created (a fork keeps its parent's
    file) and the skills row.
  - The model port. The opener and a hosted `setModel` resolve models and
    runtimes only through the host context's `PiModelPort` (`runtime`,
    `findForProfile`, `find`), which the composition root wires to `models.ts`.
    It is the seam the credential gateway (phase 2) replaces; no secret crosses
    the wire.
  - Integration gates are a command. The engine's tool activation applies the
    gates it was handed and subscribes to nothing; `piStore` subscribes once and
    sends `setIntegrationGates(current)` to every live engine, each failure
    caught on its own. Open-to-live catch-up: `acquireNew`, the shared open of
    `acquireExisting` (every owner of a deduplicated open waits) and
    `forkSession` compare the spec's gates with the current ones in the
    synchronous span `track` returns in, and await the command when they differ,
    so a flip lands either before the comparison or with the session already
    live. A failed catch-up evicts the session and rethrows. A staged
    replacement is sent nothing; its `commitStaged` carries the gates and mode
    read in the commit's own span.
  - Mirrored tools. pi's `state` item carries the activation's tool state as
    JSON (native-loaded, used, usable and active names, load events, whether
    `find_tools` is present); the definition sizes cross once, in the open's
    snapshot. The handle's `toolLoading()` and `toolExposure()` build from that
    mirror exactly as the engine does, so loaded (native) and active stay apart.
    `piStore` registers the Tools inspector against the handle in `track` and in
    the staged commit, and drops it with the session's app tools; the activation
    registers nothing.
  - No protocol change: the gates command is an `engine.command`, and the tool
    state rides the existing `state` item and snapshot.
  - Known limits: the engine still holds the catalog's tool objects for their
    static fields (JSON tool descriptors are phase-2 packaging); the model port
    is in-process wiring until the credential gateway's pi route (phase 2); the
    tool state is rebuilt for every `state` item.

- **pi engine host (W9b-2).** An interactive pi engine runs on the session's
  Worker, and the server drives it through protocol `1.8`
  (`workerProtocol/engineMethods.ts`), which adds four methods keyed by harness
  and changes no earlier method's meaning, payload or failure shape:
  - `engine.open { engineId, harness, spec }` opens an engine through the
    factory the composition root injected for that harness
    (`startWorker({ engines })`; `worker/` imports no engine folder). It answers
    the engine's JSON info, a snapshot and the `seq` of the last item before the
    answer. The server assigns every engine id, unique in its process, and
    registers it before the request goes out, so items that precede the answer
    are held and applied after the snapshot. A harness without a factory answers
    `unknown_harness`; an id the Worker holds, or is still opening, answers
    `engine_id_taken`. Since `1.10` a leased open also carries
    `gateway { baseUrl, leaseToken }` (see "Credentials"), and an unleased one
    has no `gateway` key. The Worker refuses as `INVALID_PARAMS` a base URL
    other than `http://127.0.0.1:<port>`, a lease token that is not three
    base64url segments or is longer than 1024 characters, and any other key. It
    hands the field to the factory as `host.gateway`. The field belongs to no
    harness; the Claude and pi factories each route their engine through it (see
    "Credentials").
  - `engine.command { engineId, commandId, command, args }` runs one
    harness-defined command. It answers `{ seq, result }`, or, when the engine's
    command failed, `{ seq, failed, code? }` with the message as text; only a
    request the Worker cannot serve (an engine it does not hold: `engine_gone`;
    malformed parameters) fails as a protocol error, without a `seq`. The server
    settles a result or a failure only once it applied every item up to that
    `seq`, so a read after awaiting a command sees its effect. The Worker hands
    each command to its engine in the span that received it, so an engine's
    commands start in arrival order and a long turn holds back none of them.
  - `engine.events { engineId, items }` (Worker → server) carries an engine's
    items, each with a positive, increasing `seq` and a harness-defined `kind`.
    One delivery per engine is in flight; the next follows the server's `{}`,
    sent once the items are applied. A delivery for an engine the connection did
    not open answers `engine_gone`. An engine's app-tool call, and each of
    Claude's four session-hook calls the engine host offers
    (`sessionHooks.canUseTool`, `preToolUse`, `stop`, `postCompact`), waits
    until every item the engine emitted before the call is acknowledged, so the
    server's mirror holds what the engine wrote before the tool or hook runs.
  - `engine.dispose { engineId, discard? }` removes the engine, deleting its
    file with `discard`; an engine still opening is disposed when its factory
    returns.
  - pi's items (`piSdk/piEngineHosted.ts`): `event`, each engine event after the
    engine's own policy; `disposition`, what the engine did with a `submit` or
    `continueFailedTurn`, before pi's first event of it; and `state`, after
    every command, success or failure, before its answer. `event` and `state`
    carry the handle's state when it changed and the transcript entries appended
    since the last item (all of them, `reset`, after the file was replaced). The
    engine reconciles a submit on its own streaming state: it steers exactly
    when it streams, so a steer that found it idle runs as a prompt and reports
    `"started"`, and an idle engine refuses a `steerOnly` steer
    (`steer_not_taken`) without calling pi. A continuation reports `"started"`
    only once its transcript write succeeded.
  - The production `PiEngineHandle` is the server's remote handle
    (`piSdk/remotePiEngine.ts`): every synchronous read answers from the mirror
    the items keep, each item applied before listeners see it, and every command
    is an `engine.command`. `markToolUsed` is sent without waiting, ahead of any
    later command. The model crosses as `{ provider, id }`.
  - Connection end. The Worker disposes every engine it holds, including one
    whose factory returns after the end, which is never registered. The server
    rejects the engines' pending and later commands with `engine_gone` and ends
    their live sessions as an eviction does (`piStore.onEngineLost`): a running
    turn is closed through `closeForTeardown`, the session is not deleted, and
    the next acquisition opens it again on a new connection epoch.
  - Test seams: `nativePiSessionForTests` and `piToolActivationForTests` resolve
    a remote handle to the local handle the in-process Worker hosts for it;
    `syncPiEngineMirrorForTests` brings its mirror up to date after a suite
    wrote to pi natively, through that in-process link only: no engine command
    or protocol method reaches it.
  - Known limits: events cross as JSON, so a tool result's non-JSON `details`
    arrive in JSON form, as for app tools (W7); the transcript is held twice, in
    the engine and in the server's mirror; a `message_update` carries pi's whole
    partial message.

- **pi background work and skills (W9c-2).** A pi engine's background `bash` and
  `monitor` work executes on the engine's Worker, and its frozen skills are
  materialized by the server, both through protocol `1.9`
  (`workerProtocol/backgroundWorkMethods.ts`, `skillMethods.ts`), which adds
  nine methods and changes no earlier method's meaning, payload or failure
  shape. The server keeps admission, the row, Stop and output evidence; the
  Worker's table (`worker/backgroundWork.ts`) knows no harness and runs what an
  engine hands it (`piSdk/backgroundWorkExecutor.ts`).
  - `backgroundWork.admit` (Worker → server) carries the tool's admission and a
    launch key the Worker minted, its runner reserved under that key until the
    answer settles. The server admits through the supervisor (so
    `admitBackgroundWork` stays the only creation path) and, for a new item,
    launches it in the same span: the `host-process` port, registered at the
    first admission, sends `backgroundWork.launch { launchKey, request }` on the
    asking connection. The answer is today's admission outcome (denied with its
    message, or the row's id, state, reuse, intent and launch summary), from
    which the tool builds today's texts.
  - `backgroundWork.stop` and `backgroundWork.stopAll` (server → Worker) go to
    the owner's Worker by placement. They act only on items the table holds for
    the named owner (Stop-all only on the ids it reserved) and answer once each
    item's work is done and its reports have settled, so an item's output
    evidence always precedes its Stop answer. Today's texts answer a launch
    without its reservation and a Stop of an item not held for that owner.
  - Four item reports (Worker → server): `activity`, `rateExceeded`, `output`
    (`{ file }` or `{ writeFailed }`, with the head cap's `originalBytes` and
    `truncated`) and `completed`. One item's reports go out in order, each after
    the previous answer, the first only once its admission was answered, so the
    row is running before any report lands; a failed report is logged and
    dropped. The server copies an output file from the Worker through
    `files.open` (`workers/copyFromWorker.ts`) and captures it there, where the
    artifact store lives; an unreadable file is `output-path-unavailable`.
  - `skills.materialize { names }` (Worker → server) materializes a frozen skill
    set into its content-addressed runtime before every loader reload; the spec
    carries that runtime's `skillsDir`, which the server resolves. A set it
    cannot materialize fails `skills_unavailable` with the materializer's
    message, which option construction surfaces as before.
  - Refusals, before any effect: an admission for a session, or a report for an
    item, not placed on the asking Worker (or not a `host-process` row) fails
    `not_placed`; a malformed request fails `invalid_params`.
  - Connection end. The table stops every held item and drops every reservation;
    their reports are lost with the connection, and the supervisor's deadline
    and Stop paths settle the rows as they do for any unanswered backend.
  - Test seams: `inProcessBackgroundWorkForTests` admits through the current
    in-process Worker; `backgroundWorkCallsServedForTests` and
    `skillMaterializationsServedForTests` count what the server served.
  - Known limits: an in-process transport fault mid-request is not modelled
    beyond the connection's end; a report lost with the connection leaves the
    row to its deadline; output crosses twice (written on the Worker, copied to
    the server).

- **Claude engine host (W10).** A live Claude session's queries run on its
  Worker as `claude-sdk` engines over the same `1.8` methods, with no new method
  or payload shape. One engine is one query epoch: an interactive turn's query
  or a standalone `/compact`. The session stays the server-side driver of its
  turns, records and native transcript (D1); one-shot runs and the usage probe
  keep their server-side queries.
  - `openHostedClaudeQuery` (`claudeSdk/remoteClaudeQuery.ts`) is the only
    opener of a live query. Its spec is `claudeQueryOpenSpec`'s JSON: the
    options, the tool policy, and the child environment as a profile's
    non-secret config directory and the variables the server sets, never a
    credential. The factory (`claudeSdk/claudeEngineHosted.ts`) binds what is
    not JSON: the abort controller, the environment over the Worker's
    `childEnv()`, the permission and hook callbacks over `sessionHooks.*`, and
    the session's `pa` tool server.
  - In phase 1 the factory resolves the session's SDK seam and tool server from
    an in-process binding the session registers by id; an open for a session
    with none fails, and never reaches the real SDK. The tool server stays
    server-built and query-local; each engine binds it to its own
    `appTools.call` with the captured query epoch when it starts, and the ending
    engine releases it. A successor query gets a fresh MCP endpoint, never the
    old CLI's connection.
  - The server awaits the open before it writes any epoch state; a Stop or a
    racing turn that lands meanwhile discards the engine and its temp tree.
  - Commands: `start`, `input` and `inputEnd` (the prompt), `close`, `abort`,
    and each optional query control the open's info names (`interrupt`,
    `setModel`, `getContextUsage`, …); the handle has exactly those controls.
    Items: `message` per SDK message, then `end` or `failed`, and
    `compactSummary` for `/compact`'s captured summary.
  - The engine pulls nothing before `start`, which the handle sends when the
    session first iterates it, so no item precedes the open's answer. Applying
    an item queues it for the session's iterator and never waits for the
    consumer, so the hook and tool ordering above holds from the first item.
  - `close` closes the SDK query at most once and keeps the stream: the session
    sees the query end on its own terminal item, and the engine is disposed once
    every command sent before has its answer. A dispose before the terminal item
    is forced: the prompt ends, then the query closes and aborts.
  - Known limits: the controls are fixed at open; JSON drops `undefined`
    arguments and keys; a command after the engine ended rejects with the
    engine-gone text; a connection end fails the stream with "The Worker
    connection ended."; the seam and the tool server cross in-process, by
    session id, until phase 2 packages them.

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
[ADR-0005](adr/0005-gateway-edge-and-vault.md) makes the gateway a service of
its own, not bound to the server's host, split into an edge and a vault that
meet at one port (`gateway/vaultPort.ts`).

The Task-1321 spike showed both engines running on subscription credentials
through a custom endpoint with a placeholder bearer (ADR-0004), so the gateway
ships in phase 2, on the server's host. Its same-host form:

- Engines reach it over loopback HTTP. One listener serves every upstream,
  selected by path prefix: `/anthropic` for Claude Messages and token counts,
  `/chatgpt` for Codex responses, `/compat` for each OpenAI-compatible account's
  chat completions. A prefix allows only the exact method and path its engine
  sends, with no path normalisation; `/compat` allows only
  `POST <base path>/chat/completions`, under the base path the server pushed for
  the lease's account. A server lease also reaches `/anthropic`'s
  `GET /api/oauth/usage` and `/chatgpt`'s usage routes, which no engine lease
  does: `GET /backend-api/wham/usage`,
  `GET /backend-api/wham/rate-limit-reset-credits` and the irreversible
  `POST /backend-api/wham/rate-limit-reset-credits/consume`.
- A lease token is JWT-shaped,
  `base64url(header).base64url(payload).base64url(secret)`, because pi's
  `openai-codex` provider accepts only a JWT that carries a ChatGPT account id.
  The payload names the lease and a placeholder account, `pandeck-gateway`. The
  32-byte secret is the capability. The gateway keeps only its SHA-256 and
  answers with the lease's own profile binding, so a request never names its
  profile.
- Bytes pass through unchanged. The gateway never decodes a compressed body,
  streams SSE as it arrives and lets a client that stops reading hold the
  upstream back. It replaces only the credential headers, Claude's
  `Authorization`, Codex's `Authorization` and `ChatGPT-Account-Id`, and a
  compatible account's `Authorization` (`Bearer` and its pushed key), and strips
  `Set-Cookie` on the way back. pi talks SSE; the gateway refuses WebSocket
  upgrades.
- `/compat` serves only a live engine or server lease on an OpenAI-compatible
  profile, with that profile's own pushed pair; it refuses a Claude or Codex
  lease, and `/anthropic` and `/chatgpt` refuse a compatible one. It forwards
  over http or https as the pushed base URL says, with the pushed key and never
  a token file. Nothing renews a compatible profile: an upstream 401 on
  `/compat` passes through unchanged.
- A refusal the gateway answers itself (an unknown or revoked lease, a route the
  lease does not cover, a profile that needs a new login, an unreadable
  credential, an unreachable upstream, a `/compat` request while its account has
  no pushed pair, which gets a 503) has the provider's error shape, and its
  message starts with "Pandeck gateway:". The server's error classifier never
  counts a marked message as a dead login (`providerErrors.ts`). An upstream 401
  passes through unchanged and still counts as today until G5c reads the
  gateway's login state ("Renewal" below).
- Remote Workers reach it over TLS from phase 4.

The server drives the gateway over its control channel, **gateway control 1.4**:
the worker protocol's codec and connection framing under a version of its own,
`gateway-control/1.4`, so a Worker and a control peer refuse each other; 1.0 to
1.3 dialers are still admitted, as is any 1.x. Only a control connection grants
a lease, and the gateway binds each lease to a profile from its own registry,
never from the request. Every method is answered once its effect is applied and
saved, and each connection starts with
`control.hello {serverBootId, pid, startTime}`; anything before it is refused.
The server then syncs every profile (`profiles.sync`, later `profiles.upsert`
and `profiles.remove`). A newer connection's hello ends the older one.

- `compat.set {profileId, baseUrl, apiKey}` and `compat.clear {profileId}` (1.4;
  1.2 carried one unnamed pair) carry each OpenAI-compatible account's endpoint
  and key. `compat.set` names a registered compatible profile: an unknown one is
  `unknown_profile`, a login profile `invalid_params`; `compat.clear` of an
  unknown one answers. At boot the server pushes one per compatible account
  after its reconcile and before the link is ready; after each account change it
  sends `profiles.upsert` and then that account's push, on the same request
  queue, so a key rotation, URL edit, rename or disable is followed by its pair.
  A ready account (a base URL and models) gets `compat.set`, a keyless one with
  pi's placeholder key `none`; one that is not ready, such as after a URL edit
  cleared its models, or whose settings cannot be read gets `compat.clear`.
  Disabling keeps the pair: `enabled` is metadata. Deleting the account sends
  only `profiles.remove`, which drops its pair, as a sync that omits it does,
  even when saving fails.
- The gateway holds each pair in memory only, one immutable pair per push, so a
  request keeps the pair it took. Every hello clears them all; a malformed
  `compat.set` (`invalid_params`) clears that account's pair alone, and its
  `/compat` answers 503 until the next push. A failed push is logged by method,
  profile id and error code only, is not retried until the account changes or
  the server restarts, and leaves the link ready.
- A lease has a kind and an owner. An engine lease belongs to
  `{workerId, sessionId}`. It is granted before the engine opens; an open that
  mints its session id (a new or forked pi session) completes the owner with
  `leases.bindSession` once the open answers, and a different id later is a
  conflict. A server lease, for the server's own requests, belongs to one
  `serverBootId`. A machine lease (Task-1424) belongs to one enrolled client:
  the edge grants it itself for that machine's standalone harnesses, discards
  its token and addresses it by id ("Standalone harnesses" under "Client mode").
  Hellos and reconciles leave it alone; it counts as live for renewal.
- The boot rule: a hello revokes every server lease of another boot and leaves
  engine leases alone. A previous boot's engine lease keeps forwarding until
  `leases.reconcileWorker {workerId, live}` revokes that Worker's engine leases
  not in `live`; it never touches another Worker's or a server lease.
- The registry records each profile's provider, name, `enabled` flag and, for a
  Claude or Codex login, its token file path; an OpenAI-compatible profile names
  none. `enabled` revokes nothing: disabling an account takes effect at the
  server's next turn, so the gateway never ends a running turn for it. A machine
  pool skips a disabled account at its next selection. Deleting a profile, by
  `profiles.remove` or a sync that omits it, is the only registry change that
  revokes, and its leases' requests are refused with "the account was removed".
  The other reasons are "the session moved to another account" and "the session
  ended".
- The state lives in the gateway's state directory (0700), in `leases.json`
  (lease id, secret hash, kind, owner, profile, provider, a login's token file
  path, grant and revocation times), `profiles.json` and `machinePins.json`
  (hashes, account ids, tried sets and times), each written whole to a 0600 temp
  file and renamed. None holds a token, a lease token or its secret, and no file
  holds the pushed compatible key or endpoint. A grant or session bind is saved
  before it is answered and undone when saving fails; a revocation takes effect
  at once and stays in force even then. After a failed save, repeating a
  revocation or profile removal saves again even though it changes nothing, so
  it fails again or succeeds with the earlier change saved; a repeated
  revocation keeps its first reason and time. Both files load at start, so a
  gateway restarted with the server down still forwards. An unreadable
  `leases.json` starts empty, refusing every old token; an unreadable
  `profiles.json` starts an empty registry, so grants wait for a sync while
  restored leases keep forwarding on their own binding. A revoked lease is
  forgotten 24 hours after its revocation.

Each profile has one **writer lane**: one writer of its token file at a time. An
item in the lane (a renewal, or a usage child from a later slice) or a login's
hold, in arrival order, each waiting until the one before it has settled,
whether it succeeded or failed. No item runs while the profile is held. Only a
Claude or Codex login profile has a lane: `profiles.loginHold` on a registered
OpenAI-compatible profile answers `unknown_profile` before any lane.

- `profiles.loginHold {profileId, holdId}` waits for the lane, saves the hold
  and only then answers `{held: true}`. A profile that is held already answers
  at once `{held: false, refusal, holdId}`, naming the hold that stands:
  `hold_exists` for the asking boot's own hold, `login_stuck` for a stuck hold,
  a fence hold or another boot's. The same `holdId` again from its boot answers
  `held` (a retry). An acquire whose connection ends or that is cancelled while
  it waits leaves no hold. It is the only method answered after other methods
  that arrived later; every other method still applies in arrival order.
- A hold records its owner (the hello's boot id, pid and start time), a
  30-minute check deadline and, for a Claude login, its writer, the
  `claude auth login` child, named by
  `profiles.loginWriter {holdId, pid, startTime}` from the owning boot only
  (`writer_conflict` for a different one). A pi login writes from its owner
  process.
- A hold ends only on evidence: `profiles.loginRelease {holdId}` from its owning
  boot (`not_hold_owner` from another), or the observed exit of its owner and,
  for a Claude hold, its registered writer. An exit is observed when signal 0
  fails with `ESRCH` or the process's `/proc` start time differs from the
  recorded one; anything uncertain counts as alive. A Claude hold without a
  writer has no exit evidence. Elapsed time, a lost connection, a gateway
  restart, a new boot's sync and a profile's removal are never evidence.
- The gateway rechecks the exits of every hold whose owner is not the current
  connection's boot on each hello, before answering it, and once a minute. So a
  server that restarts during a login, whose new boot says hello with a new boot
  id, releases a pi hold once the old server process is gone and a Claude hold
  once its login child is gone too.
- At the deadline without evidence a hold becomes **login stuck**: it stays
  held, so nothing renews the profile, and evidence still ends it later.
  `profiles.loginForceRelease {holdId}`, from any boot after its hello, is the
  operator's assertion that no login runs and clears any hold.
- The gateway reports each hold that becomes stuck, and each stuck hold that
  ends, to the connection current at the change as
  `profiles.status {profileId, loginStuck, holdId}`, a gateway → server request
  answered `{}`, once the answer that caused it has gone out; a new hello hears
  every stuck hold again. A lost status is only logged.
- Every end of a hold (a release, a force release, or exit evidence at a hello
  or the minute check) re-reads the profile's token file at once, even when
  saving the end fails: a file the login rewrote ends a sticky needs-login, and
  a profile with a live lease whose token is due renews once. A fence ends no
  hold.
- Holds are kept in `holds.json` beside the other files, with the same writer
  rules: an acquire or a writer registration is saved before its answer and
  undone when saving fails; a release, a stuck hold or a fence takes effect at
  once and stays in force even then. A restarted gateway keeps every hold under
  the same rules. An unreadable `holds.json` fences every login profile: until
  the registry is known every acquire answers `login_stuck` and every lane item
  is refused; then each registered login profile gets a stuck **fence hold**,
  owned by no boot and cleared only by force release. A registry of compatible
  profiles alone leaves the fence pending.

The server's link to the gateway (`gatewayLink.ts`) is off in code by default;
the NixOS module turns it on, in socket mode against its own gateway unit
([deployment.md](deployment.md) "Credential gateway unit"). With
`ASSISTANT_GATEWAY=1` and no socket configured it starts the gateway inside the
server process, its model listener on `127.0.0.1:${ASSISTANT_GATEWAY_PORT}`
(8788), its state in `DATA_DIR/gateway/` and control over an in-process pair.
This boot remains one-shot.

With `ASSISTANT_GATEWAY_SOCKET` also set, the server dials that Unix control
socket instead. It never starts or stops the standalone gateway. After a lost
connection it reconnects with backoff from 500 ms to 10 s, using the same server
boot identity. Each attempt syncs a fresh profile snapshot, reconciles `local`
with this boot's live engine lease ids, retries settled login releases and
re-pushes compatible endpoints. Profile changes during an attempt cause another
full sync and push pass, without a pass cap. Ready follows only a pass with an
unchanged generation. Changes while ready keep the ordered delta queue. A bind
lost during disconnection is not replayed; external Workers are not reconciled
here. Each connection starts its credential statuses afresh: the gateway's hello
resends every needs-login, and once the connection is ready account health
re-takes its baseline (`docs/account-routing.md` "Gateway-served accounts").

The standalone entry (`gateway/main.ts`, packaged as `pandeck-gateway`) keeps
the edge and vault in one process. It takes its control socket before opening
state, refuses an answered socket, removes a stale one and sets mode 0600. On
Linux it holds an abstract Unix-socket ownership claim through shutdown,
serializing overlapping starts before probing or removing a stale path. The
claim derives from the canonical socket path, so previews and production do not
collide and symlink path aliases contend. A crash releases the claim in the
kernel; a failed start releases it after closing its control listener. Known
limit: non-Linux socket mode is development-only and retains probe/unlink
without interprocess startup serialization. SIGTERM or SIGINT closes control and
stops accepting model requests, lets active streams finish for up to two
minutes, then destroys remaining sockets. The NixOS module runs it as
`personal-assistant-gateway` and each preview's as `pa-pr-gateway@<n>`; only the
operator restarts them, never a deploy or the server. Switch-off rollback
(`gateway.enable = false`, which sets `ASSISTANT_GATEWAY=0` and removes the
gateway units) and the CLI-compatible credential locks stay until slice 5's
encrypted store migration. Turning only the server's switch off is no rollback:
the still-installed gateway renews the tokens its persisted server leases cover
on its own ([deployment.md](deployment.md) "Credential gateway unit").

- Before it is ready the link says hello as this server boot (16 random bytes,
  the pid and the process start time), syncs every credential profile with its
  token file path (`.credentials.json` in the profile's Claude config directory
  under `DATA_DIR/credential-profiles/`, the default's included; `auth.json` in
  its pi agent directory), and reconciles the in-process Worker with no live
  lease on a new boot: its engines died with the previous process. A reconnect
  retains this boot's live ids. Every profile change is then sent as an upsert
  or a removal, and every request takes one queue, in order.
- **Grant before open.** An engine open on a credential profile (a pi engine, a
  Claude turn or standalone `/compact` of a session with a profile) is granted
  an engine lease before `engine.open` goes out. A grant waits at most 10
  seconds for the link; when the gateway failed to start, its control connection
  ended or it refused, the open fails with "Pandeck's credential gateway isn't
  reachable, so this session can't start a model request. It restarts
  automatically; try again shortly." and no engine starts. That text never
  counts as a dead login.
- The engine's first end revokes its lease once, with "the session ended": its
  disposal, its connection's end, or a failure before the open returns. An
  account switch ends the old engine's lease with the old engine and grants the
  replacement its own; a refused replacement's disposal revokes that one.
- Binding a session and revoking are best-effort and only logged. A revocation
  the gateway applied but could not save holds in its memory until a later save
  or the next boot's reconcile.
- **Login holds.** With the switch on, both login flows hold their profile
  through `loginHolds.ts`. Only an account whose kind holds a login
  (`ACCOUNT_KINDS[kind].credential` is `login`) takes a hold or shows the
  login-stuck state; an OpenAI-compatible account never does. The link mints a
  hold id and `acquireLoginHold` waits for ready (10 seconds) and for the lane;
  a hold waiting for the lane is ordered after the queue but holds up no grant,
  profile change or other request. `registerLoginWriter` sends the writer's pid
  and start time, `releaseLoginHold` is best-effort and replayed before ready
  after a socket reconnect unless the hold is already absent, and the link
  records each profile's latest `profiles.status` for the login-stuck state. An
  acquisition whose answer fails also releases its minted id through that replay
  path: the caller never received the hold, so no login writer started. This
  does not release any successfully returned hold on disconnection.
  - **Order.** The Claude login (`claudeLoginTerminal.ts`) takes the hold before
    it spawns `claude auth login`, and names the child as the hold's writer
    right after the spawn. It forwards no input until the gateway acknowledged
    the writer: earlier input is held in order, up to 64,000 characters (more is
    dropped), and a stop discards it, so a late acknowledgement sends nothing. A
    second viewer attaches to the running login. Pasted callback URLs are
    converted locally to the CLI's `code#state` input without logging or echoing
    either form; the gateway's shared Claude driver applies the same conversion.
    A zero exit succeeds only with a saved subscription login: file presence, or
    in direct local macOS mode the official CLI's non-secret profile-scoped
    Keychain status (`docs/account-routing.md`, "Health and login evidence").
    This does not export Keychain tokens or change gateway readiness. The pi
    login takes the hold before it creates its runtime and starts the
    device-code login.
  - **Release** comes only once the writer ended: the Claude child's `close`, or
    pi's provider login settling, never on pi's UI timeout or a cancel.
  - **Stopping a pi login** (`piSdk/models.ts`). Before its commit, Cancel, the
    10-minute UI timeout and the profile's deletion each record a stop reason,
    the first one winning, and abort pi's device-code login through its
    `AbortSignal`; only deletion invalidates the operation. The commit wins:
    once the login attested its own credential, or pi's login resolved, a later
    cancel or timeout records nothing and aborts nothing, and the outcome is
    ready even if pi rejects afterwards. A login that commits right after an
    abort is ready too. At settle, uncommitted: a cancel clears the login state,
    a timeout sets its text as the account's error, a deletion ends cancelled,
    and anything else sets pi's error. The login dialog hears the outcome only
    after the release, the file cleanup and the operation leaving its map, so a
    new login can start then. An abort before the commit leaves the account's
    credential as it was; a committed login is never rolled back.
  - **Stopping a Claude login.** A timeout, cancel, server stop, failed writer
    registration or input error sends SIGTERM, then SIGKILL after 5 seconds;
    deleting the profile or Clear sends SIGKILL at once. The run ends, and
    releases, on the child's `close`; a spawn without a pid releases at once. A
    stop after the `close`, while the Keychain check still runs, ends the run at
    once with its own outcome; the check's evidence still reaches the account.
    When the server process exits, every unclosed child gets SIGKILL. The same
    stop path runs with the switch off, without a hold: the texts are unchanged,
    but a stopped login reports its end only on `close`.
  - **Cancel is run-scoped.** The login dialog's socket
    (`accountLoginSocket.ts`) gives every login run an opaque `runId` on its
    snapshot and statuses, and each dialog's `start` sends an opaque
    `startToken` (at most 64 characters) that the run it creates keeps and
    echoes in its snapshots. A Cancel is sent only for a run that dialog started
    or joined: the run it saw, or, if pressed before any snapshot, the start
    socket's own run, or after a reconnect the run carrying its `startToken`. It
    is repeated after a reconnect only while that same run is still connecting,
    and dropped unsent for any other or finished run; the server ignores a
    cancel naming another run. So a Cancel never ends a login of the same
    account that the dialog neither started nor joined. An early Cancel that
    cannot be proven to be for the shown run is never sent: if that run is still
    running (a start that joined another's login and lost its first snapshot),
    the dialog shows "Cancel not confirmed. Press Cancel again to stop this
    login." and keeps Cancel enabled; pressing it cancels the shown run. A
    finished run needs nothing, and the notice clears when the run ends or the
    dialog closes.
  - **Refusals** map to existing texts only. A `login_stuck` refusal naming its
    hold marks the account login-stuck, and the login starts nothing.
    `hold_exists`, a `login_stuck` refusal without a hold, and a link that is
    not ready, has ended or gets any other failure answer "Pandeck can't start
    this login while the credential gateway is unreachable; try again shortly."
  - **Login stuck.** An account is login-stuck while the gateway's latest
    `profiles.status` says so, or after a `login_stuck` refusal until a status
    ends that hold, a Clear, a held acquire or the profile's deletion. Its
    summary carries `loginStuck: true`, each change broadcasts
    `accountHealthChanged` once, and Settings → Accounts shows U7's text ("The
    last login for `<name>` didn't finish, so Pandeck has paused renewing this
    account's token. If no login is still running, choose Clear the unfinished
    login.") with "Clear the unfinished login" in place of Connect. A login
    started on it leaves no login state on the account, so the account's text
    ends with the flag; the login dialog shows the text too.
  - **Clear** (`POST /api/credential-profiles/<id>/login/clear`, answering
    `{ok: true}` or a 400 `{error}`) is the operator's assertion that no login
    runs. With no stuck hold, or with the switch off, it does nothing. A hold
    whose login this server runs is never force-released: a Claude login is
    stopped with SIGKILL and releases on `close`, and a pi login refuses with
    its own "OpenAI device-code login timed out. The active login will finish
    before another can start." Any other hold is force-released (`unknown_hold`
    counts as done). A failure answers the unreachable text above.
  - **Known limits.**
    - A pi login whose provider never settles keeps its hold: Clear refuses it
      while this server runs it, and a restart ends it. Its abort on Cancel or
      the timeout normally ends it.
    - A `claude` wrapper named by `ASSISTANT_CLAUDE_CLI_BIN` that does not
      `exec` registers the wrapper's pid.
    - A `login_stuck` refusal for another boot's hold that later ends by
      evidence leaves the account login-stuck until Clear or another login.
    - Deletion's SIGKILL precedes the removal of the profile's files without
      waiting for `close`.
    - With a failed in-process link, every login refuses with the unreachable
      text until the server restarts.
    - A login that ends a sticky needs-login is renewed once at once, though its
      token is fresh.
    - A failed Clear reuses the unreachable text.
    - Input past the 64,000 characters held before the acknowledgement is
      dropped.
    - Whether the CLI's own login save takes the refresh lock is not
      established; the save is atomic and 0600 without the compare-and-swap. The
      hold keeps the gateway from racing it; a terminal CLI on the same
      directory is outside Pandeck (One refresher).
    - A `browser` setting in the CLI's own config, or another callback path,
      could let a login complete without the pasted code: the flow pins
      `BROWSER=false`, but what the CLI's opener reads first is not determined.
      Renewal stays fenced by the hold; an owner that dies before naming its
      writer leaves the hold stuck until Clear. The Claude engine contract runs
      the real login offline with no input: only `BROWSER`'s value gets the
      login URL, no localhost callback is printed, a `browser` key in
      `settings.json` or `.claude.json` changes neither, and SIGTERM ends it.
- **Claude engines use the lease.** The grant answers the lease token, and the
  open sends it with the gateway's URL as `engine.open`'s `gateway`. A link with
  no running gateway refuses the open before any grant. The Claude factory
  builds the CLI's environment from the profile's scrub, then the session's
  variables and the output budget, then, last, `ANTHROPIC_BASE_URL` (the
  gateway's `/anthropic` prefix), `CLAUDE_CODE_OAUTH_TOKEN` (the lease token)
  and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, so nothing before them
  overrides them. A gateway engine without a profile's scrub is refused.
- **Profile-less sessions run as `claude-default`** (U12). A Claude session
  without a profile, for a turn or a standalone `/compact`, gets the default
  profile's runtime, gateway on or off: its scrub and its `CLAUDE_CONFIG_DIR`
  under `DATA_DIR/credential-profiles/claude-default/claude`, where the store
  reads its transcripts. With the switch on it also leases `claude-default`. Its
  `credentialProfileId`, records, auth mode and account routing are unchanged.
  An install without `claude-default` (every fresh one) refuses such a session
  before any child starts (`docs/account-routing.md`, "No account"). The scrub
  drops every `ANTHROPIC_*`, `CLAUDE_*` (including a service-level
  `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_BEDROCK`/`_VERTEX` and tunings such as
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`), `AWS_*` and `VERTEXAI_*` variable and
  `GOOGLE_APPLICATION_CREDENTIALS` (`claudeChildEnvironment.ts`).
- **pi engines use the lease.** With `host.gateway`, the pi factory
  (`createPiHostedEngineFactory({ models, compat })`) gives the engine its own
  model port (`gatewayPiModelPort.ts`) instead of the server's: one in-memory pi
  runtime per open for the open's account alone, whose only key is the lease,
  with no `auth.json`, `models.json` or `models-store.json` and no catalog
  fetch. An OpenAI account's port registers only `openai-codex`; an
  OpenAI-compatible account's registers only that account's provider. Neither
  finds or offers a model of another account or kind. It is released when the
  engine is disposed or its open fails. Without `host.gateway`, the server's
  port runs the engine as before.
  - Every Codex model the port answers is rebased onto the gateway's
    `/chatgpt/backend-api`: the profile's server-catalog model when it has the
    id, else pi's built-in. The gateway adds the profile's token and account id
    from its `auth.json`.
  - A reopened or forked transcript restores its model through the port, passed
    to pi explicitly, which adds no entry. When the port has no such model, pi's
    own restore and fallback run, and an agent still refuses the fallback.
  - Turns use SSE (`agent.transport = "sse"`): the gateway refuses WebSocket
    upgrades. Summaries keep pi's default and fall back to SSE on that refusal.
  - The runtime's `getAuth` is guarded per request (`credentialPairing.ts`): a
    credential goes only with a model at the exact `baseUrl` it was registered
    for, and a resolution during which the registration changed gets none. Any
    other object, such as a Codex model still at `chatgpt.com`, or an
    OpenAI-compatible model from an endpoint its account has since replaced,
    gets no auth, and pi refuses it ("Provider is not configured") before it
    connects.
  - **Compatible accounts under the switch.** OpenAI-compatible endpoints are
    accounts of their own (`docs/account-routing.md` "Account kinds"). The link
    syncs each as a profile with no token file and pushes its pair ("gateway
    control" above). Its port follows the account's key-less configuration from
    `compatProviderFeed.ts` and registers its provider, under the account's id,
    at the gateway's `/compat<base path>` with the lease as its key; the gateway
    adds the account's own key. A change of origin under the same base path
    keeps the registration; another base path re-registers. A base URL the
    gateway refuses structurally (userinfo, query, fragment or a scheme other
    than http or https) registers nothing, so the open fails with "offers no
    models. Run Test on its card in Settings, or start a new session." With the
    switch off they run on the account's own runtime below, and Settings' Test
    always reaches the endpoint's `/models` directly.
- **One-shots and Codex usage use a server lease** (G4a). The link grants one
  server lease per profile per boot on first use (`serverAccess`), held in
  memory and shared by every caller; a failed grant is forgotten and a removed
  profile's entry is dropped, so the next call grants anew. A grant waits at
  most 10 seconds for the link and fails with the engine open's text above.
  - A Claude one-shot sets the engines' three variables over the profile's
    scrub, with the server lease as `CLAUDE_CODE_OAUTH_TOKEN`.
  - A pi one-shot runs on its own gateway port, as an engine does, over SSE,
    disposed when it ends. A model the port does not serve for the profile fails
    with the helper's no-model text before any session.
  - Codex usage, reset credits and consume send the lease to `/chatgpt`'s usage
    routes. The server reads only whether `auth.json` holds a Codex login and
    when it expires; the token and account id are added by the gateway alone. A
    marked refusal is thrown as its text, never mapped to a rejected or
    forbidden login.
  - Claude usage sends the lease to `/anthropic`'s usage route; the server reads
    only `subscriptionType`, and only the gateway renews ("Renewal"). Compatible
    model discovery stays direct (G5).
- **The server's runtimes pair the compatible key with its origin.** Every pi
  runtime `models.ts` creates for sessions is guarded per request whatever the
  switch (`serverCredentialPairing.ts`, over the same `credentialPairing.ts`
  guard). Switch-off engines and one-shots run on them. Only a compatible
  account's runtime registers a compatible provider, its own. Every account
  change re-registers it on the runtime already created, the one running
  sessions and one-shots hold, before the change's caller returns
  (`docs/agent-harnesses.md` "Account model gate"). Its model gets the key only
  while the registered endpoint is on the model's own origin, so a model held
  across a change to another origin is refused with pi's
  `Provider is not configured` before it connects: the new key never reaches the
  old endpoint, nor the old key the new one. A key-less endpoint is the
  established exception: with no key to pair, nothing is refused, and a held
  model keeps sending to the origin it was opened on, without a key.
  - A held model's next request sends a rotated key, and the `none` placeholder
    once the key is cleared. A new base URL drops the discovered models, so a
    held model is refused until Test rediscovers; after that, one on the same
    origin runs again with the key. Deleting the account unregisters its
    provider, so a one-shot still holding it is refused. A disable changes no
    runtime. A key-less endpoint (the `none` placeholder) pairs no credential
    and is never refused.
  - A request already resolving its key keeps the registration it started on. pi
    takes the provider and its key in the same step that the guard reads the
    pairing, so a change landing meanwhile neither refuses it nor pairs the new
    key with the old origin.
  - The guard compares origins, where the leased port compares exact bases;
    Codex and other providers resolve as before.

### Renewal

With the switch on, the gateway keeps every leased profile's upstream token
valid by itself (`gateway/renewal.ts`, U8). Engines never refresh: the Claude
CLI's environment token is never refreshed, and pi uses the lease as a key.

- **Eligibility.** A Claude or Codex login profile is renewed while it is
  registered and holds a live lease, whatever its `enabled` flag, so a disabled
  account's running and background work keeps working. An idle profile renews at
  its first request. An OpenAI-compatible profile has no token file and is never
  read or renewed: the tick, a request, a 401, `renew` (answered `skipped`) and
  a hold's recheck all pass it by, so it never reports a login state.
- **Cadence.** A 60 s tick renews a token inside its margin: 10 minutes for
  Claude, 30 for Codex. A request whose token has at most 60 s left waits for
  the renewal, at most 30 s, then goes on with whatever the file holds; one
  inside the margin starts a renewal and goes on. Renewals are single-flight per
  profile and run in its writer lane, so a login hold fences them.
- **Claude** mirrors CLI 2.1.316: the same JSON refresh to
  `platform.claude.com/v1/oauth/token`, no redirects, 30 s. It takes the CLI's
  own locks (`<config dir>/.oauth_refresh.lock`, then `<config dir>.lock`; stale
  after 60 s, kept alive every 5 s, 5 retries 1–2 s apart, then `lock_busy`) and
  re-reads under them: a file another writer renewed is `fresh`, with no
  request. The save is a compare-and-swap: it writes only while the file still
  holds the refresh token it sent (or an empty one), else adopts the file as it
  is (`adopted`). It writes a 0600 temp file beside the target, fsyncs it and
  renames it over it, keeping every other key, and never creates a file or
  directory, so a deleted profile stays deleted.
- **Codex** goes through pi 1.5.0's own refresh (`getAuth` with
  `minOAuthValidityMs`), injected into the gateway as a port
  (`piSdk/codexRenewal.ts`). Its store takes pi's own `proper-lockfile` lock
  with pi's options, so pi's engines, a login and the gateway serialise and
  re-check under one lock. It commits only while the lock was not reported lost
  and the `openai-codex` entry is still the one the refresh started from, keeps
  every other provider's entry, and replaces the file by an atomic rename. In
  the standalone gateway the port spawns one Codex renewal child per credential
  through `gateway/codexChild.ts`; pi loads only in that child
  (`codexRenewMain.ts`). The child reads `{authFile, minValidityMs}` on stdin,
  writes one result line without credentials and exits 0. The parent accepts
  only fixed result codes, preserving the refresher's `400` and `401` rejections
  as needs-login, never copying arbitrary upstream strings. Every outcome waits
  for its exit. Abort or deadline sends SIGTERM then SIGKILL after a five-second
  grace, so no child writer outlives its lane item. In-process mode still
  injects the direct refresher.
- **Outcomes.** A failure (timeout, network, a 5xx, a malformed answer, a busy
  or lost lock, a conflict) writes nothing, never marks the login dead and backs
  off from 30 s, doubling to 10 minutes; success or a changed file ends the
  backoff. A conflict whose re-read shows a new token counts as renewed.
- **An upstream 401** passes through byte for byte. When the file still holds
  the token it was sent with, it forces one renewal per profile at most every 5
  minutes; it never marks a login dead.
- **Needs login.** A rejected refresh (Claude's `invalid_grant`, Codex's 400
  or 401) is retried once when the file changed meanwhile, else the profile
  needs a login until its file changes: the token file is never touched,
  requests get a 401 with "Pandeck gateway: the account <name> needs a new login
  (Settings → Accounts)." in the provider's shape, and the gateway sends
  `profiles.credential {profileId, needsLogin}` (1.3), a gateway → server
  request answered `{}`, resent on every hello. A missing or malformed file
  (including the CLI's blanked tokens) is read twice more, 50 ms apart, then
  gets the same refusal and status until the first good read; an unreadable one
  gets the credential refusal. The link records the latest status
  (`credentialStatus`), and account health takes it as the only needs-login
  evidence for a Claude or Codex account (`gatewayHealth.ts`,
  `docs/account-routing.md` "Gateway-served accounts").
- **One refresher.** With the switch on the gateway is the only Pandeck writer
  of a token file, `claude-default`'s included. The server's pi runtimes read
  credentials through `PresenceCredentialStore`, which answers presence and type
  with placeholders that never expire, so pi never refreshes or writes through
  them; they keep their model catalog. Their `getAuth` answers no auth for a
  Codex model, while an OpenAI-compatible model keeps its own pairing
  (`serverCredentialPairing.ts`). The login runtime is the server's only writer,
  fenced by its hold (Login holds). A terminal CLI the user points at an
  account's directory with the setup fallback's `CLAUDE_CONFIG_DIR` stays
  outside Pandeck, under the same locks and compare-and-swap.
- **Tests never reach a token host.** The Claude endpoint override is a test
  seam that only tests and the Bun probe set (`architecture.test.ts` pins every
  production mention); `startGatewayLinkForTests` points it at a closed loopback
  port. The test setup refuses `platform.claude.com` and `auth.openai.com` at
  the name lookup and in `fetch`, and fails the test that asked
  (`test/tokenHostGuard.ts`).
- **Known limits.**
  - A rotation race outside the lock protocol, such as a copy of an account's
    login used from another directory (a terminal CLI's own `~/.claude`), can
    still end in needs-login.
  - pi's own in-place `auth.json` write remains for logins (under their hold)
    and switch-off engines; a crash during one can truncate the file, as today.
  - A renewal whose request succeeded but whose commit is refused (a lost lock,
    a changed entry, a deleted profile) loses that rotation; a provider that
    invalidates the old refresh token may then need a login.
  - pi's Codex token request follows redirects, as pi does today.
  - pi requires a refreshed Codex token to outlive an explicit minimum, so a
    forced renewal whose new token lives no longer than the old one's remainder
    reports a failure; the gateway's re-read still counts it as renewed.
  - The Claude refresh is an undocumented contract: C17 and the operator's smoke
    guard it, and a CLI or pi pin bump re-measures it.

### Client mode

A Pandeck on another machine (the IDB pilot) can run its models through a remote
gateway that owns the accounts (Task-1384, gateway-service M13-M15). It is off
unless `ASSISTANT_GATEWAY_RELAY=<socket path>,<loopback port>` is set, which
takes precedence over `ASSISTANT_GATEWAY`; self-hosted keeps the server-master
path above.

- **Edge ports** (`gateway/clientListener.ts`, started by `startGateway`'s
  `clients` option): an HTTPS enrollment port without a client certificate, and
  two mutual-TLS ports with the gateway's own CA as the only trust root: the
  model port (the loopback listener's routes) and the client-protocol port. The
  client is its certificate's common name, matched by fingerprint, and is
  checked on every connection, request, method and push. Revocation closes all
  that client's connections, cancels its running logins and revokes its leases.
  A 250 ms check notices admin-CLI revocations even for a silent or disconnected
  client; a finishing login rechecks before ingesting its credential. A failed
  registry read defers the timer's cleanup, preserves connections, logins and
  leases, and logs once per failure episode. After a successful read or write, a
  missing `clients.json` is also unknown, not an empty registry. A first start
  without that file remains valid; a valid empty client list is authoritative.
  Only a successful read may trigger revocation cleanup. Registry failures in
  requests answer 503 or close the affected connection, never exit the process.
  Each port allows 64 connections and a 10 s TLS handshake; enrollment also has
  5 s header and 10 s request timeouts, and allows 30 attempts per source
  address per minute. The model port is a TLS server that hands each admitted
  socket to an HTTP parser (Bun's `https.Server` names no client certificate:
  `docs/deployment.md` "Bun runtime differences"), and its deadlines are the
  listener's own, separate budgets per phase: while a connection awaits a
  request (after the handshake, and whenever no request is open) the next
  request's headers must be complete within 60 s and the socket may stay silent
  5 s; each request's body must be complete within 300 s of its headers, by its
  own timer. A request is open from its headers until its response ends, so
  pipelined requests keep the connection out of awaiting. Nothing bounds a
  response: a long, quiet model stream is never cut. Every expiry closes the
  connection. The source table holds at most 4,096 addresses and refuses new
  sources until entries expire if full. A lease names its client and is spent
  only on that client's connection; the loopback listener refuses client leases.
- **Enrollment.** `gateway/adminMain.ts` adds users, prints a one-time code (15
  minutes, kept hashed) and lists, revokes clients and prints the CA. The client
  sends the code and its EC P-256 public key to `POST /enroll` and gets a
  certificate (`gateway/x509.ts`, issued with `node:crypto`) and the ports.
  Unknown, used or expired codes write nothing. The CLI and edge serialize
  read-modify-write with `clients.json.lock`, wait at most one second for a
  writer, and use unique owner-only temp files for atomic replacement. A crashed
  writer leaves a lock containing its PID. Mutating admin commands exit non-zero
  without reporting success; their error names the lock and asks the operator to
  verify that its writer is no longer running before removing it. The gateway
  logs that same error once per blocked-lock episode, not on every request.
  Reads and unknown-code refusals still work. `user list` prints each user's id,
  label, email and whether it has a sign-in identity;
  `user claim <id> --email <addr>` binds that user to the next admitted sign-in
  to the gateway's page (below). A signed-in user also creates codes, lists and
  revokes their own clients on the gateway's page, over the same registry
  (Task-1405, below); the page's codes are bounded, the CLI's are not.
  `gateway:relay enroll --state-dir <dir> --gateway <host:port> --ca <pem file>`
  reads its code from stdin, or from `--code-file <0600 file>`. Never put the
  code in argv or a shell command. For example, redirect a protected code file
  into stdin rather than using `echo <code>`.
- **Approval enrollment** (Task-1410, `gateway/enrollmentApproval.ts`). With the
  gateway's page configured, `gatewayEdge.ts` passes its `publicOrigin` to the
  listener (`approvalOrigin`) and machines can enroll by an approval on the page
  instead of a code.
  `POST /enroll/start {publicKeyPem, mcpTokenHash, name, kind?, devbox?}` (an EC
  P-256 key; the SHA-256 of the machine's MCP token as 64 lowercase hex; a name
  of 1-64 shown characters, no control or format characters; `kind` `devbox`,
  `laptop` or `other`, the default; `devbox` under "Zero-click enrollment")
  answers
  `{requestId, userCode, verificationUri, expiresInSeconds: 600, intervalSeconds: 5, approval}`,
  with `verificationUri` `<publicOrigin>/#enroll=<userCode>`: the code only in
  the fragment, the request id nowhere in it. `approval` is `"browser"`, or
  `"automatic"` when a devbox's proof approved the request at once. A malformed
  body is 400; without the page, `/enroll/start` is 404 like an unknown path.
  `requestId` (32 random bytes) is the machine's secret for collecting;
  `userCode` (8 letters of `BCDFGHJKLMNPQRSTVWXZ`, shown `XXXX-XXXX`) is what a
  person compares. `clients.json` keeps only their SHA-256 hashes, in an
  optional `requests` list that older builds keep and ignore.
  - Admission: a start costs a per-source attempt (above). A source address has
    at most 4 open requests (429) and the edge 64 (503); open means undecided or
    approved and not collected, and unexpired. Denied, collected and expired
    requests free their slot, but at most 256 records are retained in all (503
    at the cap, nothing written). A request expires 600 s after its start,
    decided or not; its record is swept 600 s after that.
  - Decision: the page's (below), or a devbox's proof ("Zero-click enrollment").
    The first decision wins; an approval binds the session's user, or the proven
    owner, and counts as one of the page's pending codes (bounds below), both
    ways, under the registry's lock.
  - `POST /enroll/poll {requestId}` works with or without the page, so an
    approved request is still collected after a restart that dropped it. It
    answers 202 `{status: "pending"}`, 200
    `{clientId, certificatePem, caPem, modelPort, clientPort}`, 403 `denied`,
    410 `expired` (not collected in time), 410 `revoked` or 404 (unknown or
    swept). A known request polled faster than every 4 s answers 429 `slow_down`
    with `retry-after: 5`. A malformed or unknown id costs a per-source attempt
    and allocates nothing per request. The per-request limiter holds at most 256
    entries; after many collected requests are swept at once, a stale entry can
    cause one extra `slow_down` for at most its remaining 4 s.
  - Collect: the first one issues the certificate for the request's key and, in
    one locked change, adds the client with the request's MCP token hash and
    keeps the certificate (public) on the request; a failed issue or write
    leaves no client. Every later poll until the sweep answers the same client
    id and a byte-identical certificate, also after a restart, and writes
    nothing. A collect never sets, restores or replaces a token, so a revoke or
    replacement from the page or admin CLI stays in force; once the client is
    revoked, a repeated collect answers 410 `revoked`, checked under the lock.
  - A lost answer is recovered by polling again until the record is swept, up to
    1,200 s after the start. After that, or when the machine lost its key or
    token, the orphan client shows in the user's list: revoke it there and
    enroll again.
  - Logs: `enrollment request started` and `enrolled client <id> by approval`,
    never a request id, user code, token hash or key.
- **Zero-click enrollment** (Task-1410 PR2, `gateway/devboxProof.ts`,
  `ClientRegistry.approveAutomatically`). With the page's `coder` section and
  `automaticApproval: true` ("The gateway's sign-in and UI"), a devbox may send
  its owner's Google access token, the one Coder holds for the workspace owner,
  as `devbox: {googleAccessToken}` (1-2048 printable ASCII characters, no
  spaces; anything else is a 400) with its start. The request opens first, under
  the admission above, so a proof costs what any start costs; then:
  - Proof: token info (`POST https://oauth2.googleapis.com/tokeninfo`, the token
    in a form body, never a URL) must name Coder's client
    (`coder.googleClientId`) as `aud` and, when present, `azp`; give an
    `expires_in` of 1-3600 s, a `scope` with `email` and a `sub`. Its `email`,
    `email_verified` and `hd` are never read. The proof stops counting at
    `notAfter`, the clock read just before sending plus `expires_in`, fixed
    once. Userinfo (`GET https://openidconnect.googleapis.com/v1/userinfo`, the
    token as a Bearer) must name the same `sub`, and the page's allow rule
    judges its claims, `hd` among them when configured. The proof must still be
    before `notAfter` after userinfo, and again under the registry's lock.
  - Approval: one locked change finds the user by Google's issuer and `sub` or
    creates one exactly as a first page sign-in does; never binds by email: an
    operator's unexpired claim on that email answers `claim_pending`, and the
    page's sign-in binds it. It applies the page's bounds (4 pending, 16
    clients), stores the decision as `{userId, at, automatic: true}`, which the
    page never shows, and records the token's SHA-256 in `automaticApprovals`.
    The first poll collects. A refusal writes nothing.
  - Replay fence: one approval per token. A hash is kept 61 minutes; Google's
    `expires_in` is at most 3600 s from its answer, and an approval follows that
    answer, so every later proof of an approved token meets `already_used` or
    `expired`, across restarts and processes. **This guarantee assumes the
    edge's wall clock does not jump forward by more than 59 seconds** (the
    margin between 3601 s and 61 minutes) between an approval and a later proof
    of the same token; a backward jump only delays expiry. The edge runs NTP. At
    most 256 hashes are live; past that, `unavailable`.
  - Answer: after a proof answered `"browser"`, `automaticRefused` is one of
    `not_configured` (no `coder`, or `automaticApproval: false`; nothing is
    called), `token_rejected` (Google refused it, another client, a longer life,
    no email scope, another subject at userinfo, or past `notAfter`),
    `not_admitted` (the allow rule), `claim_pending`, `already_used`, `limit`,
    or `unavailable` (4 proofs already running, Google unreachable, 5xx,
    redirecting, oversized or too slow, 256 live hashes, or its connection
    gone). Nothing else about the proof is answered. The request stays open for
    the page.
  - Window: a request the page decides, or that expires, between the start and
    the locked approval answers `"browser"` with `unavailable`; the poll then
    collects the page's decision or answers `expired`.
  - Deadlines: each Google call 3 s, the whole proof 6 s; at most 4 proofs in
    flight per edge, a fifth `unavailable` without a call; redirects are not
    followed, answers over 64 KiB refused, and every outstanding call is
    destroyed at the deadline. While a proof runs its socket idles up to 15 s,
    back to 10 s before the answer: the route takes at most about 8 s, inside
    the relay's 15 s request deadline, so a slow Google answers `"browser"`. A
    connection that ends aborts the proof and approves nothing.
  - The token is held in memory for one verification and goes only to those two
    hosts; state keeps only its SHA-256. Logs:
    `enrollment request approved automatically for user <userId>` (with
    `, new user` when one was created) and
    `automatic enrollment declined: <reason>[ (<HTTP status or errno code>)]`;
    never an email, request id, user code, token, hash or Google's text.
  - Trust model: anyone holding a fresh owner Google access token issued to
    Coder's client can enroll one machine as that owner within the token's hour,
    once per token. Holders: Coder (it stores each owner's Google access and
    refresh tokens: its operators and anyone with its database); Google; every
    workspace of that owner whose template reads the owner's OIDC access token
    (any process in it, and the build's Terraform state); Template Admins and
    Coder owners, who can read Terraform state and, when a template puts the
    token in env, a script, an app command, metadata or a log, the workspace
    API; and Template Admins, who can make a template read it on the owner's
    next build. Nothing ties the request to a workspace or a starting build.
    When the real devbox comes second with the same token it gets
    `already_used`, falls back to the browser and the edge logs it. Any admitted
    Google account with such a token gets a gateway user without visiting the
    page, admitted by the page's own rule. `automaticRefused` tells a token
    holder which check failed. This residual risk is accepted for now
    (Task-1422). Follow-ups: Task-1422 (approve automatically only from the
    address ranges devboxes reach the edge from) and Task-1423 (bring back a
    check with Coder's API, through a service user's read-only token, once
    credentials visible through the workspace API are revoked or expired).
- **MCP token at enrollment** (Task-1410), on both paths: the relay makes its
  token (`pgmcp_` and 32 random bytes from `randomBytes`, the format the page
  mints), sends only its SHA-256 as `mcpTokenHash` with `/enroll/start` or
  `/enroll`, and writes it to `mcp-token` (0600) beside its key, certificate, CA
  and `edge.json`, all only after a 200. The token's plaintext never crosses the
  network during enrollment and no enrollment answer holds one; `/mcp` still
  receives it as the bearer token, and the page's Replace still answers a new
  one. The gateway cannot check the machine's randomness from a hash, as it
  cannot check its private key's. `/enroll` without `mcpTokenHash` enrolls a
  tokenless client as before; such callers are not migrated.
- **Relay approval mode.**
  `gateway:relay enroll --approve --name <text> [--kind devbox|laptop|other] [--owner-token-file <0600 file | ->] --state-dir <dir> --gateway <host:port> --ca <pem file>`
  prints the link and the code, nothing secret, and waits. With
  `--owner-token-file` (`-` reads stdin; otherwise a regular 0600 file opened
  without following a symlink) a devbox sends its owner's Google token as proof:
  at most 2048 bytes after trimming, empty meaning none. It is never written,
  logged or put in argv or a child's environment. On `approval: "automatic"` the
  relay prints "Approved automatically." and polls at once; otherwise it prints
  the reason, then the link and the code. A gateway without `approval` (before
  Task-1410 PR2) means the browser. A start with the proof that times out, fails
  on the network or answers 5xx is sent once more at once without it, with the
  same key and token hash, and the reason shown is `unavailable`; an abort is
  never retried and writes nothing. The first request, if the edge opened it,
  expires unused. It polls every `intervalSeconds`, 5 s longer after each 429;
  after a 5xx or a network error it waits 5 s, doubling to 60 s, until a poll is
  answered again. Every enrollment request (both paths) has a 15 s deadline. It
  gives up 630 s after the start (`expiresInSeconds` + 30 s, its own deadline,
  shorter than the record's 1,200 s retention), on `denied`, `expired`,
  `revoked` or an unknown request (exit 1), or on Ctrl-C (exit 130), writing
  nothing in each case.
- **Client ids.** A client's id, its certificate's CN, is `c_` and 16 random
  base64url characters, so it never starts with `-`. Ids enrolled before the
  prefix keep their shape; one that starts with `-` goes after `--` on the admin
  command line (`clients revoke -- <id>`), where any option comes before `--`.
- **`gateway-client/1.0`** (`gateway/clientMethods.ts`), on the worker
  protocol's framing: `client.hello`, `accounts.list` and the gateway's
  `accounts.changed`, `leases.grant`, `leases.client` (the server's own
  requests, one lease per account and client), `leases.bindSession`,
  `leases.revoke` and `leases.reconcileWorker`, all on the calling client's
  leases and its user's accounts only; `accounts.remove`; and the login API
  below.
- **Logins** (Task-1385, M11; the edge's `gateway/logins.ts`, the vault's
  `gateway/vaultLogins.ts` behind `VaultPort.login`):
  `logins.start {kind, accountId?, name?}` answers `{loginId, accountId}`; the
  gateway sends `logins.event` (output, URL, code, state) to the starting
  client, which may send `logins.input` and `logins.cancel`. Without `accountId`
  the account is registered at once, needing a login, and removed if its first
  login does not succeed, once that login's driver settled. These methods and
  `accounts.list`/`accounts.remove` run through the edge's one user-scoped seam,
  `gateway/userOperations.ts`, which the gateway's page uses too (below): a
  login's actor is a client or a page session. One login per account: the same
  actor's second start answers its running login; another actor of the same user
  takes it over. The old login ends for its actor at once, `cancelled` with
  "This login was started again elsewhere.", and can no longer commit; the new
  one is answered at once but starts its driver only after the account's earlier
  driver settled, so the vault never runs two for one account. If that takes
  over 30 s, the new login ends `error` ("The earlier login did not stop in
  time. Try again.") and never starts later. An account holds a slot while it
  has a login that is not terminal or a driver that has not settled (a cancel or
  a deadline only asks a driver to stop): at most 2 per user and 4 on the edge
  (`MAX_VAULT_LOGINS`), refused `login_unavailable` beyond them; the vault's own
  admission (4 in all, one per account) still answers last. A new account whose
  owning login ended other than ready is removed exactly once, when no driver of
  it is left, unless a newer login took it over. Once the edge granted a login's
  commit (the vault is moving the credential in), nothing takes it over or stops
  it: a start from elsewhere waits for its driver and then runs as a re-login,
  and the old dialog shows the real outcome. A login whose credential was saved
  never has its account removed, even if recording the account then fails (it
  ends `error`, reason `unavailable`). If the vault link breaks under a running
  login, the vault may still run its driver: the login ends for its actor
  (`unavailable`), but its account's slot and any cleanup stay held for the
  vault's settle bound plus a minute (`UNCERTAIN_HOLD_MS`, 11 min 35 s, derived
  from `VAULT_LOGIN_SETTLE_BOUND_MS`; see Remote vault, "Login bound"), since
  the vault's hello names no running logins; only the vault's own refusal of a
  start counts as "never ran". Removing an account while its granted commit is
  installing is safe: the vault's discard runs in the account's writer lane,
  after that ingest, so neither the token file nor its sealed record comes back.
  Each login runs an injected driver (`startGateway`'s `loginDrivers`: the
  official CLI's `claude auth login` as a child with `CLAUDE_CONFIG_DIR` set,
  `claudeLoginDriver.ts`; pi's device-code login, `piSdk/codexLogin.ts`) in a
  fresh directory under the state directory. On success one writer-lane item
  checks the credential and renames it into the account's token file, which
  replaces the whole file; the directory is always deleted. The credential never
  leaves the gateway, and no login hold is taken.
- **The relay** (`relay/`, its own entry and process under Pandeck's server
  account, `node:` only) is the only holder of the client key. It pipes its
  loopback port to the model port and each connection on its 0600 Unix socket to
  the client-protocol port, understanding neither. Model requests and answers
  keep their header fields as received, in order and with every repeat, without
  hop-by-hop fields; a request with no `Host` gets the edge's address, as Node
  would set it. Its TLS checks the edge's certificate for the enrolled address,
  never a forwarded `Host`: a DNS name is the SNI, and an IP sends none and is
  matched as an IP (Task-1424 transport amendment).
- **The server** (`gatewayClientLink.ts`) speaks the client protocol through the
  relay's socket, mirrors the gateway's accounts into the profile registry and
  gives engines the relay's loopback URL. Settings' existing UI drives the
  gateway (`remoteLogins.ts`): adding an account starts its first login, the
  login dialog receives both providers' login events (Claude's output, read only
  for its authorization URL, Codex's URL and code as one `device` message, never
  on the account), Cancel sends `logins.cancel`, also while the gateway's start
  has not answered yet (it is latched and forwarded once the login id is known),
  and delete calls `accounts.remove`. The gateway sends a login's events only
  over current connections, so a lost connection marks the server's running
  logins interrupted; after the next connect each is cancelled on the gateway.
  An `unknown_login` answer, to that cancel or to the user's, means the gateway
  no longer runs it: the dialog ends with "The gateway connection was
  interrupted. Start the login again." and the account shows the mirror's state.
  Otherwise the gateway's own terminal event ends it. Known limit: a start whose
  answer is lost with the connection can leave the gateway's login running until
  its 10-minute timeout; a retry from the same client rejoins it (without the
  device code or output it already sent), a start from elsewhere takes it over,
  and Cancel ends it. This credential ownership does not move Claude's local
  runtime/transcript directories: Pandeck's one-time Default transcript import
  and startup gate still apply before the client link starts
  (`docs/credential-distribution.md`).
- **Gateway tools** (Task-1398, Slack Task-1455, Confluence Task-1439,
  `remoteTools.ts`, `tools/gateway/remoteToolGroup.ts`). On every connect the
  link calls `tools.list` after `accounts.list` and the first reconcile, and
  publishes the connection and resolves `ready` only after it applied that
  listing, never for a closing link or a dial that ended meanwhile. An edge
  without tools (`tools_unavailable` or an unknown method) counts as an empty
  listing. Pandeck accepts at most 64 entries, each a read tool
  (`effect: "read"`) whose `actionKey` prefix names a mapped product, within the
  bounds the edge's `gatewayTools/tools.test.ts` checks (name, 1,024-character
  description, 4,096-character object schema); a name listed twice is dropped.
  One table in `remoteTools.ts` maps the products, `jira`, `slack` and
  `confluence`, each to its Settings toggle (`jira.enabled`, `slack.enabled`,
  `confluence.enabled`); any other prefix is dropped. A product with a read-name
  list (`PRODUCT_READS`) accepts only those names: Confluence accepts
  `confluence_search`, `confluence_get_page` and `confluence_lookup`, so the
  edge's attachment download and any later Confluence tool stay out until a
  change admits them. Jira and Slack have no list. Every name accepted in a boot
  stays in the catalog for that boot. Each product has a deferred catalog group
  that replaces its local group: `gateway-jira` replaces `jira` and is gated by
  `gatewayJira` (connected and Settings → Jira enabled); `gateway-slack`
  replaces `slack` and is gated by `gatewaySlack` (connected and Settings →
  Slack enabled); `gateway-confluence` replaces `confluence` and is gated by
  `gatewayConfluence` (connected and Settings → Confluence enabled, independent
  of Jira's toggle). A connect, a lost connection and a product's toggle reach
  live sessions as `tools/list_changed` and pi's gate command. The tools are
  `sideEffects: "none"`, so Plan keeps them, and a remote name equal to another
  tool of the persona is left out. Before every call the tool checks the
  connection, its product's toggle and that the latest listing still offers it,
  with no gateway call otherwise; then `tools.call` goes out on the link's
  connection, bounded at 40 s by a cancel (the request stays until the edge
  answers or the connection ends; that late answer is dropped). Only the edge's
  `tool_error` and `invalid_params` texts reach the agent; every other failure
  is Pandeck's fixed text. A pi open (new, existing, fork or staged replacement)
  waits up to 10 s for the boot's first listing and is otherwise refused with
  the gateway-unavailable text, so its up-front tool registration holds the
  gateway's tools.
- **Known limitations of gateway tools.** A tool newly deployed on the gateway
  reaches a live pi session only at its next open, because pi registers its tool
  universe at open; Claude sessions get it once the next connection's listing is
  applied, without reopening (D8). This includes tools added after an empty
  first listing. The follow-up, named and not built: "pi late registration or
  reopen on listing change". A changed schema of a known name reaches pi at its
  next open too; the edge checks arguments either way. Only Jira, Slack and
  Confluence are mapped: a gateway tool of another product needs a Pandeck
  change (table row, disabled text, gate and catalog group) before it appears.
  Confluence offers only its three reads: `confluence_mutate_page` waits for
  gateway writes and `confluence_download_attachment` for Task-1441, and until
  the edge lists the reads the `gateway-confluence` group is empty. Settings →
  Confluence answers `credentialStore: "gateway"` and `credentialsAvailable`
  from the gateway's last Atlassian status (stored, not verified); its
  connection test makes no call and points to Settings → Jira, which tests the
  shared Atlassian connection. `slack_file_read` is not offered in client mode
  until the edge runs it (Task-1441). Settings → Slack shows no gateway Slack
  connection status (Task-1464); a Slack tool called without a Slack connection
  on the gateway answers the edge's fixed text, which says to connect it on the
  gateway's page. Pandeck's local Jira and Confluence tools are not offered in
  client mode; their gateway groups replace them.
- **Local live test.**
  `pnpm --filter @assistant/server gateway:dev --state-dir <dir>`
  (`gatewayDevMain.ts`) runs the edge's composition (`gatewayEdge.ts`) with the
  client listener and both live login drivers on 127.0.0.1, or on `--bind-host`
  with each `--host` in the edge's certificate. The packaged edge,
  `gateway-edge.js` (`gatewayEdgeMain.ts`), runs the same composition and flags
  but requires `--vault-host`: its logins run on the vault (`vault.js`, "Remote
  vault"). The packaged `gateway/main.ts` entry can run a configured client
  listener but supplies no login drivers and no tools. The commands
  `gateway:admin` and `gateway:relay` run the admin CLI and the relay. A second
  dev instance with its own `DATA_DIR`, `ASSISTANT_PORT`, `VITE_SERVER_ORIGIN`
  and `ASSISTANT_GATEWAY_RELAY` is the client.
- **Known gaps.** No automatic recovery of a crashed registry writer's lock. No
  OpenAI-compatible accounts and no lease TTL (leases live until revoked,
  machine leases included). In client mode, no rename, enable toggle or Clear of
  an unfinished login, and `gateway:dev`'s own vault runs both drivers in its
  process; a vault process runs them as children ("Remote vault").

#### Standalone harnesses

Claude Code, Codex, pi and OpenCode on an enrolled machine (a devbox or laptop)
use the gateway's accounts through the local relay (Task-1424 PR 1). The harness
points its base URL at the relay's loopback port and sends a fixed, public
placeholder as its key. Any process on the machine can do this; Thasso accepted
that. The relay's client certificate is the capability, and revoking the machine
ends access at once. The relay forwards request and response header fields with
repeats and verifies the edge by its enrolled address whatever the `Host`
(above). It drops hop-by-hop fields but never a request's framing: the body goes
up delimited where the relay's own parser delimited it, chunked again whatever
its method when the client sent `Transfer-Encoding` (the client's own fields go
up with it), otherwise with the client's `Content-Length`. A `Connection` field
cannot nominate `Host`, `Content-Length` or `Transfer-Encoding` away. The next
hop therefore ends each request where the relay did and never reads a body the
relay forwarded as a further request. Request fields starting with `x-pandeck-`
are reserved: every caller value is removed, regardless of case or repeats, and
one `x-pandeck-relay-id` is added. Bodies still stream unchanged; no credential
is added or removed. For the two Claude token hosts it intercepts, ADR-0006
changes the target and `Host`; every other named host it decrypts goes directly
to that host ("Interception" below).

- **Placeholder.** One literal, JWT-shaped because pi and Codex accept only
  that, pinned in `gatewayMachinePool.test.ts`:

  ```text
  eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoicGFuZGVjay1nYXRld2F5In0sInBhbmRlY2siOnsidiI6MSwibWFjaGluZSI6dHJ1ZX19.pandeck
  ```

  Header `{"alg":"none","typ":"JWT"}`, payload
  `{"https://api.openai.com/auth":{"chatgpt_account_id":"pandeck-gateway"},"pandeck":{"v":1,"machine":true}}`.
  It names no lease, so it is not lease-shaped, and it grants nothing on its
  own. It may sit in the environment.

- **Relay reporting** (Task-1430 PR2a). Each boot generates a random 32-hex id;
  each admitted model request gets `<boot>:<n>`, starting at 1. This request id
  does not order delivery. The relay reports local refusals and gateway-bound
  requests ending without edge response headers. Once edge headers arrive, the
  edge owns the record, including subsequent errors or caller cancellation.
  Fallbacks contain the enrolled edge host, method, query-free printable path
  capped at 200 characters, status or null, outcome, fixed reason or Node error
  code, credential class, cookie presence, byte lengths and duration. Durations
  are nonnegative integer milliseconds from a monotonic clock; admission `at`
  remains wall-clock time. No header value, query, body or raw session key
  enters a report or text line.
  - Admission reserves one of 19,999 ordinary slots before forwarding or a
    recorded local refusal. It releases that slot on edge headers, or converts
    it into the fallback until acknowledged. A full queue answers a marked 503
    without contacting the edge. Those refusals are counted, not individually
    recorded: one overflow note uses the final reserved slot, with count and
    earliest/latest observed wall-clock times. These bounds stay ordered even if
    the clock steps backward. Further refusals aggregate while that note is in
    flight.
  - The queue assigns `d` at enqueue, independently of request ids. One batch at
    a time goes over the same mTLS link to `POST /relay/observations`, at most
    100 records and 64 KiB. Only a valid 200 acknowledgement removes its prefix.
    Network errors, a 15 s response deadline and unsuccessful replies retry from
    1 s, doubling to 30 s. A 400 drops that batch with a fixed diagnostic and a
    count in the summary. A caller cannot forge batches through the loopback
    model listener: every `/relay/` target gets a local marked 403, subject to
    the same admission reservation.
  - On the client model port, the edge reads exactly one relay-id field matching
    `^[0-9a-f]{32}:[1-9][0-9]{0,14}$`. Invalid or repeated fields are ignored,
    the request is served without a rid, and its text line says `rid=invalid`.
    Valid ids enter client-scoped, boot-scoped dedup before `/mcp`, forwarding
    or a CONNECT refusal, including cached-client admission refusals. The
    observation-ingest endpoint keeps its separate active-client admission and
    does not reserve an id from batch transport metadata. A repeated id gets
    marked 409 `duplicate-rid`, one text line and no second record. A live id
    below the compacted floor is served and recorded with `rid=below-floor`,
    never refused merely because compaction lost precision. All upstream
    requests drop every `x-pandeck-*` field, on every listener.
  - The ingest endpoint accepts only POST, at most 100 entries and 64 KiB. The
    whole batch must validate before any record, rid or acknowledgement is
    changed: lowercase boot, increasing safe-integer `d`, matching rid boot,
    bounded integers, fixed enums/reasons, method matching `^[A-Z][A-Z-]{0,15}$`
    and query-free, printable ASCII pathname capped at 200 characters. The
    actual method is retained, including `M-SEARCH`. Edge-host ownership must
    match both the configured hosts and the actual edge certificate. DNS
    matching ignores case and one trailing dot; IPs compare in canonical form. A
    configured full-label wildcard matches exactly one DNS label, only if the
    certificate's SAN also permits it. The check uses no DNS or network lookup,
    no common-name fallback and no partial/multi-label wildcard matching.
    Separately, reports may name a lower-case DNS name equal to or under the
    relay's named domains (`anthropic.com`, `claude.ai`, `claude.com`;
    ADR-0006). Those P7 identities, including both token hosts, need not match
    the edge certificate. No other suffix or routing/policy change is allowed.
    The reported host spelling is retained apart from lower-casing. The
    authenticated registry supplies user/client identity; no body field can
    choose either. Invalid batches get fixed marked 400, oversized ones 413,
    other methods 405, never an echo. Records with `d` already acknowledged are
    ignored, then known-rid fallbacks are ignored independently of the display
    ring. A missing old fallback below the floor is discarded with a per-batch
    and running dropped count in the text log. Relay notes and fallbacks use the
    same request-log writer as the edge, labelled `via=relay`. Each note kind
    has a fixed first-seen identity.
  - Every boot's first queued record is `relay-restarted`, including the first
    ever boot. Its missing count means the prior loss is unknown. No observation
    queue, spill, marker or replay file is written. Crash loss is accepted.
  - Graceful close is new behavior. It stops accepting, answers requests still
    arriving on active keep-alive connections with marked 503 `relay-closing`,
    drains active model work for up to 5 s, then cuts remaining streams and the
    client-protocol sockets. Pre-header work becomes one fallback; post-header
    work remains the edge's record. It then flushes for up to 5 s. A timeout
    writes exactly one `observations: <n> not delivered at close` line, adding
    `overflow <m>` when appropriate. Repeated close calls share one promise.
    Allow more than 10 s for a service-manager stop. SIGTERM followed by SIGINT
    shares the same stop; repeating a signal whose one-shot handler has gone is
    an ordinary crash.
  - Every 10 minutes and at close, `relay summary:` counts since boot by host,
    relay-view outcome and credential class, plus rejected observation count.
    With interception it also counts `tls-failed` by named host and `malformed`
    CONNECT targets under the host `-`; neither is recorded. `forwarded` means
    edge headers arrived, not necessarily upstream success. This is
    observability, not lossless or exactly-once accounting. Edge dedup can lose
    state on restart, after 6 h of boot inactivity, or beyond 64 boots per
    client. Two UI rows with the same request id can then occur. Interval
    compaction beyond 4,096 gaps can discard a genuinely missing old fallback,
    with a counted edge diagnostic. Each note kind uses a seen-set identity.

  | Relay-local answer               | Status | Marker             | Reporting                                                 |
  | -------------------------------- | ------ | ------------------ | --------------------------------------------------------- |
  | Existing edge-unreachable answer | 502    | None, unchanged    | Fallback if no edge headers                               |
  | `overflow`                       | 503    | `Pandeck gateway:` | Aggregated overflow note                                  |
  | `relay-closing`                  | 503    | `Pandeck gateway:` | Refused record if a slot is available, otherwise overflow |
  | `reserved-path`                  | 403    | `Pandeck gateway:` | Refused record if a slot is available, otherwise overflow |
  | `transfer-coding`                | 502    | `Pandeck gateway:` | The observed request's `failed` record                    |
  | `connect-port`, `connect-target` | 403    | `Pandeck gateway:` | Refused record if a slot is available, otherwise overflow |
  | `origin-form`                    | 400    | `Pandeck gateway:` | Refused record if a slot is available, otherwise overflow |
  | `upgrade`                        | 501    | `Pandeck gateway:` | Refused record if a slot is available, otherwise overflow |
  | Malformed CONNECT target         | 400    | `Pandeck gateway:` | None; summary count only                                  |

  Marked answers use a fixed JSON error containing both provider shapes:
  `type: error`, and `error.type`, `error.code`, `error.message`. They never
  echo the target or any other caller text.

- **Setup.** `<port>` is the relay's loopback port. `127.0.0.1` and `localhost`
  both work (the `Host` check below); another name for the same address does
  not.
  - **Claude Code:** `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/anthropic` and
    `CLAUDE_CODE_OAUTH_TOKEN=<placeholder>`. Under a managed `forceLoginOrgUUID`
    (IDB), plain `claude` refuses before any model call, because its org check
    goes to the fixed host `api.anthropic.com`. There it runs through a wrapper
    with its own settings over the managed file, as the devbox's `claude-pool`
    does; the IDB template owns that wrapper. No gateway route answers the org
    check.
  - **Codex:** a custom provider with
    `base_url = "http://127.0.0.1:<port>/chatgpt/backend-api/codex"`,
    `wire_api = "responses"` and `env_key` naming a variable that holds the
    placeholder. This form starts under IDB's managed
    `forced_login_method = "chatgpt"`, which refuses the `auth.json` API-key
    form. Without that lock, `auth.json`
    `{"auth_mode":"apikey","OPENAI_API_KEY":"<placeholder>"}` with
    `requires_openai_auth = true` works too.
  - **pi:** in `models.json`, provider `openai-codex` with `baseUrl`
    `http://127.0.0.1:<port>/chatgpt/backend-api`, `api`
    `openai-codex-responses` and `apiKey` the placeholder. pi first tries a
    WebSocket `GET`, which the gateway refuses, then uses SSE.
  - **OpenCode:** a custom provider with `npm: "@ai-sdk/openai"`,
    `options.baseURL = "http://127.0.0.1:<port>/chatgpt/backend-api/codex"` and
    `options.apiKey` the placeholder. The built-in `openai` provider with the
    same `baseURL` also works but tries a refused WebSocket `GET` first.
    OpenCode itself refuses the built-in `openai-codex` name.
  - **Not yet proven live:** OpenCode answering through the gateway and ChatGPT
    accepting each harness's API-key-mode body are operator checks on a devbox
    after merge. A body a provider rejects is fixed in that harness's documented
    config; a gateway change returns to planning.
- **Interception (Claude Code, Task-1430, ADR-0006).** Without the custom base
  URL, Claude Code reaches its account calls and model calls through the relay
  as a proxy.
  - **Flag and files.** `relay run … --intercept-ca-cert <path>` loads or makes
    the interception CA: `intercept-ca-key.pem` and `intercept-ca-cert.pem`,
    both 0600, in the relay's state directory; the key is reused across
    restarts. It writes the certificate alone to `<path>` (0644, atomically) and
    adds a CONNECT handler to the model listener. An unusable key stops the
    relay with a message naming the file; delete `intercept-ca-*` and restart.
    Without the flag nothing changes: CONNECT is closed as before.
  - **Which CONNECT.** The target must be a valid authority (IPv6 in brackets,
    IPv4, or DNS labels, then a port). Every DNS name equal to or under
    `anthropic.com`, `claude.ai` or `claude.com` on 443 is decrypted (Task-1430
    PR4). `api.anthropic.com` and `mcp-proxy.anthropic.com` are the token hosts,
    sent to `/anthropic…` and `/anthropic-mcp…` on the edge; every other named
    host is an observed host. IP literals and every other host are blind
    tunnels, not logged by host. A named host on another port is refused 403
    `connect-port`, spelled with a trailing dot 403 `connect-target`. A target
    that is not a valid authority, or an IP or other host with a port outside
    1-65535, gets 400 and a log line without the target.
  - **Decrypted requests.** Origin-form only (an absolute-form target gets 400
    `origin-form`). An inner CONNECT never opens another tunnel or reaches the
    edge: it gets 400 `origin-form`, except `/relay/…` gets the existing 403
    `reserved-path`. Its record uses the outer named host and fixed path `/`,
    never the inner authority. Closing and overflow use the shared 503 refusal.
    Every refusal is marked and has Anthropic's error shape.
  - **Token hosts.** A WebSocket upgrade gets 501 `upgrade` without reaching the
    edge; `/relay/…`, an upgrade's included, gets 403 `reserved-path`. Each
    request keeps its header fields as received except hop-by-hop fields, caller
    `x-pandeck-*` fields and `Host`, which becomes one `127.0.0.1:<relay port>`;
    `Origin` still reaches the edge, which refuses it. Bodies pass unread.
  - **Observed hosts** (PR4, `observedTraffic.ts`). Each request goes directly
    to the CONNECT host on 443: SNI is that host and the certificate is checked
    against the default CA store. The inner `Host` and SNI never choose the
    destination. Nothing of the edge link is used: no client certificate, key,
    edge CA, agent or gateway credential; the observed hosts have their own
    keep-alive pool, to which a connection whose answer finished before its
    upload never returns. Header fields pass as received, repeats and order
    kept, without the fixed hop-by-hop fields, every field a `Connection` field
    names other than `Host`, `Content-Length` and `Transfer-Encoding`, and
    caller `x-pandeck-*` fields; `Host` is kept. No credential or cookie is
    added or removed, the target keeps its query, and a response `set-cookie`
    reaches the client. Bodies are piped both ways and never read. An upgrade
    keeps its `Upgrade` fields and one `Connection: Upgrade`. After the
    upstream's `101`, the relay writes the `101`, then each side's buffered
    bytes to the other, then pipes both ways; any other answer is an ordinary
    response followed by a close. A request body goes up framed as the relay
    parsed it: chunked again whatever the method, or with its `Content-Length`.
    An upgrade request goes up as its head alone, with neither `Content-Length`
    nor `Transfer-Encoding`, so nothing the client sends after it reaches the
    upstream before the `101`. `/relay/…`, an upgrade's included, gets 403
    `reserved-path` before any upstream contact, as on every ingress; closing
    and a full queue answer their 503 first. An upstream that cannot be reached
    or fails verification gets the marked 502
    `the relay cannot reach this host.` A response, an upgrade's non-`101`
    answer included, is re-framed only when its transfer coding is `chunked`
    alone or absent. The relay drops the client's `TE`, so a compliant upstream
    sends no other coding; one that does (`gzip, chunked`, say) gets the marked
    502 `transfer-coding` instead of its coded body reaching the client with
    nothing naming the coding (F006, RFC 9112 section 6).
  - **Reporting.** A token-host request takes the plain listener's path through
    the relay (admission, one rid, reserved fields dropped, a fallback record
    when no edge headers arrive), its record naming the token host and the
    original pathname without query. An observed-host request reserves its slot
    at admission and keeps it, and stays in the relay's drain, for its whole
    lifetime, an upgraded stream's included. When that lifetime ends (complete,
    early answer, client or upstream abort, failure or the close's cut) exactly
    one record is written with the final byte counts: `observed` with the
    upstream status (`101` for an upgrade) once upstream headers were passed on,
    plus `client-closed`, `relay-closing` or a Node error code if it ended
    early; otherwise `failed` with the local 502 or null and that reason
    (`UNKNOWN` for an error without a code; `transfer-coding` for headers the
    relay refused to pass on). An answer that finishes before the upload ends
    the lifetime right there, on Node and Bun alike, whatever the client does
    next: a backed-up upload is paused and may never show its end or its
    client's close. The record is `observed` with the upstream status, and
    `requestBytes` counts the body bytes read by then: those through the relay's
    counter plus those the inner request still buffers, never a chunk the
    counter holds (F007), so it may fall short of, but never exceeds, what was
    read. The upload stops; the inner server discards the rest of that body by
    its own framing, so the client's next request on that connection is read as
    a request. The upstream connection is destroyed, never pooled: Bun's server
    ends such a request at its answer and calls it complete with its body short,
    so a whole upload cannot be told from a cut one. `connect-port`,
    `connect-target`, `origin-form`, `reserved-path` and `upgrade` reserve a
    slot and are recorded (a refused CONNECT as method `CONNECT`, path `/`, its
    credential class read from the CONNECT's own fields, `Proxy-Authorization`
    included). Every class answers the 503 `overflow` without upstream or edge
    contact when the queue is full. A malformed target and a failed TLS
    handshake are only counted in the relay summary; blind tunnels are neither
    recorded nor counted. Decrypted connections join the relay's close: they
    drain with the plain listener's work and are then cut.
  - **Setup.** `HTTPS_PROXY=http://127.0.0.1:<port>` (never `HTTP_PROXY`),
    `NODE_EXTRA_CA_CERTS=<path>`, `ANTHROPIC_BASE_URL` unset, and none of the
    three domains in `NO_PROXY`; the IDB `claude-gateway` wrapper owns this.
    Only that process trusts the CA.
  - Interception is never enabled in a release without the relay's reporting
    (ADR-0006). Turning the flag off (or reverting) is the recovery; no state
    needs a migration or a wipe.
- **Machine path.** On a client's model port, a request whose bearer is not
  lease-shaped (three base64url segments whose payload names a lease), or that
  has none, is a machine request. A lease-shaped bearer takes the lease path
  unchanged: an unknown or revoked one gets 401 and never falls back to the
  pool. The loopback listener has no machine path. A machine request:
  1. is refused 403 `machine-origin` if it carries any `Origin`, or lacks
     exactly one `Host` whose name is `127.0.0.1`, `localhost` or `[::1]` (any
     case, optional port), so a web page cannot spend it, DNS rebinding
     included. Through the relay these reach the edge as sent: a foreign `Host`,
     or a second one, gets this marked 403 for an IP- or DNS-enrolled relay
     alike;
  2. on `/chatgpt` reaches only `POST /chatgpt/backend-api/codex/responses`.
     Never `/compat`, and WebSocket stays refused. The token routes
     (`/anthropic` and `/anthropic-mcp`, below) take the token-route rules
     instead;
  3. is served on the account its pool picks for the route's provider (Claude
     for `/anthropic` and `/anthropic-mcp`, OpenAI for `/chatgpt`) from the
     client's user's registry accounts, with that account's credential and, on
     `/chatgpt`, its `ChatGPT-Account-Id`. Nothing in the request names the
     account or the host: the route fixes the host;
  4. after the credential read, is checked again: the client still active, its
     machine lease live, its pin still on that account, the account still
     usable, and no needs-login answer. A change re-selects once; a second
     change gives 503 `machine-retry` with no third credential read. No request
     reaches the upstream with a credential that is no longer its selection's.
     This holds when the second read just found the last usable-looking account
     needs a login: that request gets the 503, and the next one, whose selection
     sees the empty pool, gets 403 `machine-pool-empty`. No extra final check
     runs (AC7b over AC8 for the first request, requester's ruling).
- **Token routes** (Task-1430 PR3, `gateway/machinePaths.ts`). `/anthropic`
  forwards to `api.anthropic.com` and `/anthropic-mcp` to
  `mcp-proxy.anthropic.com`, the host Claude Code's claude.ai connectors call. A
  machine request on either is checked in this order, on the full pathname
  (never the record's cut one) and before any credential read:
  1. `machine-origin` (above);
  2. the method floor: `TRACE`, `TRACK` and `CONNECT` get 403 `denied` (reason
     `denied:method`). The forwarder refuses `TRACE`. The model listener answers
     a `CONNECT` itself (any target form) with the same marked 403, records it
     and closes the connection; no tunnel opens. Node's parser rejects `TRACK`
     before any handler with its own 400 (owner-approved exception D-PR3-7):
     nothing is recorded, no line is written, no credential is read and no
     upstream is contacted. No `clientError` hook parses it;
  3. the canonical-path rule: the pathname starts with `/`, has no empty, `.` or
     `..` segment and no raw `\`, `#` or `;`, and every `%` begins two hex
     digits that do not decode to a letter, digit, `-`, `.`, `_`, `~`, `/`, `\`
     or `%`. Anything else gets 403 `non-canonical-path`. Raw fragment and
     semicolon suffixes cannot disguise a floor endpoint; enforcement always
     reads the full raw pathname;
  4. the deny floor: 403 `denied` (reason `denied:<id>`) for each entry below,
     case-folded, the entry itself and every path under it. A sibling such as
     `/api/oauth/usage` only shares a prefix and is not covered. `<uuid>` is any
     one segment. These mint, exchange or revoke credentials, or manage an
     organisation's keys and members, which no harness on a machine needs:

     | Id                   | Path                                   |
     | -------------------- | -------------------------------------- |
     | `v1-oauth`           | `/v1/oauth`                            |
     | `oauth-token`        | `/api/oauth/token`                     |
     | `oauth-authorize`    | `/api/oauth/authorize`                 |
     | `oauth-revoke`       | `/api/oauth/revoke`                    |
     | `cli-create-api-key` | `/api/oauth/claude_cli/create_api_key` |
     | `v1-org-api-keys`    | `/v1/organizations/api_keys`           |
     | `v1-org-x-api-keys`  | `/v1/organizations/<uuid>/api_keys`    |
     | `org-x-api-keys`     | `/api/organizations/<uuid>/api_keys`   |
     | `v1-org-invites`     | `/v1/organizations/invites`            |
     | `v1-org-users`       | `/v1/organizations/users`              |
     | `v1-org-x-invites`   | `/v1/organizations/<uuid>/invites`     |
     | `v1-org-x-users`     | `/v1/organizations/<uuid>/users`       |
     | `org-x-invites`      | `/api/organizations/<uuid>/invites`    |
     | `org-x-members`      | `/api/organizations/<uuid>/members`    |
     | `api-auth`           | `/api/auth`                            |

  5. the mode, set by the edge's `--machine-paths permissive|strict` (permissive
     when absent; another value is a usage error). Permissive forwards every
     other method and path. Strict forwards only the listed templates and
     refuses the rest 403 `forbidden`.

  The listed templates are the calls Claude Code was seen to make (`:uuid` a
  lower-case 8-4-4-4-12 UUID, `:slug` 1 to 128 of `A-Za-z0-9._-`, never `.` or
  `..`). On `/anthropic`: `POST /v1/messages` and `/v1/messages/count_tokens`;
  `POST /api/oauth/validate`; `GET /api/oauth/usage`; `GET`
  `/api/claude_cli/bootstrap`, `/api/claude_code_penguin_mode`,
  `/api/claude_code/policy_limits` and `/api/claude_code/settings`;
  `GET /api/organizations/:uuid/model_selector/cc`; `GET` under
  `/api/oauth/organizations/:uuid/`: `marketplaces`, `plugins/list-plugins`,
  `plugins/:slug/download`, `skills/list-skills` and `skills/:slug/download`;
  `GET /v1/mcp_servers`; `POST /api/artifacts/mcp`;
  `POST /api/event_logging/v2/batch` and `/api/claude_code/metrics`; `GET`
  `/api/directory/server-urls` and `/api/web/domain_info`; `GET`
  `/api/oauth/account/settings`, `/api/claude_code_grove`,
  `/api/oauth/organizations/:uuid/sync/github/auth` (a GitHub connection status,
  `is_authenticated` and `auth_source`; the GitHub token itself goes up by
  `POST /v1/code/github/import-token`, which is not listed) and
  `/v1/ultrareview/quota` (Claude Code 2.1.328, Task-1437); and the literal
  `POST /api/eval/sdk-zAZezfDKGoZuXXKe`, a feature-flag key compiled into the
  observed Claude Code build, which a new build may change (strict mode then
  refuses it until the list follows). On `/anthropic-mcp`: `POST /v1/mcp/:slug`.
  Bodies, queries and headers stay opaque in both modes: the rules read only the
  method and pathname.

  A lease-shaped bearer on a token route is the lease path, unchanged: engine
  and server leases reach only their exact lists (`/anthropic-mcp` has none),
  and their records are not marked.

- **Machine lease.** At most one live per (client, account), granted when a pin
  or a fresh selection (below) first lands there and saved in `leases.json`. It
  has no TTL. It ends when the machine is revoked, the account is removed, or no
  pin of that client uses the account any more and no fresh request holds it
  (the sweep). A grant that cannot be saved refuses that request (500) and the
  gateway keeps serving.
- **Pools and pins** (`gateway/machinePool.ts`). Usable: a login account of the
  client's user, of the route's provider, enabled and not needing a login.
  Eligible: usable and not benched. Ranking is Pandeck's
  (`docs/account-routing.md` "Gateway machine pools") with usage unknown.
  - A pin is keyed by (client, provider, SHA-256 of the session key). The key is
    the first of these headers present: `x-claude-code-session-id` on
    `/anthropic`; `session-id`, then `x-opencode-session-id` on `/chatgpt`. A
    repeated, empty or over-256-character value counts as no key, and the
    request uses the client's per-provider pin; a later header is not tried.
    Repeats are read from the raw fields, which the relay keeps. The body is
    never read.
  - `machinePins.json` holds key hashes, account ids, tried sets and last use,
    never a key. It is saved on every pin change, and at most every 10 minutes
    for use alone; a failed save is logged and memory stays in force. An
    unreadable file starts empty, and sessions re-pin.
  - A pin idle 7 days is dropped, and a client keeps at most 1,024 (least
    recently used first). Revoking the machine drops its pins.
- **Fresh selection.** A token-route request that is not a model run
  (`POST /anthropic/v1/messages`) and carries no session key (account, usage,
  `count_tokens`, MCP and other calls) picks an account as a new pin would, but
  writes no pin, saves nothing and runs no sweep. It holds its account's machine
  lease from the pick until its record is written, an upload still pending
  included, so a sweep in between keeps the lease. A re-select (step 4 above)
  takes the new hold before it drops the old one. With a session key, such a
  request uses that session's pin as before.
- **Stickiness.** A pin moves only when its account cannot serve: it is unusable
  (removed, disabled, needs a login, no longer the user's) or has a long limit.
  It never moves for ranking, or because an account it left recovered: the
  provider's prompt cache stays on one account.
- **Limits.** Each model-run answer (`POST /anthropic/v1/messages`,
  `POST /chatgpt/backend-api/codex/responses`) from any lease kind is evidence;
  the route decides, so the same path on `/anthropic-mcp` is not. Usage, credit,
  consume, `count_tokens`, account and MCP answers are not: they never bench,
  clear a bench or move a pin. A 2xx clears the account's bench. A 429 passes
  through unchanged, every header field and repeat included (gateway and relay
  drop only hop-by-hop, `proxy-*` and `set-cookie` fields). The decision reads
  only the upstream's raw headers, never a body.
  - On `/anthropic` a 429 is a limit only when Anthropic states one:
    `anthropic-ratelimit-unified-status: rejected` or a valid `retry-after`,
    each sent exactly once. Any other 429 is no evidence: no bench, no tried
    mark, no pin move, and an existing bench stays as it was. Anthropic answers
    a subscription request that lacks Claude Code's system prompt (Claude Code's
    startup `quota_check` probe) with such a bare 429 (Task-1428). Every
    `/chatgpt` 429 is evidence.
  - A limit is classified by its stated reset: `retry-after` sent exactly once
    (whole seconds or an RFC 9110 HTTP-date), else the route's own reset: on
    `/chatgpt` the latest valid `x-codex-{primary,secondary}-reset-at` or
    `-reset-after-seconds`, on `/anthropic` `anthropic-ratelimit-unified-reset`
    (epoch seconds, sent exactly once), so a weekly limit benches until its real
    reset.
  - Now or past: short, with no bench.
  - Up to 60 s away (`MACHINE_SHORT_LIMIT_MS`, inclusive): short. The account is
    benched until then and new sessions avoid it; the session keeps its pin and
    tried set, so the harness's retry lands on the same account.
  - Further, or no valid reset (benched 5 minutes): long. The account joins the
    session's tried set and the pin moves at once, saved, to the best eligible
    account outside that set. With none, the pin stays and later 429s pass
    through.
  - A later 429 never shortens a bench; a long one makes a short one long. A
    pinned account with a long bench from another session or the lease path
    moves the pin before the request. Benches live in memory, so a restart costs
    at most one extra 429 per account; pins and tried sets persist.
  - A sustained run of short 429s keeps a session on its account until the
    harness gives up; that is the price of cache stickiness.
- **Recovery from an unusable account,** in order: the best eligible untried
  account; else the best eligible tried one (a return, allowed only because its
  bench has ended); else the best usable untried one, benched, whose answer
  passes through. Else, if usable accounts remain (all tried and benched), 429
  `machine-session-limited` with `retry-after` the whole seconds until the first
  of their benches ends; the session returns there once it does. With no usable
  account, 403 `machine-pool-empty`. A returned-to account stays tried, so a 429
  there never sends the session back again. After a restart the benches are
  gone, so a return can come one bench early.
- **Refusals.** Marked and provider-shaped, the provider named from the route:

  | Case                      | Status | Text after "Pandeck gateway:"                                                                                |
  | ------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
  | `machine-pool-empty`      | 403    | no <Claude\|OpenAI> account is available to this machine's user. Add or log in to one on the gateway's page. |
  | `machine-session-limited` | 429    | every <Claude\|OpenAI> account this session can use is rate-limited; retry later.                            |
  | `machine-origin`          | 403    | model access from this machine is for local tools only.                                                      |
  | `machine-retry`           | 503    | this machine's account changed while the request waited; retry.                                              |
  | `duplicate-rid`           | 409    | this relay request was already recorded.                                                                     |

  | `denied` | 403 | model access from this machine never covers this request. |
  | `non-canonical-path` | 403 | model access from this machine needs a
  canonical path (no empty, dot or encoded-unreserved segments). |

  The vault's needs-login 401 never reaches a machine request: a dead login is a
  changed selection. A 401 from `mcp-proxy.anthropic.com` passes through and
  never forces a token renewal; one from `api.anthropic.com` does, as before.

- **Logs.** Every forward line on a client's port names
  `kind=<engine|server|machine>` and `client=<id>`, and every forward line
  includes `outcome=<outcome> via=gateway` ("Request log"), followed by its
  relay id or fixed id diagnostic when supplied. No line holds the placeholder,
  a session key or its hash, a token, a query or a body; only a request record
  holds the session tag, and no line holds a client's own header text (the
  first-client `user-agent` line is the loopback listener's only). A failure
  while recording an answer (a registry read, a pin save) is logged with a fixed
  line and never changes the answer.
- **Encrypted reasoning.** After a move between accounts, a Codex, pi or
  OpenCode conversation that carries encrypted reasoning may be refused by the
  new account. Pandeck rewrites history on the driver side for its own sessions
  (`sessionAccountSwitch.ts`); the gateway never edits a body, so the user
  starts a new session.

#### Request log

Every model request on a client's port gets one structured record and one log
line (Task-1430 PR1, `gateway/requestLog.ts`), whatever its ending: forwarded,
refused locally, unreachable, cut off after the headers, or closed by the
client. The forwarder's once-guard (`Trace.end`) writes both, so a request that
ends twice records once. That includes `/mcp` and the client listener's own
refusals: what the listener answers itself it hands to the forwarder's
`observeLocal`, which records once when the answer closes; everything else goes
to `handleRequest`, never both. From admission the request's own `close`
listener owns its end: a client that closes during the credential wait is
recorded `failed` at once, and a credential, refusal or error that settles later
writes no answer, no second record and contacts no upstream.

- **Record** (`GatewayUiRequest` in `shared/gatewayUi.ts`): `seq` and `epoch`;
  `at`; the client's `{id, label}`; `listed` (PR3, token-route machine requests
  only, set at admission so an early refusal carries it too: whether the method
  and path match a listed template); `via` (`gateway`; the relay, PR2, adds
  `relay` with its `rid`; on the model port PR2a adds the validated `rid` to the
  `AdmittedClient` that `clientListener.ts` `serveModel` builds, and
  `forward.ts` `startTrace` copies it into the entry; PR1 sets none); `host`
  (the route's upstream, `""` when none matched), `method`, `path` (pathname
  only, cut to 200 characters) and `pathKey` (on a token-route machine request
  the matched listed template, else the pathname), both without query or
  fragment text; `status` (what the client was answered, `null` if none);
  `outcome` and `reason`; `account` (the registry name, set only once the lease
  is the client's own or the pool picked it); `session` (the first 12 hex of the
  session key's SHA-256, provider routes only); `clientCredential` (`none`,
  `placeholder`, `lease`, `mcp-token` or `other`, from `authorization`,
  `x-api-key` and `proxy-authorization`, every repeat, the most sensitive
  winning in that order; by shape only: `mcp-token` is `pgmcp_` and 43 base64url
  characters, the form of a client's MCP token, so a devbox's `/mcp` calls are
  not `other`, which stays for unexpected credentials; `requestCredential.ts`,
  and the relay's copy) and `clientCookie`; `requestBytes` (body bytes read from
  the client, 0 for a refusal), `responseBytes` (body bytes sent to the client,
  a refusal's body included, but 0 when HTTP suppresses the body for HEAD, 1xx,
  204 or 304), `durationMs` (nonnegative integer elapsed time from a monotonic
  clock, while `at` remains wall-clock time); `firstSeen`. A forwarded body
  passes one counting Transform each way, lengths only. On a gateway forward, an
  early upstream reply is delivered immediately, but its record waits for upload
  finish too; a later upload abort/error is failed, and a peer that stops
  reading before upload finish settles that failed lifetime rather than leaving
  a pending record. A relay-observed row is recorded at the answer instead
  ("Reporting" under the relay's observed hosts): its `requestBytes` is the body
  bytes read before the answer, which depends on the runtime's buffering under
  backpressure, and never exceeds what was read. No record holds a header value,
  credential, lease token, query, body or raw session key: the log copies only
  these fields. For every producer, gateway and relay alike, paths in records,
  text lines and persisted first-seen identities omit everything from the first
  `?` or `#`: the relay cuts its reported path there before escaping and capping
  it (Task-1435), on every ingress and refusal, observed hosts and upgrades
  included. Only the forwarded target keeps them.
- **Outcomes.** `forwarded` with the upstream's status; `refused` with the
  refusal case as `reason` (a WebSocket upgrade's is `upgrade`); `failed` with a
  Node error code, `unreachable`, `upstream-truncated` (after the headers,
  status kept) or `internal-error`. A client that closes before its answer ended
  is `failed` with `reason=client-closed`, its status kept once headers were
  sent (`null` before), never a success. Forwarder-owned refusals also wait for
  response `finish`; a pipelined reply queued without a socket has sent no
  status. Completed marked refusals keep their reason even at 503; status-only
  5xx mapping applies to adapter answers, not marked gateway refusals.
  `observed` and `overflow` are the relay's: `observed` is an observed-host
  request (Task-1430 PR4) with the upstream's status, any status, plus a reason
  only when its lifetime was cut ("Interception" above).
- **Answered by the edge.** `/mcp` and the listener's refusals have `host` `""`
  and no account or session. A `CONNECT` is recorded `refused` with
  `denied:method` (403), `forbidden` for an inactive client, or
  `registry-unavailable` (503). A repeated relay id instead gets a marked 409
  `duplicate-rid` and only the duplicate diagnostic line, without a new record.
  An origin-form target on a token route keeps its route's host, path and
  marking. Display paths omit query and fragment text; authority-form targets
  cut both before stripping userinfo, so an `@` in either suffix is never
  mistaken for userinfo. Origin-form path `@` stays. A request the HTTP parser
  rejects (such as `TRACK`) reaches no handler and is not recorded.
  `requestBytes` counts the body's `data` chunks whoever reads them (`req.emit`
  is wrapped, so the handler's reads are unchanged), `responseBytes` what the
  handler wrote; lengths only. A completed gate refusal is `refused` with
  `mcp-origin` (403) or `mcp-token` (401) and counts no body. Completion is the
  response's `finish`, not an `end()` call with output still queued. A completed
  answer is classed by status: below 400 `forwarded`; 4xx `refused`
  (`bad-request` 400, `method-not-allowed` 405, `too-large` 413, else
  `client-error`); 5xx `failed` (`internal-error` 500, `timeout` 504, else
  `server-error`). A close before completion is `failed` even for 4xx, status
  `null` before headers: `aborted` when the handler destroyed it, else
  `client-closed`. No tool name, JSON-RPC method or other content is recorded.
- **Line.** Today's forward line plus `outcome=` and `via=gateway`; no session
  tag. A request without a resolved client gets the line only, including the
  loopback listener. On an already-authenticated model socket, a fresh registry
  read failure (`refused registry-unavailable 503`) or inactive client
  (`refused forbidden 403`) retains the cached identity for attribution only.
  That cache never authorizes forwarding; current registry admission still
  decides whether the request may proceed.
- **Retention.** A ring of the last 5,000 records of all users, in memory, and a
  random `epoch` per start: a restart empties it and old cursors mean nothing.
  `firstSeen` marks the first record for a host, method and `pathKey`; those
  identities (and nothing else) persist in `stateDir/seenRequests.json`, capped
  at 4,096. Past the cap a new identity is flagged but not stored, with one log
  line. Memory stays bounded: the unstored identities remembered in memory are
  capped at 4,096 too, so past that a repeat may be flagged again. An unreadable
  file starts empty.
- **Reads.** `RequestLog.since(userId, epoch, afterSeq, limit)` answers the
  user's records after `afterSeq` in `epoch`, oldest first, at most min(limit,
  500), from the oldest kept when the epoch is absent or another. The page reads
  it through `GET /api/requests` ("The gateway's sign-in and UI"), the user only
  from the session.

#### Tools on the edge

The edge runs integration tools for its clients' users (Task-1397, M22): a tool
host and a standalone MCP endpoint, three Jira read tools: `jira_get_issue`,
plus `jira_search_issues` and `jira_lookup` (Task-1439), four Slack read tools:
`slack_search`, `slack_conversation_read`, `slack_thread_read` and
`slack_unread` (Task-1454), and one Jira write tool, `jira_mutate_issue`
(Task-1463).

- **Host** (`gatewayTools/`, loaded only by the edge's composition
  `gatewayEdge.ts`, which both edge entries run): one module per tool
  (`descriptor.ts`: name, schema, `effect` read or write, action key,
  integration), registered by one line in `tools.ts`. `host.call` checks
  arguments against a closed schema, settles by its deadline (30 s, unless the
  tool sets its own `deadlineMs`) or the caller's abort whatever an await inside
  ignores, and answers the tool's JSON or a fixed failure (`unknown_tool`,
  `invalid_params`, `tool_error`, `result_too_large`, `timeout`, `cancelled`,
  `failed`). A tool gets the deadline's epoch ms as `ctx.deadlineAt`. For a
  write tool the `timeout`, `cancelled`, `failed` and `result_too_large` texts
  say some changes may have been applied, so check before retrying. Only
  edge-owned `ToolError` text reaches a caller; any other error's message is
  dropped unlogged. The two exceptions are Jira's own reasons for a rejected
  `jira_search_issues` (D4) and `jira_mutate_issue`'s vetted texts (D-W2), both
  below and in ADR-0005. Both drop a text holding an authorization marker or any
  whole form of the call's secret. The write tool also treats any 16-character
  piece of a secret form, anywhere inside a string, as secret: in a text each
  marker, form or piece reads `[redacted]` so the agent sees that something was
  removed, and a key or link holding one is dropped. A cut never splits a
  placeholder: a text cut through one, or past one, ends `[redacted]…`. The
  string as it leaves, cut and with its ellipsis, is checked again, raw and in
  both JSON escapings it travels in (the result, then the `/mcp` body or
  `tools.call` frame); one that still carries material becomes a fixed text, and
  a serialized answer that does keeps only each row's operation and outcome. No
  string of its answer carries one (`upstreamText.ts`). Accepted limit: a
  credential whose secret form equals, or is contained in, the answer's fixed
  scaffold (the `[redacted]` placeholder, the JSON keys and structure, and the
  fixed fallback texts) cannot be withheld from the answer. Provider-shaped
  credentials (Atlassian API tokens, OAuth access tokens) cannot take that shape
  and are unaffected. `gateway/` holds no tool code or package: it takes the
  tools as `EdgeTools` (`gateway/edgeTools.ts`, types only) through
  `startGateway`'s `tools`, and the vault process never loads them. Without them
  `/mcp` is an unknown path and the integration methods answer
  `tools_unavailable`; the packaged entry wires none yet (D1). The closed schema
  covers strings (`maxLength`, `pattern`, `enum`), booleans, integers with a
  range, finite numbers, arrays of strings (with an item `enum`), closed nested
  objects (`additionalProperties: false`) and arrays of them, `minItems` and
  `maxItems` on arrays, a string or `null` (exactly
  `anyOf: [{type: "string"}, {type: "null"}]`), and an opaque `{type: "object"}`
  passed to the tool as given and never descended into (Task-1463). `default`
  applies only at the root. Its types (`descriptor.ts`) keep these branches
  mutually exclusive; an unknown keyword is refused only in a literal checked
  with `satisfies ObjectSchema`. A refusal names the property by its schema path
  (`items[0].labels`), never a value or a key the caller sent.
- **Jira search and lookup** (Task-1439). `jira_search_issues` and `jira_lookup`
  run the same read path as the local tools (`jiraSearch.ts`, `jiraLookup.ts`,
  `jiraSprintLookup.ts`, `jiraFields.ts`, `jiraRead.ts` beside `tools/jira/`,
  which wraps them) with the same schema and description objects, so the payload
  text is the same for the same Jira answers. The edge keeps no disk cache: each
  call reads the field list or the issue link types it needs. Every request
  carries the call's signal and a paging loop stops once it aborts. Known
  difference from local (D5): a result over the host's 60,000 characters answers
  `result_too_large`, where the local tool answers it whole. Input refusals are
  fixed texts that hold no input value (for example "No Jira board shows that
  project."). Jira's answers map by status: 401 or 403 is the credential remedy
  for the credential's kind, any other status "Jira answered HTTP `<status>`."
  The one exception (D4, ADR-0005) is a 400 to the search request itself
  (`POST /rest/api/3/search/jql`; not the field list, not `jira_lookup`): it
  answers "Jira refused the search (HTTP 400): " and Jira's own reasons, the
  string items of `errorMessages` then the string values of `errors`, joined by
  "; ". Those reasons may quote the user's JQL, field names or a URL Jira chose
  to mention. Before anything else, the whole raw reasons are checked: if any
  holds the call's API token, its Basic value (padded or not), the OAuth access
  token, or `authorization`, `bearer ` or `basic ` in any case, all are dropped.
  Without reasons the answer is "Jira refused the search (HTTP 400); check the
  JQL, and resolve project, user and field names with jira_lookup." Control
  characters become spaces and the text is capped at 500 characters. No other
  part of Jira's body reaches the caller. Over OAuth, `jira_lookup kind=sprints`
  needs Jira Software scopes the gateway does not ask for yet, so Jira refuses
  it until they are added (Task-1439 D3).
- **Jira mutation core** (Task-1463). The prepare (`jiraMutate.ts`) and apply
  (`jiraMutateApply.ts`) halves of `jira_mutate_issue`, with `jiraRank.ts`,
  `jiraSprint.ts`, `jiraPermissions.ts` and the typed errors in
  `jiraMutationErrors.ts`, sit beside `tools/jira/`, which wraps them with its
  settings, caches and approval card. The edge's `jira_mutate_issue` uses them
  too (below). Server state arrives as injected deps: the field list, link
  types, user names, `describeError`, `matchesHttpStatus` and apply's
  `stopBefore`. The display types are the import-free
  `@assistant/shared/jiraMutation` leaf, and the ADF converter brings the three
  Markdown packages. A caller decides by type and status alone:
  `JiraMutationError` is the core's own text, `JiraWriteHttpError` (an
  `AtlassianHttpError`) a rejected write, and a failed read stays
  `AtlassianHttpError`. A rank 207 takes the worst failed entry's status (5xx,
  then 401, then 403, then the highest 4xx) and carries Jira's reasons only when
  every failed entry is a 4xx other than 401/403. Every request carries the
  caller's signal when there is one. Cancellation is classified by signal state;
  when aborted, the caught error is rethrown unchanged, never becomes a row or
  step error, and no request follows it. Without a signal every call keeps the
  exact arguments the local tool always sent; locally only user naming carries
  the tool call's signal, as before.
- **Jira write** (Task-1463). `jira_mutate_issue` (effect `write`, action key
  `jira:write`, `readOnlyHint: false` on `/mcp`) runs the same core as the local
  tool with the local schema's exact structure. Three schema descriptions and
  the tool description differ: no approval card follows, since the client's own
  approval of the call is the user's consent, and Jira changes as soon as the
  call runs. One call prepares and applies with the calling user's credential,
  uncached, and every request carries the call's signal. Its deadlines come from
  the client's measured limit: Claude Code ends an HTTP MCP tool call at 60 s
  (2026-11-21). The tool's own deadline is 45 s, and `/mcp` ends the exchange by
  50 s. Prepare must finish 22 s before the deadline, so it has about 23 s; past
  that, or settling at that instant, the call answers "Preparing the changes
  took too long; nothing was written to Jira. Send fewer items or fewer issues
  per item." and writes nothing. Its timer is cleared when prepare ends, and a
  fence before apply checks the clock again. Apply runs on the call's signal
  alone. It starts no further item once less than 7 s remain, and those items
  answer "Not applied: the call ran out of time before this change; nothing was
  sent for it." Failures follow D-W2: the core's own text (1,000 characters),
  the credential remedy for 401 or 403, Jira's reasons for a rejected write's
  other 4xx (500 characters) or "Jira refused the change (HTTP n).", "Jira
  answered HTTP n." for a read or a 5xx, the read refusals' fixed texts, and
  otherwise "The request to Jira failed; the change may or may not have been
  applied." A refusal in prepare adds " Nothing was written to Jira."; when
  every item fails, the answer is the core's summary of them (2,000 characters).
  The result is `{summary, url?, warnings?, items}`, each item
  `{operation, issueKey, ok, url?, createdKey?, warning?, error?}`. Texts are
  vetted, with any secret piece shown as `[redacted]`, capped (summary 4,000, 20
  warnings of 300, item error 800, warning 500) and kept well-formed. A key must
  match `^[A-Z][A-Z0-9_]*-[1-9][0-9]*$` (64 characters) or is `null`. A link
  must be backed by a valid key, lie under `https://<site>/`, be at most 300
  printable ASCII characters without `"` or `\`, and neither it nor any of up to
  three successive percent-decodings may hold the secret; otherwise it is
  omitted, so a sprint item, which has no key, shows no link. The serialized
  result stays under 55,000 characters, shrinking warnings, then item texts,
  then the summary, then links, never a row's outcome. An interrupt does not
  stop the call: Claude Code's Esc sends `notifications/cancelled` on a separate
  POST, which the stateless endpoint answers 202 without reaching the call, and
  keeps the call's own request open until its 60 s limit. An interrupted write
  therefore keeps running until it completes or reaches its 45 s deadline: Esc
  never reaches the call's `ctx.signal`, because the stateless handler cannot
  connect that separate `notifications/cancelled` POST to the call. So after a
  timeout or interrupt, reconcile only after that window: wait 60 s before
  reading the issues or retrying. Pandeck's client mode still drops write tools
  from a listing.
- **Slack reads** (Task-1454). The four tools run the same read path as the
  local ones (`slackRead.ts` with `slackMetadataCache.ts` beside `tools/slack/`,
  which wraps them) with the same schema and description objects, action key
  `slack:read`, and the Slack access view the vault answers for the calling user
  (Task-1452). The token goes only to `https://slack.com/api/<method>` as
  `Authorization: Bearer`, redirects refused. Dates and times use the user's
  Slack profile zone (`users.info`), UTC when the profile has none; listings
  default to 20 results. Metadata (users, conversations, user groups) is cached
  in process memory per `teamId:userId` from the vault's view, never from input:
  an entry answers for 5 minutes, and a bundle is dropped on the first cache
  access after it expires or when a 33rd Slack user evicts the least recently
  used one (at most 10,000 users each). Never on disk, never logged.
  `slack_unread` reuses the caller's conversation list for 60 s (local: never),
  so an unread call within a minute of a list fetch may show read markers that
  have since moved. Slack counts rate limits per app, method and workspace, so
  every gateway user shares the gateway app's budget (`conversations.list` is
  Tier 2); a second user's `slack_unread` within a minute can be refused.
  Failures are fixed texts holding no input, Slack code or body: input refusals
  use the local wording without the value, ambiguity names no candidate, a
  rejected token (`invalid_auth`, `token_revoked`, …) is the reconnect text,
  `missing_scope`, a missing conversation or thread each have their own text, a
  rate limit names the method and, from a valid `retry-after`, the seconds
  ("Slack is rate-limiting conversations.list; retry after 30 seconds."),
  otherwise "Slack refused `<method>`.", "Slack answered HTTP `<status>`." or
  "Slack's answer could not be read." As for Jira (D5), a result over 60,000
  characters answers `result_too_large`.
- **`/mcp`** on the model port, reached by a harness through the box's relay at
  `http://127.0.0.1:<relay port>/mcp`: stateless Streamable HTTP with JSON
  responses, one fresh SDK server and transport per POST. The gate needs the
  client's certificate (as every model-port request), no `Origin` header (403),
  and `Authorization: Bearer <MCP token>` of that same client (401 otherwise).
  It never forwards, so a lease token opens no tool and an MCP token spends no
  lease. The adapter (`gatewayTools/mcp.ts`) owns the HTTP exchange: GET and
  DELETE answer 405; a JSON-RPC batch or an unsupported `mcp-protocol-version`
  400; a body over 1 MiB 413 as soon as it crosses the cap. Every JSON-RPC error
  the SDK answers is rewritten to a fixed text for its code, without `data`. The
  exchange is bounded at the longest tool deadline plus 5 s (50 s with
  `jira_mutate_issue`'s 45 s): then the call is aborted, the response ends 504
  with fixed text and the SDK instances close. A tool failure is an `isError`
  result with the fixed text; a client that goes away aborts its call.
- **MCP tokens.** `gateway:admin clients mcp-token <clientId>` mints one
  (`pgmcp_…`), prints it once and keeps only its SHA-256 on the client record,
  replacing an earlier one; `clients mcp-token-revoke <clientId>` removes it;
  `clients list` shows `mcp=yes|no`. Revoking the token or the client takes
  effect on the next request. The token identifies the client and so its user.
  The gateway's page mints, replaces and revokes a user's own clients' tokens
  over the same registry (Task-1405, below). A relay enrolled by either path
  brings its own token from enrollment (Client mode, MCP token at enrollment).
- **Integration credentials.** The user's Atlassian site, email and API token
  are entered in Pandeck's Settings → Jira or on the gateway's page (Task-1405,
  below; any `<name>.atlassian.net`), both through the edge's user-scoped seam
  (`gateway/userOperations.ts`), pass the edge once and are kept by the vault
  (`VaultPort.integrationPut/Get/Clear`, `gateway/vaultIntegrations.ts`), sealed
  when it has recipients. The site is Pandeck's deployment-configured
  `JIRA_HOST`, checked on the edge as a bare `<name>.atlassian.net` host at set
  and again at every decode. For each tool call the edge reads the calling
  client's user's credential from the vault and keeps nothing: no cache, no
  disk. The gateway hands tools typed outcomes (`ok`, `absent`, `rejected`,
  `locked`, `unavailable`), and `gatewayTools/toolCredential.ts` turns them into
  fixed tool errors (`rejected`: "Atlassian rejected the credential; reconnect
  Jira on the gateway's page."); a credential arriving after the call was
  aborted is dropped before any Atlassian request.
- **Atlassian OAuth records** (Task-1411, ADR-0005). The vault can also hold a
  user's Atlassian OAuth 2.0 (3LO) credential. It holds the confidential client
  (below), exchanges an authorization code itself (`integrations.connect`),
  picks the site from `accessible-resources` (the deployment's site, else the
  only one; entries are grouped by site host, and a site naming two ids is
  refused as ambiguous), and writes the record
  `{kind: "atlassian-oauth", v: 1, site, cloudId, refreshToken, scope}`, sealed
  like any record (`gateway/vaultIntegrations.ts`, `gateway/vaultAtlassian.ts`).
  A get answers the access view `{kind, site, cloudId, accessToken, expiresAt}`,
  refreshing first when no access token is cached or it expires within 5
  minutes. The refresh token and the client secret never leave the vault; access
  tokens live only in the vault's memory, so the first get after a restart and
  unlock refreshes. Atlassian rotates the refresh token on every use, so a
  refresh is single-flight per record, re-reads the record in its lane, and
  writes and seals the rotated record before it caches or answers anything;
  neither a refresh nor a connect follows a caller's signal. A refresh Atlassian
  refuses (400, 401 or 403 from the token endpoint) answers `rejected` and keeps
  the record until a reconnect or clear; any other failure answers `unavailable`
  and the next get retries with the same stored token. Every Atlassian call from
  the vault goes to the fixed `auth.atlassian.com` or `api.atlassian.com` (TLS
  name and `Host` fixed), follows no redirect, reads at most 64 KiB and is
  bounded at 8 s (`gateway/vaultHttps.ts`, shared with Slack); no answer, log
  line or refusal holds provider text, a token, a code or the secret. API-token
  records stay opaque and are answered verbatim; only connect creates an OAuth
  record, so an edge cannot plant a refresh token through a put (a put claiming
  either provider's record kind is refused). "Sign in with Atlassian" on the
  gateway's page starts every connect (Task-1411, "The gateway's sign-in and
  UI"); the edge hands the callback's code and redirect URI to the vault, which
  exchanges, picks the site and stores the record.
- **Slack OAuth records** (Task-1452, Task-1420 PR1). The vault holds a user's
  Slack user token with token rotation the same way, beside an Atlassian record
  of the same user (records are per user and integration). "Sign in with Slack"
  on the gateway's page starts every connect (Task-1453, "The gateway's sign-in
  and UI"). Connect (`gateway/vaultSlack.ts`):
  `POST https://slack.com/api/oauth.v2.access` with the client, code and
  redirect URI as form fields; only the answer's `authed_user` counts
  (`token_type: "user"`, header-safe access and refresh tokens of at most 8 192
  characters, `expires_in` a positive integer of at most a year, a `U…`/`W…`
  user id) with the top-level `team` id (`T…`); a top-level (bot) token is never
  read. No refresh token means rotation is off on the app: `rejected`, with the
  fixed log line "Slack granted no refresh token". With the deployment's `team`
  preset another workspace answers `team: "mismatch"`. Then
  `POST https://slack.com/api/auth.test` with the new token as Bearer must name
  the same team and user and an `https://<workspace>.slack.com/` (or
  `.enterprise.slack.com`) URL, whose host is kept. The record is
  `{kind: "slack-oauth", v: 1, teamId, teamName?, workspaceHost, userId, refreshToken, scope}`;
  a get answers the access view
  `{kind, teamId, teamName?, workspaceHost, userId, scope, accessToken, expiresAt}`
  and refreshes by the Atlassian rule (5-minute margin, single-flight, written
  and sealed before cached or answered). A refresh succeeds only with a
  top-level `token_type: "user"` answer carrying a new refresh token unlike the
  stored one: Slack has already consumed the stored token, so an `ok: true`
  answer without a usable replacement (missing, empty or unchanged refresh
  token, another `token_type`, tokens nested under `authed_user`) writes and
  caches nothing, answers `unavailable` and logs "Slack refresh answer
  unusable". Slack's protocol is documented but not yet observed against the app
  (owner decision, 2026-11-19), so every shape outside it fails closed; the
  first live sign-in is its first observation. Both calls classify alike: HTTP
  200 `{ok: false}` with `ratelimited`, `internal_error`, `fatal_error`,
  `service_unavailable` or `request_timeout`, HTTP 3xx, 429, 5xx, a network
  error, the deadline or an unreadable body are `unreachable` at connect and
  `unavailable` at refresh (the record kept, the next get retrying the same
  token); any other `ok: false` or 4xx is `rejected`. Only connect writes a
  Slack record: a put for Slack is refused, and a Slack record of another kind
  is malformed (`unavailable`).
- **Rotation recovery.** Sealing is best-effort, as for every vault writer: the
  rename can succeed while the seal fails (logged, the sweep retries), or the
  vault can die between the two. The rotated record then exists only in the
  tmpfs `accounts/` and is gone at restart; the sealed record holds the previous
  refresh token, which Atlassian still accepts within its 10-minute reuse
  interval and Slack within a "short grace period" (length undocumented). After
  that the provider answers `rejected` and the user connects again. A Slack
  refresh whose answer is unusable has the same outcome: within the grace period
  the next get's refresh may still succeed with the stored token, after it Slack
  refuses it and the user reconnects; it never counts as a success.
- **OAuth client config.** A remote vault reads its OAuth clients from
  `--integrations-config <file>` (`gateway/integrationClients.ts`), a regular
  0600 JSON file keyed by provider, `atlassian` and `slack`, each
  `{"clientId": "…", "clientSecret": "…"}`: both printable non-empty strings,
  other provider keys ignored, refusals fixed (naming the provider) and holding
  no value from the file. Without a provider's client its connect answers
  `notConfigured`. The edge's UI config may carry `atlassian.clientId` and
  `atlassian.clientSecret`, and `slack.clientId` and `slack.clientSecret`, each
  checked alone; what they do depends on where the vault runs, per provider
  (`gatewayEdge.ts` `integrationClientFor`): with the vault in the edge's
  process both or neither (half a client refuses the start with a fixed text
  before anything listens) and the pair goes to that vault; with a remote vault
  the edge keeps only the id, for the page's sign-in link, never passes or uses
  a secret, and logs one fixed line per provider at start while the file still
  holds one.
- **Bearer destinations.** On an OAuth view the tools call Jira with
  `Authorization: Bearer` at `https://api.atlassian.com/ex/jira/<cloudId>`
  (`atlassian/atlassianFetch.ts`; Confluence at `/ex/confluence/<cloudId>`, for
  a later tool), and the site makes only the browse URLs. The path must be
  site-relative (`/…`, not `//…`, no scheme, no backslash), the cloud id a
  lowercase UUID, and the final URL's origin and product and cloud-id prefix are
  checked after normalization, before any request; the site never chooses the
  destination. `atlassianDownload` follows the same rule and relies on fetch
  dropping `Authorization` on the cross-origin redirect to Atlassian's media
  host. An API token keeps its Basic calls to the site, absolute URLs included.
  The access token is decoded per call (site, cloud id, at most 8 KiB of
  printable token; any other `kind` is invalid) and never cached or written on
  the edge.
- **Client methods** (`gateway-client/1.0`, additive), always for the client's
  registry user: `integrations.set {integration, site, email, token}` checks the
  credential with Atlassian (`/rest/api/3/myself`, 15 s from the check's start)
  and stores it; `integrations.clear {integration}`;
  `integrations.status {integration, check?}` answers
  `{connected, kind?, connectWith, site?, email?, displayName?, accountId?, problem?}`,
  never a token: `kind` (`token` or `oauth`) whenever a record is stored, and
  `connectWith` how the gateway makes a new connection (`oauth` where the edge's
  UI config names `atlassian.clientId`, else `token`). An OAuth record has a
  site and no email, and a refused refresh is
  `{connected: false, kind: "oauth", problem: "rejected"}`; with `check` an
  OAuth record is checked with Bearer at `/rest/api/3/myself` on the fixed Jira
  base. Where `connectWith` is `oauth`, `integrations.set` is refused
  `integration_sign_in_required` ("This gateway connects Jira only with Sign in
  with Atlassian on its page.") before anything else, and an existing API-token
  record keeps working until it is replaced or cleared. Failures carry fixed
  codes and texts: `integration_invalid`, `integration_rejected`,
  `integration_unreachable`, `vault_locked`, `vault_unavailable`,
  `tools_unavailable`, `integration_busy`, `integration_sign_in_required`. One
  set, clear or connect runs per user and integration at a time, from any client
  or the gateway page (`userOperations.ts`); another of that integration
  meanwhile is refused `integration_busy` ("Another change to this credential is
  still running. Try again.") at once and changes nothing, so an earlier set can
  never land after a later clear. A status is never refused. Pandeck's Settings
  shows its own text for each code (`remoteIntegrations.ts`), `integration_busy`
  included.
- **Tool calls** (`gateway-client/1.0`, additive, Task-1398), the client's
  second adapter over the same host: `tools.list {}` answers `{tools}`, each
  `{name, description, inputSchema, effect, actionKey}`;
  `tools.call {name, args}` runs the host with the client's registry user's
  credential, read from the vault per call as `/mcp` does (a payload's `userId`
  is ignored), and answers `{ok: true, text}` or `{ok: false, code, message}` as
  a successful reply. A malformed name or non-object `args` fail the call with
  `invalid_params`; without tools both methods fail with `tools_unavailable`.
  The client's `cancel` frame and the connection's end abort the call. No
  argument or result is logged.
- **Pandeck in client mode** (`remoteIntegrations.ts`, installed by
  `gatewayClientLink.ts`): Settings → Jira sends a newly entered token with the
  email and `JIRA_HOST` through `integrations.set`, a clear through
  `integrations.clear`, and the connection test through
  `integrations.status {check: true}`; it writes only `enabled` to `jira.json`
  and leaves any old local email or token there untouched. Changing the email
  needs the token again; a clear wins over an email or token in the same patch.
  After every connect the link reads the status and announces the Jira section,
  so a restarted Pandeck shows connected. Settings reports
  `credentialStore: "gateway"`. Agents read Jira through the gateway's tools
  ("Gateway tools" under Client mode). Pandeck's non-agent Jira features
  (linked-ticket and Tempo enrichment, `isJiraConfigured`) have no credential in
  client mode until a later slice (D3, Task-1399). Against a gateway that
  answers `connectWith: "oauth"`, Settings reports `gatewaySignIn: true` and
  `gatewayKind`, shows no email or token field, and keeps enable with "Save and
  test" (only `enabled` is sent, then the connection test, which also runs when
  the card opens; no separate Test button) and Clear while a record is stored, a
  refused OAuth record included (a status naming a site or a `kind` counts as
  stored); a clear keeps the gateway's last `connectWith` until a later status
  says otherwise, also when that read fails. Users connect on the gateway's
  page.

#### The gateway's sign-in and UI

People sign in to the gateway itself in a browser, without a Pandeck instance
(Task-1402, M23). `gatewayWeb/` is edge-only: with `--ui-config <file>`, the
edge (`gatewayEdge.ts`: `gateway-edge.js` or `gatewayDevMain.ts`) starts an
HTTPS listener on `--bind-host` beside the client listener; without it nothing
changes. The mutual-TLS ports, the enrollment port and the vault are untouched.
The page is `app/web/gateway.html`, its own React entry, built by
`vite.gateway.config.ts` into `app/web/dist-gateway/` (`pnpm run build` builds
both bundles); under a top bar with the signed-in email and Sign out it shows
the user's Claude and ChatGPT accounts, Jira credential, Slack connection (where
the config offers "Sign in with Slack") and clients, and reaches only its own
origin with its session cookie. `pnpm --filter @assistant/web dev:gateway`
serves the page on port 5180 over a dev-only fake `/api` and `/auth`
(`app/web/gatewayDevApi.ts`, in-memory sample data, never in a build; the
default shows a deployment that signs in with Atlassian: the plugin also serves
its own `src/gateway/navigate.ts`, so "Sign in with Atlassian" goes to the dev
`/auth/atlassian/callback` instead of Atlassian and finishes a fake sign-in
without leaving localhost, "Sign in with Slack" likewise goes to the dev
`/auth/slack/callback`, `GATEWAY_DEV_GENERIC=1` shows the generic gateway with
the token form and no preset, and `GATEWAY_DEV_NO_SLACK=1` a gateway that does
not offer Slack).

- **Config.** One JSON file, refused unless mode 0600 (no group or other bits),
  so the client secret stays out of argv. Every refusal is a fixed message
  naming the field, never the file's content.

  ```json
  {
    "port": 443,
    "publicOrigin": "https://gateway.example.org",
    "certFile": "/etc/pandeck-gateway/ui/fullchain.pem",
    "keyFile": "/etc/pandeck-gateway/ui/key.pem",
    "oidc": {
      "issuer": "https://issuer.example",
      "clientId": "<client id>",
      "clientSecret": "<client secret>"
    },
    "allow": {
      "emailDomains": ["example.org"],
      "emails": [],
      "claims": { "hd": "example.org" }
    }
  }
  ```

  `port` defaults to 443 (a unit then needs only
  `AmbientCapabilities=CAP_NET_BIND_SERVICE`); `distDir` defaults to the
  checkout's `app/web/dist-gateway` under the source entries and to
  `gateway-web/` beside `gateway-edge.js` in the Bun package. `publicOrigin`
  must be `https://host[:port]` with no path, the issuer `https://` and exactly
  the provider's issuer string; the cert and key are the deployment's
  browser-trusted pair. The provider's client needs the redirect URI
  `<publicOrigin>/auth/callback`. A Google Workspace deployment, for example,
  uses `https://accounts.google.com` as the issuer, its domain in `emailDomains`
  and the `hd` claim. An optional
  `"atlassian": {"site": "team.atlassian.net", "emailFromSignIn": true}` fixes
  every user's Atlassian site and, with `emailFromSignIn`, binds the credential
  to the email the user signed in with; either may be given alone. With
  `atlassian.clientId` (the Atlassian OAuth 2.0 (3LO) app's id; Task-1411) the
  page connects Jira only with "Sign in with Atlassian" ("Atlassian sign-in"
  below); the client secret stays with the vault ("OAuth client config" under
  Credentials). `atlassian.scopes` overrides the scopes asked for: a list of at
  most 64, each 1-128 printable characters without spaces, duplicates dropped,
  refused with a fixed text naming only the field. Without it the gateway asks
  for `read:jira-work`, `write:jira-work`, `read:jira-user`,
  `read:servicedesk-request`, `write:servicedesk-request`,
  `read:confluence-content.all` and `write:confluence-content`; either way it
  adds `offline_access`, so the vault gets a refresh token. The Atlassian app
  needs the callback `<publicOrigin>/auth/atlassian/callback` and every scope
  asked for. An optional
  `"slack": {"clientId": "<Slack app's client id>", "teamId": "T…", "userScopes": […]}`
  (Task-1453) turns on "Sign in with Slack" with `clientId` ("Slack sign-in"
  below); without it nothing Slack shows, whatever else the section holds. The
  client secret stays with the vault ("OAuth client config" under Credentials).
  `teamId`, optional, is the deployment's workspace (`T` and 2-30 uppercase
  letters or digits, as `auth.test` names it): it goes to Slack as the authorize
  URL's `team` hint and to the vault's connect as `team`, where a grant for
  another workspace is refused. `userScopes` overrides the user scopes asked
  for: 1-64 names, each lowercase `[a-z][a-z0-9_.:-]` of at most 128 characters
  (so the comma join is unambiguous), duplicates dropped, refused with a fixed
  text naming only the field. Without it the gateway asks for `search:read`,
  `channels:history`, `groups:history`, `im:history`, `mpim:history`,
  `channels:read`, `groups:read`, `im:read`, `mpim:read`, `files:read`,
  `users:read`, `users:read.email` and `usergroups:read`, in that order, as user
  scopes only (never a bot `scope`). The Slack app needs token rotation on, the
  redirect URL `<publicOrigin>/auth/slack/callback` and every user scope asked
  for. An optional
  `"coder": {"googleClientId": "<Coder's Google client id>", "automaticApproval": true}`
  (Task-1410 PR2) turns on zero-click enrollment ("Zero-click enrollment" under
  Client mode): `googleClientId` is the OAuth client Coder signs its users in
  with, not the page's; `automaticApproval` is a required boolean, `false`
  keeping the id while browser approval stays the only way. No other key is
  taken (a Coder API token, for one, is refused), and the section is refused
  unless `oidc.issuer` is exactly `https://accounts.google.com`, since the users
  a proof finds or creates are Google identities.

- **Allow rule.** Admitted only when `email_verified` is the boolean `true`,
  `email` is a string whose lowercased address is in `emails` or whose domain is
  in `emailDomains`, and every `claims` entry equals that top-level claim
  exactly. A rule without emails and domains refuses to start. The rule runs
  before the registry sees the identity.
- **OIDC.** Authorization code with PKCE S256, `state` and `nonce`,
  `scope=openid email`, the client secret posted when discovery lists
  `client_secret_post` (Google refuses basic auth's form-encoded client id),
  else basic, on `oauth4webapi` 3.8.8 (exact in the catalog, imported only under
  `gatewayWeb/`). Discovery is cached for an hour, every provider call bounded
  at 10 s. The library checks state, `iss`, `aud`, `azp`, `exp` (30 s
  tolerance), the presence and type of `iat` and `sub`, the nonce and that an ID
  token came; the gateway adds the ID token's signature, an `iat` more than 30 s
  ahead and the allow rule above. Discovery must name exactly the configured
  `issuer` (the same string, no added slash), and the authorization, token and
  key-set endpoints it names must be `https`; anything else fails the sign-in as
  `discovery` before any redirect. The signature is checked against the
  discovered `jwks_uri` (`validateApplicationLevelSignature`). The gateway owns
  the key-set cache, and it is the only one (the library's own never answers): a
  set is read within 10 s and 64 KiB and kept only if it is a JSON key set (JSON
  media type, an object, `keys` a list of objects), so a maintenance page
  answering 200 never replaces it. A kept set serves for 5 minutes; a `kid` it
  lacks asks once for a newer one. One fetch is in flight per issuer, shared by
  every waiting callback, and the network is asked at most once a minute,
  whether the last fetch succeeded or failed. A failed or refused fetch keeps
  the last good set, which keeps its age; without one the sign-in fails as
  `keys`. A rotated key is therefore found at most a minute after the last
  fetch, and a `kid` the set lacks costs at most one fetch a minute however many
  callbacks carry it, and then fails as `signature`. `oidcTestOptions` (HTTP
  endpoints, a stub fetch) is reachable only through `startGatewayWeb`, never
  from the file.
- **Users.** Keyed by issuer plus subject; the email (lowercased) and the label
  are attributes. The first admitted sign-in of an identity creates a user with
  an opaque id (`u_` and 16 random characters, label = email); a later one
  updates the email (and a label that was the old email). An operator maps an
  existing user, such as a pilot's, with
  `gateway:admin user claim <id> --email <addr> [--ttl-minutes <n>]`: for a user
  without an identity only, used up by the first admitted sign-in with that
  email within its TTL (60 minutes unless given, at most 1,440), replacing an
  earlier claim on that user or email. All of it is one `clients.json` change
  under its lock; files of older builds load unchanged (`claims` absent is
  empty). Zero-click enrollment finds or creates users the same way, without a
  sign-in, but leaves a claim to the page's sign-in; a user it created is an
  ordinary user, and signing in later reaches it.
- **Sessions.** In memory: an edge restart signs everyone out. The cookie
  `__Host-pgw_session` (32 random bytes, kept as its SHA-256; `HttpOnly`,
  `Secure`, `SameSite=Lax`, `Path=/`) lasts 2 h idle and 12 h in all; the table
  holds 1,024 sessions and 16 per user (the oldest dropped). A sign-in waits at
  most 10 minutes, one of at most 256, under its random `state` and bound to the
  browser by `__Host-pgw_signin`; any callback naming the state uses it up.
  `POST /auth/logout` ends the session on the server. Each session has a random
  actor id (never the cookie or its hash) and is the actor of the logins it
  starts. Every way a session leaves the table (sign-out, idle or absolute
  expiry, the 17th session of a user) cancels its running logins; expired
  sessions are swept on every request and every 60 s, so their logins end within
  a minute without a browser request, and they cannot commit even before that.
- **Routes.** `GET /` (the page) and `GET /assets/<file>` (only files found at
  start; no path from a request reaches the filesystem); `GET /auth/login` and
  `GET /auth/callback`, which answers `303 /` with the session or
  `303 /?signin=denied|expired|failed|busy`; `GET /api/me` answers
  `{userId, email, label}` from the session only, or
  `401 {"error": "signed_out"}`, or `503 {"error": "unavailable"}`. Every
  non-GET/HEAD needs `Origin` equal to `publicOrigin` and `x-gateway-ui: 1`,
  else `403 {"error": "forbidden"}`; bodies above 1 KiB are refused (16 KiB on
  `/api/logins/input`, for Claude's pasted code), the limit chosen from the
  method and path before a byte is read. Every answer carries
  `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
  `nosniff` and `no-referrer`. The listener has the enrollment port's bounds (64
  connections, 10 s handshake, 5 s headers, 10 s request, 10 s socket idle).
  `/api/integrations/atlassian/set` takes 4 KiB (a valid credential exceeds 1
  KiB once JSON-escaped). While an `/api/integrations/*` route's adapter runs (a
  set: Atlassian's 15 s check, then the vault's 10 s write) its socket idles up
  to 30 s; the 10 s bound is back before the response, so keep-alive handling is
  as for every route. The wire shapes are `app/shared/gatewayUi.ts`.
- **Accounts and logins** (Task-1402 B2). Behind the session (else
  `401 {"error": "signed_out"}`), the user and the actor only from it:
  `GET /api/accounts` → `{accounts: [{id, provider, name, needsLogin}]}`;
  `POST /api/accounts/remove {accountId}` → 204, which does what
  `accounts.remove` does; `POST /api/logins/start {kind, accountId?, name?}` →
  `{loginId, accountId}`; `POST /api/logins/input {loginId, text}` and
  `POST /api/logins/cancel {loginId}` → 204;
  `GET /api/logins/read?login=<id>&cursor=<n>` →
  `{state, reason?, output, cursor, device?}`, the output from `cursor` on and a
  ChatGPT login's `device` once both its link and code are known. Refusals:
  `404 unknown_account` (not the user's), `404 unknown_login` (not this
  session's, or finished over 2 minutes ago, or past the 64 kept),
  `503 login_unavailable`, `400 bad_request`, `503 unavailable` (the registry).
  The routes call the same user-scoped seam as `gateway-client/1.0`, through a
  `GatewayWebAccounts` adapter in `gatewayEdge.ts` (`gatewayWeb/accounts.ts`),
  so take-over, slots and cleanup are the client protocol's (Client mode,
  Logins). The browser never gets a driver's or the vault's error text: a
  finished login carries only a reason, `failed`, `timed_out`, `superseded`,
  `unavailable` or `session_ended`, which the page turns into its own text. The
  page polls a login's read about once a second while its dialog is open and the
  login is not finished; it starts a login only on a click (Add or Log in),
  renders it in B1's `AccountLoginDialogView` and asks before Remove. Its Cancel
  shows "Cancelling…", and the dialog closes once that login ended cancelled; a
  login ended elsewhere keeps its notice.
- **Atlassian credential, clients and MCP tokens** (Task-1405). Behind the
  session, the user only from it (a body `userId` is ignored), over the same
  seam as `gateway-client/1.0`, through the `GatewayWebIntegrations` and
  `GatewayWebClients` adapters in `gatewayEdge.ts`
  (`gatewayWeb/integrations.ts`, `gatewayWeb/clients.ts`):
  - `GET /api/integrations/atlassian` →
    `{connected, kind?, connectWith, site?, email?, problem?, preset?}` with
    `kind` (`token` or `oauth`) whenever a record is stored, `connectWith`
    `oauth` where the config names `atlassian.clientId` (else `token`), and
    `problem` one of `vault_locked`, `vault_unavailable`, `invalid`, `rejected`
    (Atlassian refused an OAuth record's refresh; the record stays until a new
    sign-in or a clear); no live check. `preset` (`{site?, email?}`) is what the
    config's `atlassian` fixes, and in it the signed-in user's email; it is on
    every answer of this route and of a set. A set uses the preset's values
    whatever the request says, and a preset bound to the sign-in for a user with
    no email answers `503 unavailable`. The page shows no field for a preset
    value. `POST /api/integrations/atlassian/set {site, email, token}` checks
    with Atlassian (15 s from the check's start) then stores, as
    `integrations.set` does, →
    `{connected: true, kind: "token", connectWith: "token", site, email, displayName?, preset?}`;
    `POST /api/integrations/atlassian/clear` → 204. While a set, clear or
    sign-in callback's connect of the user's Atlassian credential runs (from
    this page, another tab or a client), another of them is refused
    `409 integration_busy` (a callback: `?atlassian=busy`) and changes nothing;
    the page itself never sends one while its own is pending. Each integration
    has its own slot: a running Slack connect never makes an Atlassian change
    busy, nor the other way round. The token is write-only: no answer carries
    it. Refusals: `400 integration_invalid`, `422 integration_rejected`,
    `502 integration_unreachable`,
    `503 vault_locked|vault_unavailable|tools_unavailable`,
    `409 integration_busy`, and where `connectWith` is `oauth`
    `409 integration_sign_in_required` before anything else: such a page shows
    no token form, and an API-token record stored earlier keeps working,
    labelled "API token", until a sign-in replaces it or a clear removes it.
  - **Atlassian sign-in** (Task-1411), only where the config names
    `atlassian.clientId` (else both routes are `404`):
    `POST /api/integrations/atlassian/connect {}` behind the session and the
    mutation gate → `{authorizeUrl}`, Atlassian's
    `https://auth.atlassian.com/authorize` with `audience=api.atlassian.com`,
    the client id, the scopes,
    `redirect_uri=<publicOrigin>/auth/atlassian/callback`, a fresh `state` (32
    random bytes), `response_type=code` and `prompt=consent` (no PKCE: the vault
    exchanges with its secret). The answer sets `__Host-pgw_atlassian`
    (attributes as the session cookie, 10 minutes); the state waits at most 10
    minutes, one of at most 256 (else `503 unavailable`), bound to that cookie
    and to the session's user. The state is in that `authorizeUrl` and nowhere
    else: no cookie, log line, refusal or redirect carries it.
    `GET /auth/atlassian/callback` takes the state first (one use, whatever
    follows), then needs the session (else `signed_out`), an unexpired entry
    (`expired`), the same cookie and user (`failed`), no `error` parameter
    (`access_denied` is `denied`, any other `failed`, its text never read) and a
    printable `code` of at most 2,048 characters (`failed`). Only then does the
    code go, with the same redirect URI and the preset `site` if any, to the
    vault's connect (`UserOperations.connectAtlassian`, one per user at a time
    with set and clear), while the socket idles up to 40 s (above the remote
    vault's 30 s connect bound; the 10 s bound is back before the answer). It
    answers `303 /` on success, else `303 /?atlassian=<code>` with `code` one of
    `rejected`, `unreachable`, `site_missing`, `site_ambiguous`,
    `not_configured`, `vault_locked`, `vault_unavailable`, `busy`,
    `tools_unavailable`, `signed_out`, `expired`, `failed`, `denied`; both clear
    the cookie and say `no-store`. A `vault_unavailable` may still have stored
    the record (the vault's unknown-result rule); the next status shows it. Log
    lines are `ui atlassian connect: started|ok user=<id>`,
    `refused, busy user=<id>` and `failed (<code>|state)[ user=<id>]`. The page
    reads `?atlassian=` once at load and removes it from the address; an unknown
    value is ignored, never shown. Signed in, the Jira section shows the code's
    fixed text until the user acts; signed out, only `signed_out` shows, on the
    sign-in card. Success is silent. Pending sign-ins are in memory, so an edge
    restart between start and callback answers `failed` or `expired`, and the
    user starts again.
  - **Slack sign-in** (Task-1453), the same flow with its own pending table,
    cookie and codes, so an Atlassian state never completes a Slack callback or
    the other way round. `GET /api/integrations/slack` →
    `{offered, connected, teamName?, problem?}`: `offered` is whether the config
    names `slack.clientId` (if not, the answer is
    `{offered: false, connected: false}` without a vault or tools call, and
    every other Slack route is `404`); `problem` one of `vault_locked`,
    `vault_unavailable`, `invalid` (the vault's access view did not decode),
    `rejected` (Slack refused the vault's refresh). `teamName` is the
    workspace's name as the vault holds it, answered only when it passes
    `isGatewayUiDisplayText` (1-256 UTF-16 units, not only whitespace, no
    control, format, surrogate, private-use or unassigned character, no line or
    paragraph separator), which the page's decoder applies again; never a token.
    Reading the status may refresh the token in the vault.
    `POST /api/integrations/slack/clear` → 204 (log line
    `ui integration slack: cleared user=<id>`), refused as the Atlassian clear.
    `POST /api/integrations/slack/connect {}` → `{authorizeUrl}`, Slack's
    `https://slack.com/oauth/v2/authorize` with `client_id`, `user_scope` (the
    scopes comma-joined), `redirect_uri=<publicOrigin>/auth/slack/callback`, a
    fresh `state` and, with `slack.teamId`, `team`; the cookie is
    `__Host-pgw_slack`, the table, bounds and state rule as Atlassian's.
    `GET /auth/slack/callback` checks as Atlassian's does, then hands the code,
    the same redirect URI and the configured `teamId` as `team` to the vault's
    connect (`UserOperations.connectSlack`). It answers `303 /` on success, else
    `303 /?slack=<code>` with `code` one of `rejected`, `unreachable`,
    `team_mismatch` (the grant is for another workspace than `slack.teamId`),
    `not_configured`, `vault_locked`, `vault_unavailable`, `busy`,
    `tools_unavailable`, `signed_out`, `expired`, `failed`, `denied`. Log lines
    are `ui slack connect: started|ok user=<id>`, `refused, busy user=<id>` and
    `failed (<code>|state)[ user=<id>]`; no workspace name, Slack text, code or
    state. The page reads `?slack=` once, independently of `?atlassian=`, and
    shows it in the Slack section (signed out, only `signed_out`, on the sign-in
    card); a connected record reads "Connected to <workspace>" or "Connected to
    your Slack workspace", and Disconnect asks first.
  - `GET /api/clients` → `{clients: [{id, label, createdAt, mcpToken}]}`, the
    user's clients that are not revoked, `mcpToken` a boolean.
    `POST /api/clients/code {label}` → `{code, validForSeconds: 900}`;
    `POST /api/clients/revoke {clientId}` → 204;
    `POST /api/clients/mcp-token {clientId}` → `{token}`, replacing an earlier
    one; `POST /api/clients/mcp-token/revoke {clientId}` → 204. Another user's
    client, a missing or a revoked one is `404 unknown_client`, alike.
  - `GET /api/requests[?epoch=<32 hex>&after=<seq>]` →
    `{epoch, requests: [GatewayUiRequest]}`, the session user's clients' records
    only ("Request log"); any other parameter, a `userId` included, is ignored,
    and a malformed cursor is `400 bad_request`. The page's Requests section
    reads it every 5 s while the page is visible, starts over when the epoch
    changes, keeps the newest 2,000 records and renders at most 200 rows. It
    marks `firstSeen` (New) and `listed === false` (Unlisted), and filters by
    either and by outcome.
  - Page bounds: a code is refused (`409 limit_reached`, nothing written) when
    the user has 4 unexpired codes, or when active clients plus unexpired codes
    reach 16, counted inside the registry's write lock. A pending code thus
    reserves a client's place: redeeming every code keeps the user within 16.
    Codes from the admin CLI count as pending, but the CLI's own issuance and
    redemption stay unbounded. One MCP token per client.
  - A revoke on the page takes effect at once, as the listener's own revocation:
    the client's protocol connections end, its mutual-TLS sockets (relay,
    `/mcp`) close, its running logins are cancelled and its leases revoked; its
    accounts stay with the user. The machine enrolls again with a new code or
    approval. The 250 ms poll still applies CLI revocations.
  - A code or MCP token exists outside its hash only in the answer that creates
    it (`no-store`): the page shows it once in a dialog with a Copy button and
    drops it on Done. Every secret travels in a POST body or its answer, never a
    URL. The page asks before every client revoke, every token revoke and a
    token replacement, and before clearing the credential; its token field is a
    password field, emptied once saved.
- **Enrollment requests** (Task-1410). A machine's link
  `<publicOrigin>/#enroll=<code>` carries the user code only in the fragment,
  which no browser sends. Before its first request the page moves the code to
  `sessionStorage` and clears the fragment with `history.replaceState`, so the
  code survives the sign-in round trip in that tab and is in no request line,
  redirect or log. Behind the session, the user only from it:
  `POST /api/enrollments/lookup {userCode}` →
  `{name, kind, from, createdAt, expiresAt}` of an undecided, unexpired request;
  `POST /api/enrollments/decide {userCode, approve}` → 204, approving for the
  session's user or denying. Refusals: `404 unknown_request` (unknown, decided
  or expired), `409 limit_reached` (an approval past the page bounds),
  `400 bad_request`, `429 rate_limited` with `retry-after`.
  - Budget (`gatewayWeb/enrollmentBudget.ts`, in memory, reset by a restart):
    lookup and decide share one per user, whichever session sends them, 10
    well-formed calls a minute and 60 an hour. Unknown codes across all users
    are capped at 120 an hour; past that every lookup and decide is refused for
    everyone until the oldest miss is an hour old. That bounds guessing the 20^8
    codes, at a cost: two signed-in users spending their misses block approvals
    for an hour. It does not protect against malicious signed-in users. Storage
    holds only users who called in the last hour.
  - The dialog shows the code to compare with the machine's, the name and kind
    labelled as the machine's own report, the source address, the request's age
    and expiry, and what approving gives: a client in the user's name with their
    accounts, Jira credential and the machine's MCP token. It decides only on a
    click of Approve or Deny; closing it decides nothing. Every outcome drops
    the stored code.
  - Phishing remains possible: anyone who reaches the enrollment port can start
    a request with any name and send its link. The code comparison, the labelled
    claims, the address, the age, the consequence text and the 10 minute expiry
    mitigate it.
- **Logs.** Only `ui sign-in: ok user=<id> (existing|created|bound)`,
  `ui sign-in: denied`,
  `ui sign-in: failed (discovery|exchange|keys|signature|claims|state|registry)`
  `ui sign-out: user=<id>`, `ui session end: login cancel failed`,
  `ui clients: code created user=<id>`,
  `ui clients: client <id> revoked user=<id>`,
  `ui clients: client <id> mcp token minted|revoked user=<id>` and
  `ui integration atlassian: set|cleared user=<id>`,
  `ui integration slack: cleared user=<id>`,
  `ui enrollments: request approved|denied user=<id>`,
  `ui enrollments: refused, budget spent|miss cap reached user=<id>` and
  `ui enrollments: miss cap reached`, and the sign-ins'
  `ui atlassian|slack connect: …` lines above, beside the login manager's own
  `login <id> (account <id>): <state>`; never an email, code, state, nonce,
  verifier, token, cookie, secret, query, pasted code, login URL, workspace name
  or output. Provider error text is never echoed. A reverse proxy in front of
  the page should not log query strings under `/auth/`: the callbacks carry
  one-use authorization codes and states there.
- **Packaged entry (Task-1401).** Both edge entries start the UI through
  `gatewayEdge.ts`, with a `GatewayWebUsers` adapter over the running gateway's
  own `ClientRegistry` and `GatewayWebAccounts`, `GatewayWebIntegrations` and
  `GatewayWebClients` adapters over its `userOperations`; the Bun package ships
  `dist-gateway` as `gateway-web/`.

### Remote vault

The vault can run as its own process on another machine (Task-1394, M20), so the
edge holds no refresh token. Renewal, the token files, the writer lane and the
login runs then execute in the vault process (`gateway/vaultServer.ts`); the
edge reaches it through `gateway/remoteVault.ts`, a `VaultPort` over
**`gateway-vault/1.2`** (`gateway/vaultMethods.ts`; any `1.x` peer links, and an
edge whose vault lacks `integrations.connect` (1.1) or Slack (1.2) gets
`unavailable` for it, so upgrade the vault first). `startGateway`'s `vault`
option selects it; without it the vault runs in the edge's process, as the
server's local gateway does.

- **Link.** Worker-protocol framing over mutual TLS. Each side has its own key
  and self-signed certificate and trusts exactly the other's, inside its dates,
  checked by its SHA-256 fingerprint once the handshake has proved the key and
  before any frame, not by a chain: Bun's TLS takes no self-signed leaf as its
  own anchor (ADR-0005). The edge dials, redials with backoff (0.5 s to 10 s),
  and on every connect reads the vault's needs-login set and sends both inputs.
  Dial, TLS handshake and `vault.hello` each have a 10 s deadline, and closing
  the edge stops a dial in flight. The vault serves one edge connection; a newer
  one replaces the older.
- **Bounds.** Both ends hold the other to `VAULT_LIMITS`: 1 MiB per message, 2
  MiB and 8 unfinished messages buffered, 256 requests served at once (more
  answer `busy`). A peer over them loses its connection, and only that one. The
  generic worker protocol keeps its own limits.
- **Methods.** Edge to vault: `vault.hello` (needs-login set, the vault's
  accounts directory, the login kinds it runs), `inputs.profiles` and
  `inputs.liveLeases` (the whole registry and live-lease set, on connect and on
  every change), `credential.for`, `credential.upstream401`, `accounts.discard`,
  `logins.start`, `logins.input`, `logins.cancel`, and `integrations.put`,
  `integrations.get` and `integrations.clear` (a user's integration credential
  under `integration` `atlassian` or, 1.2, `slack`, at most 16 KiB; an API token
  stays opaque, an OAuth record answers its access view or `rejected`; a put for
  `slack` is refused, since only a connect writes a Slack record), and
  `integrations.connect` (1.1, `slack` 1.2:
  `{userId, integration, code, redirectUri, site?, team?}`, the code at most
  2,048 characters, the redirect an `https:` URL, `site` only with `atlassian`
  and `team` (a Slack team id) only with `slack`, anything else refused before
  any effect; Atlassian answers `{ok, site, cloudId}` or
  `site: missing|ambiguous`, Slack `{ok, teamId, teamName?}` or
  `team: mismatch`, both also `rejected`, `unreachable`, `notConfigured`,
  `locked`, `unavailable`; the edge decodes each integration's answer on its
  own, and any other shape is `unavailable`). Vault to edge:
  `credential.report`, `logins.event`, `logins.done` (a failure code, never
  driver text) and `logins.commit`.
- **Rules.** The vault answers an access token and headers only, never a refresh
  token or a token file's content. It keeps only login profiles whose token file
  is under `<stateDir>/accounts/` and is a login credential file (never an
  integration record), and refuses any other binding, which the edge answers as
  the forbidden refusal. It saves the mirrored inputs in `vault-inputs.json`, so
  it renews across its own restart and while the edge is away. In the writer
  lane, right before moving a login's credential in, the vault asks the edge
  `logins.commit`, which answers the edge's own check; only an explicit `true`
  within 10 s moves it. A cancel, the vault's 10-minute deadline or a lost edge
  connection withdraws a login. The vault admits one login per account and four
  in all, whatever the edge allows.
- **No peer text.** Either end logs only a connection's end cause (`local`,
  `peer-closed`, `protocol`, `handshake-timeout`, `refused`), answers an unknown
  method with fixed text, and turns the other's answers into its own values: the
  edge rebuilds a vault refusal from its registry and known cases.
- **Link down.** A credential read answers the marked "vault unavailable"
  refusal (503) at once, or after 30 s without an answer, never needs-login, so
  no account shows as logged out; `needsLogin()` answers the last set the vault
  told. A login needs the link. No access token is cached on the edge: one round
  trip per forwarded request. Every integration call is bounded: a put or clear
  at 10 s, a get at 20 s (it may wait for a refresh, at most 8 s plus its lane),
  a connect at 30 s (two 8 s Atlassian or Slack calls plus its lane); a get and
  a connect also by the caller's signal. No link, the deadline, the abort or any
  request error answers `unavailable`, and a late reply settles a promise nobody
  reads. A put or clear that timed out has an unknown result, which the next
  status shows; a connect or refresh the edge stopped waiting for still finishes
  in the vault and stores its record.
- **No control.** An edge with a remote vault serves no gateway control 1.4 (its
  holds are the in-process vault's); it is a client-mode edge.
- **Pairing.**
  `gateway:admin --state-dir <vault dir> vault-init --host <name> ...` makes the
  vault's key and certificate (`vault-tls.json`) and prints the certificate.
  `gateway:admin --state-dir <edge dir> vault-pair --vault-cert <file>` makes
  the edge's (`vault-link.json`), pins the vault's and prints its own;
  `vault-init --edge-cert <file>` pins it on the vault. Certificates are public;
  keys never leave their machine.
- **Running.**
  `gateway:vault --state-dir <dir> [--bind-host <address>] [--port <n>] [--control-socket <path>] [--integrations-config <file>]`
  (`gateway/vaultMain.ts`, port 8794; `vault.js` in the Bun package) runs the
  vault; `gateway:dev ... --vault-host <address> [--vault-port <n>]`, or
  `gateway-edge.js` with the same flags in the Bun package, runs the edge
  against it. pi and the Claude CLI never load in the vault process: each Codex
  renewal and each login runs in its own child beside the entry, `codex-renew`,
  `claude-login` or `codex-login` (`gateway/childEntries.ts`; ADR-0005 "The
  login children"). A login child leads its own process group and writes only
  into the login's directory; the vault ends the whole group before it reads the
  credential or removes the directory.
- **Login bound.** Every vault login run reports done within
  `VAULT_LOGIN_SETTLE_BOUND_MS` (10 min 35 s) of its start
  (`gateway/vaultMethods.ts`). The bound covers when a run reports done and the
  killing of its child's process group; it does not physically contain
  processes. At its 10-minute deadline the vault withdraws a run that was not
  granted its commit: an ingest still waiting for its writer lane turn is
  abandoned, and the child gets SIGTERM, its group SIGKILL after 10 s; `done`
  then waits at most 5 s for the pipes after the leader exited and 5 s for the
  group to empty, and settles even if they never close (`loginChild.ts`, which
  then logs `login child settled with processes still running`). A run granted
  its commit is bounded by the 10 s commit exchange and a synchronous install
  and seal. Whatever the driver does, the vault itself reports the run done
  (`abandoned`) 35 s past the deadline, waiting only for a commit already in
  flight. The edge's hold after a lost link is this bound plus a minute.
- **Not contained: detached descendants.** A descendant that leaves the child's
  process group (its own session or group) survives a per-login Cancel and the
  group kill while the vault keeps running, and may write into the login's
  directory after `done`. Only the vault unit's stop or restart ends it:
  `KillMode=control-group` (or `mixed`) kills every process left in the unit's
  cgroup; `KillMode=process` or `none` would not. The vault's unit is not
  defined in this repository; the deployed one uses `KillMode=control-group`.
  This is accepted because the drivers are the official Claude CLI and pi's
  device-code login, which the vault trusts with the credential by design. Full
  per-login containment (its own cgroup) is Task-1407.

#### Sealed store

With recipients in `<stateDir>/vault-recipients.json` the vault process keeps
credentials on disk only as ciphertext (Task-1395, `gateway/sealedStore.ts`). A
vault without recipients, and every in-process vault, behaves as above. A
recipients file that is present but invalid (unreadable, another version, empty,
any bad entry or key id), or `sealed/` without one, stops the vault at start: it
never falls back to plaintext on disk.

- **Records.** `pandeck-sealed/1` (`gateway/sealedRecord.ts`), one per token
  file at `<stateDir>/sealed/<accountId>/<file>.sealed`, 0600, and one per
  user's integration credential at `sealed/int-<hash>/integration.json.sealed`
  (the hash of user id and integration, so no user id is on the disk), covered
  by the sweep, unlock, reseal and discard like a token file: a random data key
  encrypts the file with AES-256-GCM, bound to the account id and file name; for
  each recipient an ephemeral P-256 ECDH and HKDF-SHA256 give the key that wraps
  the data key. A recipient's key id is the SHA-256 of its SPKI. Kinds: `piv` (a
  YubiKey slot) and `software` (a private key file, for tests and self-hosted
  installs).
- **Plaintext in RAM.** Token files keep their paths under `accounts/`, which is
  a private tmpfs of the vault's unit (`TemporaryFileSystem=`); the vault
  refuses to start otherwise. Logins' temporary directories move into it too.
- **Locked.** Every start is locked: a credential read answers `locked`, which
  the edge refuses with the marked "vault locked" text (503), never needs-login.
  Renewal and the sweep skip, `credential.upstream401` is dropped, logins are
  refused, `integrations.put` and `integrations.clear` fail `vault_locked`,
  `integrations.get` answers locked, and `vault.hello` says `locked`.
- **Unlock.** `gateway:admin unlock` reads the PIN from the terminal with echo
  off and sends it over the vault's control socket
  (`/run/pandeck-vault/control.sock`, 0600, `gateway/vaultControl.ts`). The
  vault verifies it once through the YubiKey helper (ADR-0005), opens every
  record and writes the plaintext under `accounts/`. A wrong PIN answers the
  tries left and stays locked. A record that does not open is logged by account
  id and that account needs a login; the rest unlock.
- **Seal after write.** Renewal (Claude's and Codex's) seals in the writer lane
  after each attempt, a login's ingest after moving the credential in, and
  `integrations.put`, a connect and an OAuth refresh right after their rename;
  `accounts.discard` and `integrations.clear` delete the records. A user's
  integration record has one writer at a time: put, clear, connect and refresh
  run in order in its own lane (`vaultIntegrations.ts`). Every 60 s a sweep
  seals any token file whose content changed since it was last sealed or opened.
  A record whose plaintext is missing is never touched. A crash between a write
  and its seal can leave the previous token sealed (accepted, M21).
- **Stop.** From the moment SIGTERM or SIGINT arrives the vault admits no login,
  renewal, edge link or request: it withdraws every login, so none commits,
  cancels the logins and aborts the renewals in flight, drops every accepted
  connection (one still in its TLS handshake included) and the control socket's,
  and waits until each login's child group has ended and its directory is gone
  and each renewal attempt has left its lane. Integration operations stop being
  admitted at once (a later put, clear, connect or get that needs a refresh
  answers `unavailable`), queued ones are refused unrun, and the vault waits for
  each record's running one, which is never aborted, to finish its write and
  seal (a connect at most twice 8 s, a refresh 8 s). Then it seals every file
  that still differs from its record, trying three times; a file, its account
  directory or `accounts/` that is there but cannot be read counts as unsealed,
  a file that is not there is left alone. It exits 0 only when every record
  matches its file. Otherwise it exits 1 with
  `stop failed, not sealed at stop: <names>`, the record directories' names (an
  account id, or `int-<hash>` for a user's integration credential, both checked
  against the id pattern; never a value). This is a limitation, not a guarantee:
  a disk fault that lasts loses that write, because the plaintext lives only in
  the tmpfs. Those records still hold the previous credential, which the next
  start opens, so the account may need a new login. A second signal changes
  nothing.
- **Admin.** `vault-recipient add --from-piv <slot>` (no PIN),
  `--pem <file> --slot <slot>` or `--pem <file> --private-key <file>`;
  `vault-recipient list`; `vault-recipient remove <kid>` (never the last).
  `vault-reseal` re-encrypts every token file to the current recipients through
  the control socket, and fails, naming the accounts in the log, when a token
  file cannot be read. Replacing a key: add the new one, reseal, remove the old
  one, reseal. `vault-seal-existing`, once and with the vault stopped, seals
  today's plaintext files, then overwrites and removes each only after its
  record reads back. A token file that is there but cannot be read fails the
  run, exit 1, naming its account directory: its plaintext and the login
  leftovers stay, the readable ones are sealed, and a rerun after the fix
  completes it.

### Engine-version guard

The engines' CLIs are pinned, and a pin moves only with evidence that the new
CLI still talks only to the gateway.

- **The Claude contract (C17.1).** `claudeSdk/engineContract.test.ts` drives the
  installed SDK and its bundled CLI through the hosted engine and an in-process
  gateway against a fake upstream. Its four cases are: a turn on a named
  profile; a profile-less turn as `claude-default`; an upstream 401; and a lease
  revoked before the prompt. They assert:
  - only `POST /v1/messages` reaches the upstream, with the profile's credential
    and never the lease;
  - the egress recorder (the proxy every case sets) sees nothing;
  - the credential file keeps its hash, size, mtime and inode;
  - no log line holds a token;
  - the CLI's version equals the lock's;
  - a 401 is a dead login as today;
  - a refusal carries the marker and is not a dead login.
- **The pi contract (C17.1).** `piSdk/engineContract.test.ts` drives the
  installed pi SDK through the hosted engine, opened as `piStore` opens it, and
  an in-process gateway, against a fake Codex upstream. Its cases are: a turn on
  a named profile and on the default one; a Codex one-shot on the server lease;
  an upstream 401; a revoked lease; a server-catalog Codex id opened, reopened
  and forked; and, for each of two OpenAI-compatible accounts on fake endpoints,
  a turn, a one-shot on its server lease and a reopen, also once its model is
  gone. They assert:
  - one `POST /backend-api/codex/responses` per turn reaches the upstream, with
    the profile's token and account id and never the lease, and no upgrade;
  - each compatible turn and one-shot sends one
    `POST <base path>/chat/completions` to its own account's endpoint, with that
    account's key and never the lease, and nothing to the other's; a reopen
    restores its model through the port, or falls back to one its account
    offers;
  - a 401 and a refusal are not dead logins, and a refusal carries the marker;
  - an egress observer on undici's and `node:http`'s diagnostics channels sees
    no attempt beyond the gateway, the fakes and loopback, and a canary fetch to
    pi.dev shows it is not blind;
  - no engine writes `auth.json`, `models.json` or `models-store.json`, changes
    a fixture's login or catalog file, or stores a lease or a compatible key
    outside the account's `endpoint.json`, and no log line holds a token or key.
- **Isolation.** Only `pnpm run test:engine-contract`
  (`scripts/run-engine-contract.mjs`) runs both files. That command starts them
  in a user, network and PID namespace with loopback alone, and with a temp
  HOME, DATA_DIR and fake credentials. The outer namespace maps root to bring
  loopback up. Vitest and the CLI then run in a nested user namespace as the
  invoking uid, because the CLI refuses the sessions' `bypassPermissions` as
  root. The production options are unchanged. Anywhere else the file is skipped,
  and none of its setup runs. Where no namespace can be made, the command prints
  `engine-contract: SKIP: no network namespace: …` and exits 0 locally. Under
  `CI=true` it fails. Once a run starts, a failure, an unrun test or zero tests
  fail it. CI's `engine-contract` job is the evidence where a contributor's
  machine skips.
- **The pin lock (C17.2).** `gateway/verifiedEngines.json` names the verified
  versions, and `verifiedEngines.test.ts` fails when the `pnpm-workspace.yaml`
  catalog differs. It pins the Claude SDK with its bundled CLI, and
  `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`.
- **The bump rule.** A bump updates `verifiedEngines.json` only with the
  contract test green and one operator live smoke per engine, of the live-smoke
  script's shape. Agents never run the smoke.
- **Known limits.**
  - C13: the CLI reads the profile's `.credentials.json` (and an agent's Bash
    can too), as before.
  - With the switch on, engines no longer refresh their tokens; the gateway
    renews them ("Renewal"), each only while it holds a live lease.
  - A missing or malformed credential (for example `claude-default` never logged
    in) gets a marked 401 with the needs-login text; the CLI fails at once.
  - Agent Bash children inherit the lease and the base URL.
  - A native tool that calls another Anthropic endpoint is refused with the
    marker until a later slice allows it with contract evidence.
  - C2: a pi open, like a Claude one, awaits the link's readiness without a
    bound (G5, G7a).
  - After an OpenAI-compatible endpoint change to another origin, an open
    switch-off pi session on the old model (on an endpoint with a key) fails
    with pi's `Provider is not configured` until the user reselects the model or
    reopens the session (RD-1357-1). A switch-off one-shot running across such a
    change fails the same way.
  - A stored compatible credential in a pi `auth.json` would take precedence
    over the account's key. The server never writes one.
  - pi retries a gateway 503 or 502 on `/compat` 3 times, about 14 seconds,
    before the turn fails.
  - A request racing a push goes to the previous endpoint with its own key, or
    gets the marked 403. A failed push leaves that account's `/compat` at 503
    until its next settings change or a restart; the link does not retry (G5).
  - `compat.set` holds a key of at most 8192 visible-ASCII characters (0x21 to
    0x7e) and a base URL of at most 2048 bytes, its bounds since 1.2. Settings
    now refuses changed values outside these rules, using the shared endpoint
    validator, but keeps unchanged legacy values saved before Task-1379. For
    those legacy values, the outcome still depends on what refuses them. A key,
    or an otherwise valid URL over 2048 bytes, is refused by control alone: the
    push answers `invalid_params`, the account's earlier pair is cleared, its
    models are still offered, and its turns get the marked 503 with the
    `compat-unset` text. A URL with userinfo, a query, a fragment or a scheme
    other than http or https is refused by the engine's port as well: the
    account offers no model, and an open fails with "offers no models. Run Test
    on its card in Settings, or start a new session." Neither message names the
    cause. Renaming or editing another field of such a legacy account does not
    repair or remove its URL or key.
  - In-process, the hosted engine shares the server's process: the key-less feed
    bounds the engine's dependencies, not its memory. The server's own runtimes
    keep each compatible account's key for its discovery and switch-off runs,
    which stay direct and carry the origin guard above. An endpoint reachable
    only through a proxy in the server's environment is not measured.
  - A pi summary request may try one refused upgrade before SSE.
  - pi providers other than Codex and OpenAI-compatible, through an ambient
    environment key, behave as today. Model listing, catalog refresh and model
    discovery stay in the server.

## When the server is down

A running turn keeps going. Native tools never need the server, and model
requests go through the gateway, so most of a coding turn proceeds untouched.
The Worker spools the session's events, record changes and native output durably
until the server acknowledges them. App tool calls and approval hooks (the
session-hook methods: Claude's permission and `PreToolUse` decisions, `Stop`,
`PostCompact` and output artifacts) wait for the server for a bound of about ten
minutes and then fail as an ordinary tool error the agent sees. No engine waits
on a user's approval: an approval card is created by an app tool, which returns
at once, and the user's answer reaches the server on their own connection.

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

The credential gateway already has this shape: its own unit,
`personal-assistant-gateway`, which a deploy never restarts, and a
`pa-pr-gateway@<n>` beside each preview, restarted by the preview's deploy
([deployment.md](deployment.md) "Credential gateway unit").

### Zero-click enrollment checklist

Turning on `coder` in production (Task-1410 PR2) is the operator's step after
these checks, not part of a release:

1. Feasibility M1-M3 was measured on 2026-11-17. Record M1b (whether a build
   started after the first token expired gets a fresh one) and M5 (the edge host
   reaches `oauth2.googleapis.com` and `openidconnect.googleapis.com` over
   HTTPS) where deployment evidence is kept, without tokens; then stop and
   delete the probe workspaces and retire the probe template.
2. Add to the edge's UI config (mode 0600)
   `"coder": {"googleClientId": "<Coder's Google client id>", "automaticApproval": true}`;
   its `oidc.issuer` must be `https://accounts.google.com`.
3. Restart the edge and start a Pandeck devbox: its startup log shows "Approved
   automatically.", the edge's
   `enrollment request approved automatically for user …`.
4. Check the fallback: a devbox started with an empty token prints the link and
   the code.
5. To turn zero-click off, set `automaticApproval` to `false` and restart the
   edge; browser approval keeps working.

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

The gateway spike succeeded (ADR-0004), so desktop mode, too, keeps model tokens
in the gateway, and exclusive leases are not used.

## Phases

1. **Seams in-process.** A checkout port in front of every module that runs git
   or reads checkouts, and an engine-host interface, served by an in-process
   Worker over the real protocol codec. No behavior change. The isolation
   boundary and the secret store are ports from the start, so nothing in phases
   1–3 assumes "a different account" outside the server-host implementation.
2. **The Worker as its own process and unit, same account.** Turns survive a
   server restart (goal 2). Done when the server's boot recovery waits for
   Worker inventories and fences stale reports, rather than marking live Worker
   runs interrupted. The credential gateway ships here too, with the package
   proxy in the same service; each PR preview gets its own.
3. **The server under its own account** (goal 1). Moves every app-managed secret
   behind the secret store with its destination binding in an audited migration
   that removes the old plaintext copies, replaces the shared auth token with
   device pairing (gated on a hostile same-host, different-port page test),
   moves `DATA_DIR`, adds the boot check and the root-equivalent access warning,
   and moves every app tool that opens agent-supplied paths. It comes after
   phase 2 because before it, the server would have nothing to hand checkout
   work to.
4. **Several Workers, then remote Workers** over TCP with TLS, with tunnels for
   the server's loopback features.
5. **Isolation levels** inside a Worker: bubblewrap, containers, microVMs.
6. **Bundled desktop mode**, not scheduled. Starts with the desktop spike under
   "Open questions".

### Phase 1 status

Phase 1 ships as slices; each keeps behavior unchanged.

| Slice | Change                                                                                                                       | State  |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- | ------ |
| W1    | Protocol 1.0, in-process transport and Worker; every checkout git process crosses it                                         | landed |
| W2    | Served files (`/api/files`, `show_files`) read through the Worker                                                            | landed |
| W3a   | Protocol 1.2; worktree surfaces' checkout reads through the Worker (Task-1170)                                               | landed |
| W3b   | Workflow checkout reads through the same access, protocol 1.3 (Task-1182)                                                    | landed |
| W3c   | The KB row's typed server-local side for its git and checkout reads (Task-1183)                                              | landed |
| W3d   | Synchronous checkout probes: session cwd and main-repo resolution (Task-1184)                                                | landed |
| W4    | Protocol 1.4; the worktree watcher's watches and reads on the Worker (Task-1171)                                             | landed |
| W5    | Protocol 1.5; checkout create, removal and provisioning on the Worker (Task-1172)                                            | landed |
| W6    | Callers pass their own side; the string-cwd executors and both pin lists are gone                                            | landed |
| W7    | Protocol 1.6; interactive sessions' app tools and `ls` via the Worker (Task-1174)                                            | landed |
| W8    | Protocol 1.7; Claude permission and hook decisions and output artifacts via the Worker (Task-1175)                           | landed |
| W9a   | The pi engine handle: every live consumer reaches pi through `PiEngineHandle`, with its loop policy behind it (Task-1176)    | landed |
| W9b-1 | pi engine construction behind one opener over a JSON open spec, its child env injected (Task-1304)                           | landed |
| W9b-2 | The engine host protocol: the Worker's engine table, the handle's mirror, the opener behind the Worker (Task-1308)           | landed |
| W9c-1 | pi engine start resolved on the server: spec records, model port, integration gates as a command, mirrored tools (Task-1305) | landed |
| W9c-2 | Protocol 1.9; the pi engine's remaining server reach: skill materialization and the background-work bridge (Task-1313)       | landed |
| W10   | The engine host for Claude sessions (Task-1177)                                                                              | landed |
| W11   | Isolation boundary and secret store ports: Worker endpoint and child env; the Context7 key's reads (Task-1178)               | landed |

A failed-turn continuation reports asynchronously, across the protocol: a
transcript write that fails in the engine's `appendContextEdit` rejects the
run's disposition, pi is never called, and no `disposition` item is sent, so the
command's failure is what reaches the server. `PiLiveSession`'s
`continueFailedTurn` marks the run only once the disposition resolves, so on the
route from account recovery the failure reaches `PiAdapter.prompt` as its
rejection, with no banner, no failed run and no synthetic turn.

`workerBoundary.test.ts` asserts that no module of the checkout family imports
`node:fs`, that `gitExec.ts` and `checkoutFileAccess.ts` export no read or
executor without a side, and that only the side derivations and the Worker's own
clients name the default Worker. It also closes the value imports of the modules
that can hold the Knowledge Base row, each external symbol pinned to its
declaration. The in-process Worker gets its endpoint and its children's
environment only from `workers/isolationBoundary.ts`, and `worker/` never reads
the server's child-env overlay.

### Phase 2 status

The credential gateway (`app/server/src/gateway/`) has landed with its
forwarding core, its control channel and persisted leases, and the server's link
to it behind `ASSISTANT_GATEWAY=1`, off in code and on in the NixOS module. With
the switch on, every Claude engine sends its model requests through the gateway
with its lease, a profile-less session as `claude-default`, and every pi engine
sends its Codex requests through it with its lease, both under the
engine-version guard. Each OpenAI-compatible account's pi engines and one-shots
send theirs to `/compat` with their lease, and the gateway adds that account's
pushed key. Claude and pi one-shots, Claude usage, and Codex usage, reset
credits and consume go through it on a server lease per profile. It renews
tokens in each profile's writer lane (Renewal), and both login flows hold their
profile while their writer may write its token file (Login holds); a stuck hold
shows in Settings → Accounts with Clear. The gateway runs as its own process and
unit, on by default in the NixOS module, and the server dials it over a Unix
control socket. Engine routing comes in later slices.

## Open questions

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
