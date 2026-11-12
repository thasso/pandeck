# Gateway UI listener

Contract: `docs/workers.md` "The gateway's sign-in and UI".

- Imports only `node:`, itself, `oauth4webapi`, `@assistant/shared/gatewayUi`
  and `webStatic.ts`; only `gatewayDevMain.ts` (later the packaged edge entry)
  imports it, and nothing else imports `oauth4webapi`
  (`workerBoundary.test.ts`).
- The user comes only from the session, the session only from a validated
  callback; never from a query, header or body. The allow rule runs before the
  registry sees an identity.
- Every non-GET/HEAD needs `Origin` equal to `publicOrigin` and
  `x-gateway-ui: 1`.
- Refusals and log lines are fixed. No secret, code, state, nonce, verifier,
  token, cookie or email in a log line, a refusal body or a redirect back to the
  gateway; only the provider authorization redirect carries state, nonce and the
  PKCE challenge. Provider error text is never echoed.
- Discovery names the configured issuer exactly, and every endpoint used is
  `https`. ID tokens come only from its token endpoint; their signature is
  checked against its `jwks_uri` through our single-flight key-set fetch, at
  most once a minute per issuer. `oidcTestOptions` comes only from tests.
- Static files come only from the tree enumerated at start; no request path
  reaches the filesystem.
