---
status: accepted
---

# Agents keep the human's account; the server gets its own

The isolation goal is to keep Pandeck's secrets (the database, credential
profiles, integration tokens, the auth token) away from agents, not to keep
agents out of the user's home. So Workers run as the user (`thasso`), with their
home, dotfiles and SSH keys, while the server moves to a dedicated `pandeck`
account and a `DATA_DIR` only that account can read. A Worker receives model
credentials one session at a time through credential leases.

## Considered options

- **Dedicated agent account, server as the user**: protects the user's home but
  not Pandeck's secrets, which the server would still hand over.
- **Dedicated accounts for both**: the strongest boundary, but the user wants
  agents to use their home and SSH keys, and every repository and push
  credential would need an explicit grant.
