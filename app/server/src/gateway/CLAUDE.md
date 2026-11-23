<!-- instruction-budget: bytes=4096 reason="Fifteen contracts incl. tools, enrollment, lanes, leases, GitHub read tokens." task=1424 date=2026-11-17 -->

# Credential gateway

Contract: `docs/workers.md` "Credentials" and ADR-0005.

- `gateway/` imports only `node:` modules, itself and `workerBoundary.test.ts`'s
  `GATEWAY_ALLOWED` (with the import-free `accountRanking.ts`), never a package
  or other server module; that list stays closed. Only `gatewayLink.ts`,
  `gatewayClientLink.ts`, `gatewayEdge.ts` and `providerErrors.ts` (the marker)
  import it; new wiring updates that pin.
- Only a control or client connection grants a lease, or the edge a machine
  lease to its pool's pick of the client user's registry accounts; a grant binds
  provider and a login's token file from the registry, never the request.
- State goes only to `stateDir` via `privateJsonFile.ts`: hashes, paths and the
  request log's seen set (lease secrets and enrollment codes hashed), never a
  token, lease token or pushed key; its only keys are TLS keys (edge, vault
  link). Each compatible profile's pushed endpoint and key live in memory only;
  a lease reaches only its profile's pair, a client lease only its client.
- Only renewal writes token files, in the profile's writer lane: Claude's under
  the CLI's locks with compare-and-swap and a same-directory rename that never
  creates a directory, Codex's only through the injected pi port's lock-fenced
  atomic store. Exception: a login's ingest (`vaultLogins.ts`) renames a checked
  credential in, in that lane; its driver writes only its fresh directory.
  Integration records: only the vault's put, clear, connect and refresh
  (`vaultIntegrations.ts`), one at a time per record, sealed right after; a stop
  lets the running one finish and refuses the rest.
- No tool code or package here: only the injected `EdgeTools`, given typed
  credential outcomes, never a gateway-built tool error. `/mcp` needs the
  client's certificate, no `Origin`, and its MCP token (hashed); it and
  `tools.*` read the registry user's credential per call. An enrollment collect
  never sets, restores or replaces a token. Every vault integration call is
  bounded and answers a typed outcome. GitHub hands out only read installation
  tokens for one proven repository; every GitHub write uses the user's token on
  the gateway, never an installation token.
- Outside the page, only `approveAutomatically` decides an enrollment request,
  after a devbox proof: a Google token for Coder's client that the allow rule
  admits, still before the `notAfter` fixed at token info when the registry lock
  is held, and once per token (hash kept 61 minutes). It finds or creates the
  user like sign-in, never binds a claim, and uses the token once, in memory.
- A vault with recipients keeps credentials on disk only sealed
  (`sealedStore.ts`), plaintext only under its tmpfs `accounts/`, written by
  unlock. Each writer seals in its lane; the sweep never overwrites a record
  whose plaintext is missing. Only `codexChild.ts`, `loginChild.ts` and
  `pivChild.ts` spawn; the PIN goes only from the terminal via the control
  socket to the helper's stdin.
- A login hold ends only on its owning boot's release, the observed exit of its
  owner and registered writer (`processState`; uncertain is alive), or an
  operator force release; never on elapsed time, a disconnect, restart or sync.
- Forward bodies with `pipe` both ways, never unchecked `on("data")` writes: a
  paused client must hold the upstream back.
- No log line or refusal holds a credential, PIN, lease token or secret, query
  or body. Refusal texts hold no request or upstream string; a profile name
  comes only from the registry.
- Every local refusal carries `GATEWAY_REFUSAL_MARKER` in the provider's error
  shape, so the classifier never reads it as a dead login, except needs-login,
  which `loginEnded` reads for gateway-served profiles.
- `verifiedEngines.json` changes only with that engine's contract test green and
  the operator's live smoke (`docs/workers.md` "Engine-version guard").
