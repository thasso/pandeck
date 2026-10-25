---
status: accepted
---

# The Worker hosts the engine

Agent sessions move out of the server process into Workers so that a server
deploy no longer ends running turns and the agent can no longer read the
server's state. The Worker runs the whole engine (pi's loop, the Claude CLI and
its hooks) and the native tools. App tools, approvals and hooks call back to the
server over the worker protocol, and the server stays the only owner of
`DATA_DIR` and the system of record for every session's durable state, engine
records included.

## Considered options

- **Tool execution only**: the server keeps the engine and sends shell and file
  calls to the Worker. Rejected: every server restart still ends every turn.
- **Self-contained Worker**: the Worker owns its sessions' state and the server
  aggregates. Rejected: it splits `DATA_DIR`'s one writer and every state-sync
  contract, and session state on a Worker's disk would need backup and
  migration, which rules out ephemeral containers and microVMs. Checkouts, and
  the spool the server has not acknowledged yet, stay the only things on a
  Worker's disk the server cannot rebuild.
