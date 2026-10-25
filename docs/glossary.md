# Glossary

Agreed domain terms. Each entry names the term, defines it, and lists the words
to avoid in its place.

**State topic**: A named, subscribable list of one domain's objects that clients
keep in sync through state-change events.\
_Avoid_: channel, feed, stream

**Live projection**: The set of a state topic's objects that a client's
canonical list holds. Each topic defines its own membership: not archived and
not deleted for Tasks and Initiatives, not deleted for Projects.\
_Avoid_: active list, visible list

**Revision**: A per-object number that moves on every write touching that
object. It travels with the event, never as a field of the object.\
_Avoid_: version, etag

**Change set**: The objects, grouped by state topic, that one write touched.
They receive new revisions as part of that write and are published once it
commits.\
_Avoid_: dirty set, touched ids

**State-change event**: An upsert or delete of one object at a revision,
published on a state topic. Leaving the live projection is a delete.\
_Avoid_: patch, delta

**Digest**: The id and revision of every object in a topic's live projection,
which a reconnecting client compares against its cache.\
_Avoid_: manifest, checksum

**Replica**: The client's copy of one state topic: its live-projection objects
and revision sidecar, kept by the replica module from snapshots and state-change
events.\
_Avoid_: cache, store, mirror. A cache is the shell cache, and a store is a
server persistence layer.

**Mutation lifecycle**: The client owner of a write's request identity, timer
and once-only terminal transition. Domain descriptors decide recovery and
control outcomes. A generic settle acknowledgement need not complete a domain
that also waits for an authoritative object or list.\
_Avoid_: request manager, mutation queue

**Pending mutation**: A write still holding its request correlation and timer,
with any touched domain effects and browser-local create id. Effects suppress
digests for their topics and block optimistic shell-cache writes. Receipt-only
records, such as compaction, have no list effects or digest/cache claim. A
pending mutation is not a replica read request.\
_Avoid_: overlay store, pending read

**Outcome unknown**: A write whose socket was lost before its answer. Its
pending claim releases without declaring success or failure, and reconnect reads
determine what landed. The client neither rolls back an inverse nor resends the
command.\
_Avoid_: cancelled, failed, saved

**Native facts**: A session's identity and engine configuration, plus live
engine observations when it is resident. App-owned state such as Tasks, queues
and approvals is not part of these facts.\
_Avoid_: engine state, session snapshot

**Peer session**: A session started by another session that reports back through
peer messages.\
_Avoid_: subagent. That word means only the Claude SDK's native subagents.

**Lane**: A source of work the per-session delivery scheduler pulls from in
priority order. It reports whether a session is owed work without opening a
harness, then delivers through that session. It owns its storage and retry
policy.\
_Avoid_: unified delivery queue, transport

**Wake**: A payload-free request to run a session's delivery scheduler. A wake
during a pass marks another pass from the top.\
_Avoid_: delivery, message, receipt

**Pass**: One ordered offer of a session's owed lanes under its scheduler gate.
A new turn ends it; a steer does not.\
_Avoid_: turn, run, drain

**Receipt**: The runtime's evidence of one prompt's append, provider admission
and run outcome, for each lane to interpret. A receipt distinguishes delivery
from handling and records uncertainty rather than treating resolution as
success.\
_Avoid_: success flag, delivery acknowledgment

**Worker**: A separately deployed process that hosts agent sessions' engines and
native tools on the far side of the isolation boundary from the server, and
reaches the server only through the worker protocol. The server can restart
while its Workers keep running.\
_Avoid_: agent server, runner, node. A web worker or diff worker is the browser
thread, always named with its qualifier.

**Worker protocol**: The versioned contract between the server and its Workers,
versioned separately from the app release. A Worker dials the server, never the
reverse. Minor versions add without breaking either side; a major mismatch means
the Worker finishes what it runs and takes nothing new.\
_Avoid_: worker API, RPC, agent bridge

**Credential lease**: A Worker's right to use one credential profile for one of
the sessions placed on it, granted and revoked by the server. Each profile has
exactly one refresher at a time, and a lease never makes the Worker a second
one. A live account switch ends one lease and grants another.\
_Avoid_: credential copy, token share, synced profile

**Credential gateway**: The long-lived service on the server's side of the
isolation boundary that holds the live model credentials, is their only
refresher, and forwards every engine's model requests in exchange for a lease
token.\
_Avoid_: model proxy, LLM proxy. The package proxy is a separate function that
happens to run in the same service.

**Placement**: The one Worker a checkout lives on or a session runs on. A
worktree session's placement follows its checkout's. A Project may have clones
on several Workers, each placed separately. Changing a checkout's placement is
an explicit move.\
_Avoid_: affinity, pinning, home worker

**Worker id**: The readable name a Worker is enrolled under, carried by
placements, served-file URLs and logs. It is unique and never changes or gets
reused; moving a Worker to new hardware keeps it. A Worker's display name is
separate and may change.\
_Avoid_: hostname, worker name

**Isolation boundary**: What keeps Worker processes, and the agents they run,
out of Pandeck's secrets: separate OS accounts on a server host, or separately
signed processes and the platform key store on a single-user desktop.\
_Avoid_: sandbox. A sandbox is a per-session isolation level inside a Worker.

**Secret store**: The one place Pandeck keeps app-managed credentials and keys,
each with the destination it may be sent to, readable only from the server's
side of the isolation boundary: files only the server's account can read on a
server host, the platform key store on a desktop. A Worker's enrollment
credential and an exclusively leased token are the named exceptions held on the
Worker's side.\
_Avoid_: vault, keyring, credential file

**Device pairing**: How a browser or app obtains its own revocable credential,
by exchanging a one-time code. Worker enrollment is the same exchange for a
Worker.\
_Avoid_: login, auth token. There is no shared token.
