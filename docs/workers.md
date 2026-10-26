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

The Knowledge Base and the skills and agent libraries are git repositories
inside `DATA_DIR`. They are Pandeck data, not checkouts, and stay outside
placement, reachable only through their tools.

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

What runs today is protocol `1.1` (`1.0` plus the file methods), between the
server and the in-process Worker. The code lives in
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
  is placed on the default Worker, `local`. The existing `(args, cwd)` executors
  in `gitExec.ts` reach it through a transitional path-only adapter
  (`workers/placement.ts`); W6 deletes it once callers pass their own location.
- **What stays on the server.** The Knowledge Base, the skills and agent
  libraries, and the app's own tree run git through the server-local executor
  family, `serverRepoGit.ts`. That includes the KB when it is browsed or
  committed as a checkout: the adapter keeps any path inside the Knowledge Base
  root (as named, or as its real path) on the server. If KB settings cannot be
  read, the adapter keeps lexical and observed realpath matches for the last
  successfully resolved root from any KB/settings reader and the default KB root
  local. The owning settings module keeps this history; placement has no
  separate cache. Other paths still reach the default Worker, so unrelated
  checkout git keeps working. One warning logs per failure episode; a successful
  settings read resets it. Readable settings are authoritative again, even if
  the configured root changed. Settings and KB readers still report their
  original errors. On a cold start, an unknown custom root cannot be recognized
  while settings are unreadable. This residual is accepted only in phase 1,
  where the Worker shares the server process and account. It MUST be closed
  before the Worker leaves that process. W3 replaces the path rule with a typed
  choice made from the KB row.
- **Served files.** `/api/files`, document grants and `show_files` read through
  `servedFileAccess.ts`, the only caller of the file methods `files.stat`,
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
  observed real path, with the settings fallback above) on the server, which
  reads it with the same `fileReads.ts`; session artifacts are server data by
  kind, whatever their path. Every other path goes to the default Worker as
  named: the server never resolves a requested path to choose its side, since
  following an agent's symlink there would let the server read for the agent
  what the Worker may not. When the Worker fails, the read fails; there is no
  local fallback.
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
  ssh) are not covered, as they are not when a caller cancels. In-process, the
  server observes the Worker's quiescence directly; phase 2's plan must replace
  that with fencing for a Worker in another process.
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

| Slice  | Change                                                                                 | State   |
| ------ | -------------------------------------------------------------------------------------- | ------- |
| W1     | Protocol 1.0, in-process transport and Worker; every checkout git process crosses it   | landed  |
| W2     | Served files (`/api/files`, `show_files`) read through the Worker                      | landed  |
| W3     | Checkout reads in surfaces and workflows through the Worker; the KB row's typed choice | planned |
| W4     | The worktree watcher on the Worker                                                     | planned |
| W5     | Checkout lifecycle (create, remove, provisioning, PR view checkouts) on the Worker     | planned |
| W6     | Callers pass their own placement; the path-only adapter and both pin lists are gone    | planned |
| W7–W10 | The engine host: app tools, approvals and hooks, then pi and Claude sessions           | planned |
| W11    | Isolation boundary and secret store ports                                              | planned |

`workerBoundary.test.ts` pins every module that still reads a checkout on the
server's filesystem to the slice that moves it; W6 is done when those lists are
empty.

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
