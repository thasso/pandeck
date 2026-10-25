---
status: accepted
---

# The server runs under its own account, apart from agents

Every process can read what its account can read, so a scrubbed environment does
not keep Pandeck's secrets (the database, credential profiles, integration
tokens, the auth token) from an agent under the same account. The server
therefore runs under a dedicated account, with a `DATA_DIR` only that account
can read, and Workers run under a different account the operator chooses. The
intended default for a personal deployment is the human user's own account:
agents then work the way the user does, with their home, tools and credentials
such as SSH keys, and the boundary protects Pandeck's secrets rather than the
user's home. Model credentials stay under the server's account too: the target
is a credential gateway that holds them, so Workers use them through leases and
never hold the profile store. If the gateway proves infeasible, the fallback is
exclusive leases, where one holder at a time, possibly a Worker, keeps a
profile's live token. The boundary holds only while the Worker's account has no
root-equivalent access to the server's host, such as a rootful Docker daemon or
passwordless `sudo`.

## Considered options

- **One account for both**: the starting point. Rejected: no boundary at all.
- **Server under the human's account, agents under a dedicated one**: protects
  the user's home, but agents lose the environment that makes them useful on a
  personal machine, and the server keeps standing access to the whole home.
- **Dedicated accounts for both**: still possible, since the Worker's account is
  the operator's choice. Not the default, because every repository and push
  credential then needs an explicit grant to the agent account.
