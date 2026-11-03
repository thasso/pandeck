# Credential gateway

Contract: `docs/workers.md` "Credentials" and ADR-0004.

- `gateway/` imports only `node:` modules, itself and `errors.ts`, never a
  package or other server module (`workerBoundary.test.ts`). Only
  `providerErrors.ts` imports it, for the refusal marker; new wiring updates
  that pin.
- Token files are only read here, never written, renamed or chmodded, until a
  later slice owns renewal.
- Forward bodies with `pipe` in both directions, never `on("data")` writes that
  ignore `write()`'s result: a paused client must hold the upstream back.
- No log line or refusal holds a credential, lease token or secret, query or
  body. Refusal texts hold no peer-supplied string.
- Every local refusal carries `GATEWAY_REFUSAL_MARKER` in the provider's error
  shape, so the classifier never reads it as a dead login.
