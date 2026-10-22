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

**Peer session**: A session started by another session that reports back through
peer messages.\
_Avoid_: subagent. That word means only the Claude SDK's native subagents.
