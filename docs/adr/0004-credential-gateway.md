---
status: proposed
---

# A credential gateway is the only refresher of model credentials

An OAuth refresh usually rotates the refresh token, so two holders of one
credential profile that refresh on their own invalidate each other. With the
server's one-shot runs and any number of Workers on any number of machines, a
profile would have many holders. The target is a credential gateway: a
long-lived service under the server's account, on the server's host, that owns
the live tokens, is their only refresher, and forwards every engine's model
requests in exchange for a lease token it checks locally. Engines hold no
refresh token, agents can read no model credential, and the number of Workers
never changes the refresh story. The status stays proposed until the phase 3
spike shows both engines run on subscription credentials through a custom
endpoint.

## Considered options

- **Exclusive leases**: one holder, possibly a Worker, keeps a profile at a time
  and refreshes it. Works with today's engines, but couples account routing to
  placement: every session on an account runs where its profile is held. This is
  the fallback if the spike fails.
- **Push refresh**: the server refreshes early and pushes fresh tokens into
  every copy. Rejected: it depends on engines re-reading their files and never
  refreshing on their own, and one engine-initiated refresh breaks every other
  copy.
- **A gateway on every Worker host**: rejected, because it puts model
  credentials on every machine.
