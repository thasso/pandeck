# Gateway UI listener

Contract: `docs/workers.md` "The gateway's sign-in and UI".

- Imports only `node:`, itself, `oauth4webapi`, `@assistant/shared/gatewayUi`
  and `webStatic.ts`; only `gatewayEdge.ts` (both edge entries) imports it, and
  nothing else imports `oauth4webapi` (`workerBoundary.test.ts`).
- The user comes only from the session (integration callbacks too), the session
  only from a validated callback; never from a query, header or body. The allow
  rule runs before the registry sees an identity.
- Every non-GET/HEAD needs `Origin` equal to `publicOrigin` and
  `x-gateway-ui: 1`.
- Each comes only through its injected port: accounts and logins
  (`accounts.ts`), the Atlassian, Slack and GitHub credentials
  (`integrations.ts`), clients and MCP tokens (`clients.ts`), the user's request
  records (`requests.ts`), users (`users.ts`). A session is the actor of its
  logins; every table removal (`Sessions.onEnded`) ends them. The browser gets a
  login's fixed reason code, never driver or vault text.
- An enrollment code or MCP token appears only in the answer that creates it; no
  integration token in any answer.
- On the page, a machine's enrollment request is decided only by its session's
  click. Its user code goes only in a URL fragment or a POST body.
- Refusals and log lines are fixed. No secret, code, state, nonce, verifier,
  token, cookie or email in a log line, a refusal body or a redirect back to the
  gateway; only provider authorization redirects and an integration connect
  answer's `authorizeUrl` carry state, nonce and the PKCE challenge. Provider
  error text is never echoed.
- Discovery names the configured issuer exactly, and every endpoint used is
  `https`. ID tokens come only from its token endpoint; their signature is
  checked against its `jwks_uri` via our single-flight key-set fetch, at most
  once a minute per issuer. `oidcTestOptions` is passed only by tests.
- Static files come only from the tree enumerated at start; no request path
  reaches the filesystem.
