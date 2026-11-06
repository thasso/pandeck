---
status: accepted
---

# The credential gateway is its own service, split into an edge and a vault

ADR-0004 placed the credential gateway under the server's account, on the
server's host. It must outlive the server and serve clients on other machines,
so it becomes a deployable service of its own, not bound to the server's host or
account. A self-hosted install runs it on one machine; a multi-user install can
separate its parts. The same code serves both.

The gateway has two tiers that meet at one port (`VaultPort`,
`app/server/src/gateway/vaultPort.ts`). They share one process now and get
separate processes later.

- The **vault** holds the credentials, is their only refresher, and runs the
  writer lane and the login holds. It imports only `node:` modules, with one
  exception: Codex renewal runs pinned pi in a child process, one credential per
  renewal (below).
- The **edge** holds everything exposed: listeners, client authentication,
  leases, forwarding, the control and client protocols, and later tools and
  config. It gets access tokens from the vault, never refresh tokens.
- The vault's API carries a per-credential `locked` state from the start, so
  credentials their user must unlock can follow.

`workerBoundary.test.ts` classifies every gateway module as edge, vault, shared
or composition, and fails when one tier's code value-imports the other's.

## The Codex renewal child

Codex renewal stays pi's own code, isolated in a child process:

- One child per renewal, behind the existing `CodexRenewPort`
  (`(authFile, minValidityMs, signal) => Promise<CodexRenewResult>`), so renewal
  itself does not change.
- In: one JSON object on stdin, `{ authFile, minValidityMs }`, naming exactly
  one credential. No credential appears in argv or the environment, and the
  environment is minimal.
- Out: exactly one JSON line on stdout, the result (`{ ok: true }` or
  `{ ok: false, kind, code }`), never a token or message, then exit 0.
- A spawn error, a non-zero exit, a missing or malformed line, or the deadline
  answers `{ ok: false, kind: "failed", code: "child" }`. An abort sends
  SIGTERM, then SIGKILL after a grace period, and answers `code: "aborted"`.
- The body is today's pi refresh unchanged: pi's lock, the entry's
  compare-and-swap and the atomic rename.
- The child's entry is the only gateway-shipped module that may import pi, and a
  boundary test pins it.
- With an encrypted store, the input becomes the credential record and the
  output the renewed record, and the vault does the compare-and-swap.

## Still in force from ADR-0004

One refresher per credential profile. Engines hold no refresh token, and agents
read no model credential. Lease tokens are checked locally, now by the edge. The
number of Workers never changes the refresh story. Exclusive leases, push
refresh and a gateway on every Worker host stay rejected.

Superseded: "under the server's account, on the server's host".

## Considered options

- **Keep the gateway on the server's host**: rejected, because it must outlive
  the server and serve clients elsewhere.
- **One tier**: rejected, because its dependencies and its exposed surface would
  sit beside the refresh tokens.
- **An off-the-shelf model proxy holding the secrets**: rejected for the same
  reason.
