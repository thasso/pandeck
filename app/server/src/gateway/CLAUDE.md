# Credential gateway

Contract: `docs/workers.md` "Credentials" and ADR-0004.

- `gateway/` imports only `node:` modules, itself and `GATEWAY_ALLOWED` in
  `workerBoundary.test.ts`, never a package or other server module; that list
  stays closed. Only `gatewayLink.ts` and `providerErrors.ts` (for the refusal
  marker) import it; new wiring updates that pin.
- Only a control connection grants a lease, and a grant binds provider and token
  file from the registry, never from the request.
- State goes only to `stateDir`, through `privateJsonFile.ts`. It holds hashes
  and paths: a lease's secret only as its hash, never a token or lease token.
- Token files are only read here, never written, renamed or chmodded, until a
  later slice owns renewal.
- A login hold ends only on its owning boot's release, the observed exit of its
  owner and registered writer (`processState`; uncertain is alive), or the
  operator's force release; never on elapsed time, a lost connection, a restart
  or a sync.
- Forward bodies with `pipe` in both directions, never `on("data")` writes that
  ignore `write()`'s result: a paused client must hold the upstream back.
- No log line or refusal holds a credential, lease token or secret, query or
  body. Refusal texts hold no peer-supplied string.
- Every local refusal carries `GATEWAY_REFUSAL_MARKER` in the provider's error
  shape, so the classifier never reads it as a dead login.
