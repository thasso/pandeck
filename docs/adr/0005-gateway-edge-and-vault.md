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
`app/server/src/gateway/vaultPort.ts`). They share one process by default, and
can run as separate processes on separate machines: the edge then reaches the
vault over `gateway-vault/1.0`, on mutual TLS with each side's certificate
pinned, and holds no refresh token (Task-1394, `docs/workers.md` "Remote
vault"). Gateway control 1.4's login holds stay with an in-process vault.

- The **vault** holds the credentials, is their only refresher, and runs the
  writer lane and the login holds. It imports only `node:` modules, with two
  exceptions, each in a child process: Codex renewal runs pinned pi, one
  credential per renewal, and a sealing vault's unlock runs the YubiKey helper
  (both below).
- The **edge** holds everything exposed: listeners, client authentication,
  leases, forwarding, the control and client protocols, the integration tools
  (below), and later config. It gets access tokens from the vault, never refresh
  tokens.
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
- The sealed store (Task-1395) keeps this child as it is: it renews the
  plaintext file in the vault's RAM filesystem, and renewal seals the result in
  the lane right after it.

## The YubiKey helper

A vault with recipients keeps credentials on disk only as records sealed to a
P-256 key on a YubiKey (PIV slot 9d), and starts locked (Task-1395,
`docs/workers.md` "Sealed store"). Node has no PC/SC, so the private-key
operations run in a small Python helper on the installed `yubikit`
(`gateway/pivHelper.py`, behind `gateway/pivChild.ts`):

- Spawned only to read the public key (`vault-recipient add --from-piv`) and
  during an unlock; no argv secrets and a minimal environment.
- JSON lines on stdin and stdout: `public`, `verify` (the PIN, once) and `ecdh`
  requests; answers carry a public key, a shared secret or a fixed error code
  (`wrong_pin` with the tries left, `blocked`, `no_device`, `no_key`, `failed`).
  It never echoes the PIN or an exception's text; its stderr is dropped.
- The vault closes it as soon as every record is open. Sealing needs only the
  public key, so renewals and logins run unattended.
- Only `pivChild.ts` and `codexChild.ts` may spawn in `gateway/`; a boundary
  test pins both.

## Tools on the edge

Integration tools run in the edge process (Task-1397, `docs/workers.md` "Tools
on the edge"):

- Tool code lives in `gatewayTools/`, loaded only by the edge's entry. The vault
  process never loads it, and `gateway/` holds no tool code or package: it
  reaches the tools only through the injected `EdgeTools`
  (`gateway/edgeTools.ts`, types only). A boundary test pins both directions.
- A user's integration credential (the Atlassian API token for the pilot) is a
  vault record, sealed like a token file. The edge reads it from the vault for
  one tool call, or one set or status check, and never caches, logs or writes
  it. Every vault integration call is bounded, and a late answer is dropped.
- The gateway hands tools typed credential outcomes and never builds a tool
  error; only fixed, edge-owned tool texts reach a caller.
- The MCP endpoint needs the client's certificate and that client's MCP token,
  kept only as a hash; it never forwards and spends no lease.

The API token reaches the edge in plaintext per call. That is accepted for the
pilot (M22); OAuth apps (G12) replace it later.

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
