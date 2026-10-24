# Workers

Agent sessions run in Workers: separately deployed processes, under an OS
account other than the server's, that host the engines and native tools and
reach the server only through the worker protocol. This document is the agreed
design. None of it is implemented yet; "Phases" gives the order it ships in. The
terms (Worker, worker protocol, credential lease, placement, Worker id) are
defined in [glossary.md](glossary.md), and the three decisions that are hard to
reverse are recorded in [ADR-0001](adr/0001-worker-hosts-the-engine.md),
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

| Worker                                                            | Server                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------- |
| Every session's engine: pi's loop, the Claude CLI and its hooks   | `DATA_DIR`, the database and every store in it                 |
| Native tools: shell, files, search, Monitor                       | App tools (`pa`), approvals, Tasks, the Knowledge Base         |
| Every checkout operation: git, status, diff, watcher, served file | One-shot runs: naming, the status card, commit messages        |
| Worktree creation and removal, commit, push                       | Credential profiles and account routing                        |
| Agent processes: background work, stop before removal, OOM sweep  | External MCP servers, the package proxy, container pulls       |
| Container residue cleanup                                         | Browser tools, desktop port forwarding, the web client and API |

Every session runs on a Worker, including Assistant sessions without native
tools and the Personal Assistant, so every session survives a server restart.
One-shot runs stay on the server: they carry no tools, finish in seconds and use
credentials the server already holds.

Helpers that hold Pandeck secrets stay on the server: the package proxy (real
registry credentials behind placeholder tokens), container image pulls (the
registry credential), and external MCP servers (integration credentials through
`trustedEnv`). Agents see the MCP servers only as tools. A Worker-side MCP
server, for one that must read the Worker's files, is an explicit exception and
not the default.

The Knowledge Base and the skills and agent libraries are git repositories
inside `DATA_DIR`. They are Pandeck data, not checkouts, and stay outside
placement, reachable only through their tools.

## Accounts and secrets

The server runs under a dedicated account. `DATA_DIR` belongs to it, mode 0700,
and the server refuses to boot when the Worker account can read `DATA_DIR` or
the server's environment file. Moving an existing `DATA_DIR` to the new account
is a runbook step the operator performs once, never an automatic migration.

The Worker runs under an account the operator chooses. For a personal deployment
the intended default is the human user's own account: agents then use the user's
home, tools and credentials such as SSH keys, and the boundary protects
Pandeck's secrets, not the user's home. A dedicated agent account works too, at
the cost of granting it every repository and push credential explicitly.

## Checkouts and placement

Every checkout, meaning a Project's base clone and each managed worktree, is
placed on exactly one Worker, and only that Worker runs git or reads files in
it. A worktree is made only from a base clone on the same Worker. A Project may
have base clones on several Workers, each placed separately; until phase 4, each
Project has one.

A worktree session's placement follows its checkout. A session without a
worktree has its own placement, by default the configured default Worker; there
is no load balancing until there is more than one Worker to balance. Moving a
checkout to another Worker is an explicit act, never automatic.

A Project's local path is per Worker: the registry records one for each Worker
that holds a clone, and the Personal Assistant's working directory is a path on
its default Worker.

## Durable state

The server stays the system of record for everything durable about a session:
the app log, the engine's own record and resume handle, the Claude CLI's native
transcript and pi's session file. The Worker keeps a working copy, streams
changes to the server and rehydrates from the server when it takes a session. A
Worker's disk therefore holds nothing that cannot be rebuilt, which is what lets
a Worker be replaced, and later be an ephemeral container or microVM.

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
request credential leases only for those sessions, and call app tools only with
the authority each session has today. A compromised agent then gains nothing
beyond what its own Worker already runs.

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

## Credential leases

The server owns every credential profile. A Worker receives a lease for one
session's profile; it never holds the profile store. The lease is per session,
but the Worker materializes one copy per profile it holds leases on, shared by
its sessions on that profile, as sessions share one profile directory today. The
engines refresh tokens there, and the Worker writes refreshed tokens back to the
server. A live account switch ends one lease and grants another.

An agent can read the profiles in use on its own Worker; it cannot read the
others.

## When the server is down

A running turn keeps going. Native tools never need the server, so most of a
coding turn proceeds untouched. The Worker spools the session's events and
record changes durably until the server acknowledges them. App tool calls and
approval hooks wait for the server for a bound of about ten minutes, which
covers a normal deploy, and then fail as an ordinary tool error the agent sees.

When the spool reaches its size cap, the Worker holds the turn before its next
model request until the server is back, rather than drop events.

## When a Worker stops

A Worker restart drains the way the server does today: no new turns, running
turns finish within a bound, then the process exits. Idle sessions do not hold
it up; they reattach to the restarted Worker or to another one, since the server
holds their state.

When a Worker dies or vanishes, its running turns end as interrupted turns
([interrupted-turns.md](interrupted-turns.md)). Sessions without a worktree can
resume on any Worker. Worktree sessions wait for their Worker, or for an
explicit move of their checkout.

## Served files

A served-file URL names the Worker id, `/api/files/<worker id>/<absolute path>`,
and the server streams the bytes from that Worker. An unqualified
`/api/files/<absolute path>` link, the form in existing transcripts and
documents, resolves on the default Worker. Session artifacts and attachments
stay server-side, as [served-files.md](served-files.md) describes.

## Deployment

The Worker ships in the same release artifact as the server, with its own entry
point and its own service unit, and the server never starts or stops a Worker
process. A Worker started by the server would share its cgroup and stop with
every deploy. A deploy does not restart Workers implicitly: the operator
restarts one on purpose, or when the server reports a major protocol mismatch.
The drain and out-of-memory rules in [deployment.md](deployment.md) move to the
Worker's unit, since that is where the agent processes run.

The development server and the test suite run an in-process Worker over the real
protocol, so there is one code path and no mock transport. Each PR preview runs
its own Worker beside its server and never shares production's.

## What the user sees

Each session shows its Worker. Settings has a Workers page: health, version,
protocol version, sessions, placed checkouts, and revoking enrollment. An
offline Worker or a protocol mismatch is a condition in the app status slot
([messaging.md](messaging.md)).

## Phases

1. **Seams in-process.** A checkout port in front of every module that runs git
   or reads checkouts, and an engine-host interface, served by an in-process
   Worker over the real protocol codec. No behavior change.
2. **The Worker as its own process and unit, same account.** Turns survive a
   server restart (goal 2).
3. **The server under its own account.** `DATA_DIR` moves, the boot check lands,
   credential leases replace the shared profile store (goal 1). It comes after
   phase 2 because before it, the server would have nothing to hand checkout
   work to.
4. **Several Workers, then remote Workers** over TCP with TLS, with tunnels for
   the server's loopback features.
5. **Isolation levels** inside a Worker: bubblewrap, containers, microVMs.

## Open questions

- **One refresher per profile across Workers.** Two Workers on the same profile
  would each refresh its OAuth token, and a provider that rotates refresh tokens
  would invalidate the other copy. Phase 4 decides between the server refreshing
  and handing out access tokens, and leasing a profile to one Worker at a time.
  It needs a test of how the Claude CLI behaves first.
- **Remote reach for loopback features.** Desktop port forwarding and browser
  tools reach Worker processes over loopback until phase 4 adds tunnels.
