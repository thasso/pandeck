---
status: accepted
---

# The relay decrypts the Claude hosts for one process

With `ANTHROPIC_BASE_URL` pointing at the relay, Claude Code runs in "Claude
API" mode: no remote managed settings, and its account calls
(`/api/claude_cli/bootstrap`, `/api/oauth/profile`, telemetry) go straight to
`api.anthropic.com` with the public placeholder and get 401 (Task-1430; capture
on pandeck-dev2 with Claude Code 2.1.327, 2026-11-18). To behave as signed in
while the real token stays on the gateway, its traffic to the Claude hosts must
reach the gateway without a custom base URL.

## Decision

The relay (`app/server/src/relay/`) answers CONNECT on its loopback model port
when it runs with `--intercept-ca-cert <path>`, and decrypts every named host on
443 (the token hosts since Task-1430 PR2b, the rest observed since PR4). Without
the flag it has no CONNECT handler, as before.

- **Trust is process-scoped.** `claude-gateway` sets `HTTPS_PROXY` (never
  `HTTP_PROXY`) to `http://127.0.0.1:<relay port>` and `NODE_EXTRA_CA_CERTS` to
  the certificate file, unsets `ANTHROPIC_BASE_URL`, and puts no named domain in
  `NO_PROXY`. The CA is never installed in a system or browser store.
- **The CA** (`relay/interceptCa.ts`) is EC P-256 with critical basic
  constraints (CA, path length 0), critical key usage (keyCertSign, cRLSign) and
  critical name constraints: permitted DNS names `anthropic.com`, `claude.ai`
  and `claude.com`; excluded iPAddress `0.0.0.0/0` and `::/0`. Its key is
  `intercept-ca-key.pem` (0600) in the relay's state directory and never leaves
  it; `--intercept-ca-cert` receives the certificate only (0644, written
  atomically). Leaves name one host, last 30 days and live in memory.
- **Which CONNECT is decrypted** (`relay/connectTarget.ts`). The target must be
  a valid authority first: an IPv6 literal in brackets, an IPv4 literal, or a
  DNS name of valid labels, and a port; anything else, a query, userinfo or path
  included, gets a marked 400 and is neither recorded nor logged. Then:
  - an IP literal with a port in 1-65535 is a blind tunnel, never decrypted;
  - a named name (a named domain or a subdomain of one) spelled with a trailing
    dot is refused (`connect-target`), on a port other than 443 refused
    (`connect-port`);
  - every other named name on 443 is decrypted: `api.anthropic.com` and
    `mcp-proxy.anthropic.com` as token hosts, every other one as an observed
    host;
  - every other valid target with a port in 1-65535 is a blind tunnel.
- **The upstream rule stands.** The relay maps exactly two hosts to two fixed
  routes in its own code: `api.anthropic.com` → `/anthropic`,
  `mcp-proxy.anthropic.com` → `/anthropic-mcp`. The inner `Host` and the SNI
  choose nothing. At the gateway the prefix still decides the upstream, and the
  lease or the pool the profile.
- **What a decrypted token-host request changes.** The target becomes the route
  plus the original origin-form target; every caller `Host` is replaced by one
  `127.0.0.1:<relay port>`, so the edge sees a loopback caller as through the
  base URL, and an `Origin` still reaches the edge, which refuses it; every
  caller `x-pandeck-*` field is dropped. All other fields pass as received,
  repeats and order kept, hop-by-hop fields dropped; a body goes up framed as
  the relay parsed it, chunked again whatever the method or with its
  `Content-Length`. Bodies are piped both ways and never read. The inner server
  offers ALPN `http/1.1` only.
- **Observed hosts go direct, unchanged** (`relay/observedTraffic.ts`). A
  request to any other named host goes to that CONNECT host on 443, with SNI
  equal to it and the default CA verification; the inner `Host` and SNI choose
  nothing. It never uses the edge link's identity, CA or agent, and no gateway
  credential: at most the client's own placeholder reaches the host. Header
  fields pass as received without hop-by-hop ones (fixed and `Connection`-named,
  never `Host`, `Content-Length` or `Transfer-Encoding`) and caller
  `x-pandeck-*` fields; no credential or cookie is added or removed; bodies are
  piped unread, framed as the relay parsed them (chunked whatever the method, or
  with their `Content-Length`); an upgrade goes up as its head alone, with
  neither, and is piped both ways after the upstream's `101`. `/relay/…` is the
  relay's own on every ingress, so here too it gets the 403 `reserved-path`
  before any upstream contact. Its slot is reserved at admission and held for
  the request's whole lifetime, which writes one `observed` (or `failed`) record
  when it ends. A test-only programmatic seam may replace the address and trust
  root, never SNI or verification, and no flag or environment variable reaches
  it.
- **Local refusals are marked.** Every refusal the relay answers itself here
  (`connect-port`, `connect-target`, `origin-form` for an absolute-form target,
  `reserved-path` for `/relay/…` on any decrypted host, `upgrade` for a
  WebSocket upgrade to a token host, the 502 for an observed host it cannot
  reach, and a malformed target) has Anthropic's error shape and carries the
  gateway's refusal marker, so the server's classifier never reads it as a dead
  login.
- **Reporting is the precondition.** Interception is never enabled in a release
  without the relay's reporting channel (Task-1430 split plan, C2/C4/C5): every
  decrypted request gets a relay request id and a record (the edge's for a token
  host, the relay's for an observed host), and every relay-local refusal of a
  named host is recorded. No record holds a query or fragment. Both ingresses
  share one forward (admission, rid, reserved-field strip, fallback); the edge's
  ingest accepts a relay record naming a host under the named domains, and
  nothing wider. A malformed target or a failed handshake is only counted in the
  relay's summary line. A relay crash may lose records not yet acknowledged,
  shown by the next boot's `relay-restarted` note; an overflowing queue leaves
  an overflow note; the same request may appear twice, under one id, across an
  edge restart. There is no spill file: a closing relay logs one line with the
  count it dropped. The log shows gaps and duplicates as identifiable; it is not
  exactly-once accounting.

## Consequences

- Node children of `claude-gateway` inherit the proxy and the trust. A child
  that does not read `NODE_EXTRA_CA_CERTS` fails TLS on the named hosts and is
  unaffected elsewhere.
- Bun's BoringSSL (Claude Code's runtime) evaluates no iPAddress constraint: it
  refuses every IP name a constraint of that type covers, so an IP leaf of this
  CA still fails there, with a different error than OpenSSL's
  (`docs/deployment.md` "Bun package").
- A stolen CA key can impersonate only the named domains, and only to processes
  that trust this file. Recovery: delete `intercept-ca-*` in the relay's state
  directory, restart the relay, and hand the new certificate file to the
  wrapper.
- Any local process may use the token hosts through the relay, as it already may
  use the base URL (Task-1424). A blind tunnel, and an observed host's direct
  connection, reach whatever the relay's account can reach.
- An observed host sees the devbox's own network address and the client's own
  cookies and credentials, as without the relay; it learns nothing of the
  gateway.
- For the named domains this supersedes the Task-1424 "transport only" amendment
  (`docs/workers.md` "Standalone harnesses"): for a token host the relay
  rewrites the target and `Host` and drops reserved fields; for an observed host
  it drops reserved and hop-by-hop fields only. Everywhere else it still changes
  only transport.

## Considered options

- **Keep the base URL**: rejected; Claude Code stays in API mode.
- **Install the CA system-wide, or leave it unconstrained**: rejected; one
  process's need would widen every process's trust.
- **Decrypt IP literals or every host**: rejected; the CA excludes every
  address, and only named hosts carry account traffic.
- **Let the gateway choose the upstream from `Host` or SNI**: rejected; a
  request never chooses its upstream.
- **Send observed hosts through the gateway**: rejected; they need no account
  token (R6: every token-bearing request goes through the gateway, observed
  hosts at most with the public placeholder), and the gateway reads no body or
  cookie of theirs.
- **A spill file for records still queued at close**: declined by the owner; the
  dropped count is logged instead.
