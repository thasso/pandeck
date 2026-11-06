<!-- instruction-budget: bytes=2400 reason="Ten contracts; logins in the gateway add the second token-file writer and keep drivers out of live files." task=1385 date=2026-11-06 -->

# Credential gateway

Contract: `docs/workers.md` "Credentials" and ADR-0005.

- `gateway/` imports only `node:` modules, itself and `GATEWAY_ALLOWED` in
  `workerBoundary.test.ts`, never a package or other server module; that list
  stays closed. Only `gatewayLink.ts`, `gatewayClientLink.ts`,
  `gatewayDevMain.ts` and `providerErrors.ts` (refusal marker) import it; new
  wiring updates that pin.
- Only a control or client connection grants a lease, and a grant binds provider
  and, for a login, token file from the registry, never from the request.
- State goes only to `stateDir`, through `privateJsonFile.ts`. It holds hashes
  and paths (lease secrets and enrollment codes hashed), never a token, lease
  token or pushed key; its only keys are the edge's TLS keys. Each compatible
  profile's pushed endpoint and key live in memory only, and a lease reaches
  only its own profile's pair. A client lease, only its client.
- Only renewal writes token files, in the profile's writer lane: Claude's under
  the CLI's locks with compare-and-swap and a same-directory rename that never
  creates a directory, Codex's only through the injected pi port's lock-fenced
  atomic store. Exception: a login's ingest (`logins.ts`) renames a checked
  credential in, in the same lane; its driver writes only its own fresh
  directory.
- A login hold ends only on its owning boot's release, the observed exit of its
  owner and registered writer (`processState`; uncertain is alive), or the
  operator's force release; never on elapsed time, a lost connection, a restart
  or a sync.
- Forward bodies with `pipe` in both directions, never `on("data")` writes that
  ignore `write()`'s result: a paused client must hold the upstream back.
- No log line or refusal holds a credential, lease token or secret, query or
  body. Refusal texts hold no string from a request or upstream; a profile name
  comes only from the registry.
- Every local refusal carries `GATEWAY_REFUSAL_MARKER` in the provider's error
  shape, so the classifier never reads it as a dead login.
- `verifiedEngines.json` changes only with that engine's contract test green and
  the operator's live smoke (`docs/workers.md` "Engine-version guard").
