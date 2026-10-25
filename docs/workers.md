# Workers

Agent sessions run in Workers: separately deployed processes, under an OS
account other than the server's, that host the engines and native tools and
reach the server only through the worker protocol. This document is the agreed
design. None of it is implemented yet; "Phases" gives the order it ships in. The
terms (Worker, worker protocol, credential lease, credential gateway, placement,
Worker id) are defined in [glossary.md](glossary.md), and the three decisions
that are hard to reverse are recorded in
[ADR-0001](adr/0001-worker-hosts-the-engine.md),
[ADR-0002](adr/0002-server-runs-under-its-own-account.md) and
[ADR-0003](adr/0003-worker-owns-checkout-operations.md).

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

- **Worker**, under the Worker's account: every session's engine (pi's loop, the
  Claude CLI and its hooks); native tools (shell, files, search, Monitor); every
  checkout operation (git, status, diff, the watcher, served files, worktree
  creation and removal, commit, push); the agent processes it starts (background
  work, stopping them before a removal, the OOM score sweep, container residue
  cleanup); and the full output of native tools.
- **Server**, under the server's account: `DATA_DIR` and every store in it, app
  tools (`pa`), approvals, Tasks, the Knowledge Base, one-shot runs, credential
  profile metadata, account routing and login flows, external MCP servers,
  container image pulls, browser tools, desktop port forwarding, and the web
  client and API.
- **Credential gateway**, also under the server's account, on the server's host:
  the live model credentials and their only refresher, every model request any
  engine makes, and the package proxy.

Every session runs on a Worker, including Assistant sessions without native
tools and the Personal Assistant, so every session survives a server restart.
One-shot runs stay on the server. They have no native tools, at most a bounded
allowlist of app tools (task intake's research tools, for example), finish in
seconds, and reach the model through the gateway like everything else.

Helpers that hold Pandeck secrets stay on the server's account: container image
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

## Accounts and secrets

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
Worker addresses. The first transport is a Unix socket both accounts can reach,
and TCP with TLS comes with remote Workers.

The protocol is versioned `major.minor`, separately from the app release. Minor
versions add without breaking either side. On a major mismatch the Worker
finishes the sessions it runs on the version it already speaks, takes no new
ones and is replaced.

**The server trusts no Worker request beyond its placements.** An agent runs
under the Worker's account, so it can read the Worker's credential, connect to
the socket itself or read the Worker's memory: whatever the Worker may do, an
agent may do. A Worker may act only for sessions and checkouts placed on it,
hold credential leases only for those sessions, and call app tools only with the
authority each session has today. A compromised agent then gains nothing beyond
what its own Worker already runs.

### Enrollment and identity

The operator adds a Worker in Settings, choosing its Worker id, and gets a
one-time, short-lived code. Run under the Worker's account, the Worker's enroll
command exchanges the code for the Worker's credential, stored in the Worker's
config directory with mode 0600. Revoking a Worker in Settings ends its
credential and every lease it holds. Revocation and server-side scoping are the
defense, not the secrecy of that file.

A Worker id is short and readable, unique, and never changes or gets reused. It
is not the machine's hostname: moving a Worker to new hardware re-enrolls the
same Worker under the same id with a fresh credential. The display name is
separate and free to change.

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
under the server's account; remote Workers reach it over TLS. A gateway on every
Worker host would put model credentials on each of those machines. The package
proxy lives in the same service, so builds keep working through server deploys
and remote Workers reach registries the same way. Its public trust material
lives outside `DATA_DIR`, where the Worker's account can read it.

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

## Phases

1. **Seams in-process.** A checkout port in front of every module that runs git
   or reads checkouts, and an engine-host interface, served by an in-process
   Worker over the real protocol codec. No behavior change.
2. **The Worker as its own process and unit, same account.** Turns survive a
   server restart (goal 2). Done when the server's boot recovery waits for
   Worker inventories and fences stale reports, rather than marking live Worker
   runs interrupted.
3. **The server under its own account** (goal 1). Starts with the gateway spike,
   then ships the credential gateway (or exclusive leases), moves `DATA_DIR`,
   adds the boot check and the root-equivalent access warning, and moves every
   app tool that opens agent-supplied paths. It comes after phase 2 because
   before it, the server would have nothing to hand checkout work to.
4. **Several Workers, then remote Workers** over TCP with TLS, with tunnels for
   the server's loopback features.
5. **Isolation levels** inside a Worker: bubblewrap, containers, microVMs.

## Open questions

- **The gateway spike.** Whether the Claude CLI and pi run on subscription
  credentials through a custom endpoint, how each behaves on a 401 and in a
  long-running process, and whether the provider's terms allow routing the
  operator's own subscription through the operator's own gateway. The answer
  picks between the gateway and exclusive leases.
- **Remote reach for loopback features.** Desktop port forwarding and browser
  tools reach Worker processes over loopback until phase 4 adds tunnels.
