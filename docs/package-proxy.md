# Package proxy

Some project builds need to read private _package_ registries mid-build — for
example an Android project's Gradle build resolves `com.example.*` artifacts
from GitHub Packages Maven (`https://maven.pkg.github.com/example-org/*`).
Unlike a container image (one nameable artifact `docker pull` can fetch up front
— see [`container-images.md`](container-images.md)), a build tool discovers its
dependency graph _during_ the build, so there is no single thing to pre-fetch.
This document is the contract for how such builds get credentials without an
agent ever holding one.

## Model

|                     |                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Mechanism           | A loopback HTTP forward proxy with SELECTIVE TLS interception, plus a standard proxy/CA/JVM env bundle applied to agent processes |
| Credential          | The existing GitHub integration token (`DATA_DIR/settings/github.json`) — no separate registry credential                         |
| Authenticated hosts | `maven.pkg.github.com`, `npm.pkg.github.com`, `nuget.pkg.github.com` only — deliberately NOT `api.github.com`/`github.com`        |
| Owning modules      | `app/server/src/packageProxy/`                                                                                                    |
| Setting             | `GithubSettings.packageProxyEnabled` (Settings → GitHub; defaults on whenever the GitHub integration is enabled and configured)   |

Instead of teaching each ecosystem a new repository URL, the server sets the
standard variables curl, git, npm/pnpm, pip, cargo, go, and the JVM already
read: `HTTP(S)_PROXY`, `NO_PROXY`, and a handful of CA-bundle variables
(`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`,
`GIT_SSL_CAINFO`). A project's own `settings.gradle`/`.npmrc` repository URL is
untouched — it simply starts succeeding.

## Children only, never the server

The bundle is published for CHILD processes and never set on the server's own
`process.env`. Bun's `fetch` and `node:http` honour `HTTP(S)_PROXY` for the
process that holds them (Node's `fetch` ignores them), so under Bun the server's
own outbound traffic would have gone through the proxy as CONNECT tunnels: the
GitHub API, web push, APNs and the in-process pi model streams. That extra hop
can stall long-lived SSE streams.

`packageProxy.ts` hands the bundle to `setChildProcessEnvOverlay` in
`subprocessEnv.ts`. `childProcessEnv()` is `process.env` with that overlay
applied, and every spawn that used to inherit or spread `process.env` passes it
instead:

| Child                                                                                        | Where it gets the overlay                                                           |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Claude CLI (sessions, one-shots, usage queries, login), and so its Bash and background tasks | `claudeProfileEnvironment`, `withClaudeOutputBudgetEnvironment`, `ClaudeSdkSession` |
| pi foreground `bash` (its `spawnHook`), background `bash` and command monitors               | `piSdk/backgroundWorkBackend.ts`                                                    |
| git, through the spawn broker or its in-process fallback                                     | `gitExec.ts`                                                                        |
| docker                                                                                       | `containerImages.ts`                                                                |
| Playwright MCP and the browser it starts                                                     | `externalSubprocessEnv()`, which reads `childProcessEnv()` by default               |

Worktree dev servers and builds run as commands of those agent shells, so they
get it as before. Children that make no outbound connection keep the plain
inheritance: the speech-to-text server, the boot-time host-tool probes and
`buildInfo` git call, the JDK lookup and `keytool` that build the trust
artifacts, and pi's `rg`/`fd` searches. pi also runs a `!command` in its own
model config through a shell of its own. That shell no longer sees the bundle,
which changes nothing for the non-package hosts such a command reaches: the
proxy only blind-tunnels them.

An operator's own `HTTP(S)_PROXY` in the service environment still applies to
the server and, when the package proxy is off, to its children. While the
package proxy runs, the bundle overrides it for children. Stopping the proxy
withdraws only the overlay and leaves the operator's value in place.

## Selective interception

The proxy terminates TLS **only** for the three credentialed hosts above, using
a CA it generates and holds in `DATA_DIR/package-proxy/`. Every other `CONNECT`
— including the CDN a registry redirects to (`maven.pkg.github.com` 302s
artifact downloads to `github-registry-files.githubusercontent.com`, which needs
no auth) — is a blind tunnel: bytes are piped between client and upstream and
never decrypted. This is the actual security boundary: the proxy cannot read,
let alone credential, traffic to any host it was not explicitly told to
intercept.

**Authentication scope**: ONLY the three intercepted hosts require the per-boot
`Proxy-Authorization` secret. Blind tunnels to non-credentialed HTTPS hosts are
unauthenticated, so clients that don't parse proxy-URL userinfo (e.g. Chromium)
can reach them — the secret protects credential injection, not tunnel access
itself (any local process can already emit a CONNECT or make a direct socket).
Plain HTTP through the proxy is deliberately unsupported and returns `501` for
all hosts.

For an intercepted host, the request's own `Authorization`/`Proxy-*` headers are
**replaced**, never merged, with `Basic <username>:<token>` built from the
GitHub integration credential.

## Why placeholder credentials are required

Gradle does not error when a repository's declared credentials resolve to null —
it **silently skips that repository** ("not found in any of the following
sources") and never issues an HTTP request at all, so the proxy never even sees
it. The env bundle therefore also sets `GITHUB_ACTOR`/`GITHUB_TOKEN` to harmless
placeholders, purely so build tools configured to read them (like an Android
project's `settings.gradle`) actually make the request. The placeholder value is
irrelevant — the proxy replaces the header outright — and it is never a real
token.

## Trust material: combined, never a replacement

Pointing a tool at the proxy's CA _alone_ breaks every host that is **not**
intercepted, because those hosts (including the CDN redirect above) present a
real, publicly-trusted certificate. So the two trust artifacts the server builds
are always the system trust plus the proxy's CA, never a replacement:

- `bundle.pem` — the system CA bundle (`/etc/ssl/certs/ca-bundle.crt` or
  equivalent) plus the proxy's CA. Used by
  `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`/`CURL_CA_BUNDLE`/
  `REQUESTS_CA_BUNDLE`/`GIT_SSL_CAINFO`.
- `jvm-truststore.p12` — the JDK's own `cacerts` (found next to `java` on PATH,
  so whichever JDK actually runs the build) plus the proxy's CA. Rebuilt on
  every proxy start so a renewed CA or a JDK upgrade never leaves stale trust
  material behind.

Both artifacts live in `DATA_DIR/package-proxy/`; the CA private key is mode
0600 and never leaves that directory.

## Why the JVM needs its own wiring

The JVM ignores `HTTPS_PROXY` and PEM CA bundles entirely. Two more variables
cover it:

- `JAVA_TOOL_OPTIONS` — proxy host/port system properties, `nonProxyHosts`, and
  the truststore path/password. This reaches every JVM launch, including
  Gradle's daemon. The proxy's per-boot **secret is deliberately absent here**:
  the JVM echoes `Picked up JAVA_TOOL_OPTIONS: …` to stderr on every launch,
  which would print it straight into build output and session transcripts.
- `GRADLE_OPTS`/`MAVEN_OPTS` — `-Dhttp(s).proxyUser`/`-Dhttp(s).proxyPassword`
  (the proxy secret) and `-Djdk.http.auth.tunneling.disabledSchemes=` (empty).
  The JVM's built-in proxy `Authenticator` only ever answers a **Basic**
  challenge, and refuses to do so over a `CONNECT` tunnel at all unless that
  property is cleared — the proxy therefore accepts the secret as either a
  Bearer token (curl/git/npm, via the proxy URL's userinfo) or as HTTP Basic
  auth (the JVM).

## Setup

No separate configuration: the proxy is on whenever the GitHub integration is
enabled, configured, and the "Let builds read private GitHub packages" toggle in
Settings → GitHub is checked (default). The same "Test" action that verifies the
GitHub token reports the proxy's status — listening address, intercepted hosts,
and whether JVM builds are covered (a JDK must be on the server PATH for the
truststore to be built).

## Lifecycle

The proxy starts at server boot (best-effort — a failure never blocks the server
from serving) and whenever GitHub settings are saved with the toggle on; it
stops when the toggle or the GitHub integration is turned off. It deliberately
does **not** stop during graceful shutdown/drain: a build may be
mid-dependency-resolution when a deploy starts draining active turns, and
killing the proxy would fail the very turn the drain is waiting on. It exits
with the process.

## Troubleshooting

| Symptom                                                              | Cause / fix                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings → GitHub reports "Package proxy off: …"                     | Read the reason: integration disabled, no token, or the toggle is off.                                                                                                                                                                                                                                                                                                                                     |
| "…JVM builds are NOT proxied (no JVM on PATH)"                       | No `java` binary was found on the server PATH when the proxy last started; restart the proxy (or the server) after a JDK becomes available.                                                                                                                                                                                                                                                                |
| A Gradle build still gets `401`/`denied` for a private artifact      | Check the same `read:packages` scope and SSO-authorization requirement as `container-images.md` — the credential is the same GitHub token.                                                                                                                                                                                                                                                                 |
| A build's repository is silently skipped, no request ever logged     | The build tool needs _some_ non-null value in its credential fields to attempt the request at all (see "placeholder credentials" above); if it reads different env var names than `GITHUB_ACTOR`/`GITHUB_TOKEN`, add them here.                                                                                                                                                                            |
| Browser can't reach a non-package URL (e.g. `assistant.example.net`) | For HTTPS: only `maven.pkg.github.com`/`npm.pkg.github.com`/`nuget.pkg.github.com` require authentication; all other HTTPS hosts are unauthenticated blind tunnels and behave exactly as without the proxy. For HTTP: the proxy deliberately returns `501 only CONNECT (https) is supported` for all hosts — plain HTTP forwarding is out of scope. Network/firewall errors are unrelated to this feature. |

## Deliberately out of scope

- No allowlist, no per-project opt-in: any build that inherits the env bundle
  gets the proxy, same posture as `container_image_pull`.
- No image/dependency caching beyond what the build tool already does.
- No hosts beyond the three GitHub package registries; adding another private
  registry (e.g. a self-hosted Artifactory) means adding both a host to the
  credential map and its own credential source — not part of this feature.
