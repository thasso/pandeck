# Package proxy implementation — reference

Relocated from `app/server/src/packageProxy/CLAUDE.md` (Task-274) so it stops
costing agent context on every visit. This is a descriptive snapshot of what the
modules in that subtree own; the rules an agent must not violate stay in that
folder's `CLAUDE.md`. Correct or delete a section here when the code moves on.
Relative paths in the body are relative to the original subtree.

## Purpose

The authenticating package-registry proxy (contract: `docs/package-proxy.md`): a
loopback HTTP forward proxy with selective TLS interception, plus the standard
proxy/CA/JVM environment bundle applied to agent processes, so a build in a
worktree can read private GitHub package registries mid-build without ever
holding the credential.

## Module ownership

- `certificateAuthority.ts` owns the CA and trust artifacts: load-or-create the
  CA under `DATA_DIR/package-proxy/` (key mode 0600, renewed within 30 days of
  expiry), per-host leaf issuance
  (`issueLeafCertificate`/`createLeafCertificateCache`, in-memory only, never
  persisted), and `writeTrustArtifacts` — the two trust artifacts that MUST be
  combined with system trust, never a replacement for it (a tool trusting our CA
  alone would reject every host we do NOT intercept): `bundle.pem` (system CA
  bundle + ours) and `jvm-truststore.p12` (a copy of the JDK `cacerts` found
  next to `java` on PATH, plus ours — `jvmTruststorePath` is null with a
  `jvmReason` when no JVM is found, and nothing downstream needs a JVM
  truststore in that case).
- `proxyServer.ts` owns the proxy itself (`startPackageProxy`): a host is
  TLS-terminated ONLY if it has a credential provider in `credentialHosts`;
  every other host is a blind `CONNECT` tunnel (bytes piped, never decrypted) —
  this is the actual security boundary. An intercepted request's own
  `Authorization`/`Proxy-*` headers are REPLACED, never merged, with the
  resolved credential. ONLY intercepted hosts require the per-boot secret as
  `Proxy-Authorization`, accepted as either `Bearer <secret>` (curl/git/npm, via
  the proxy URL's userinfo) or `Basic <any-user>:<secret>` (the JVM's built-in
  proxy `Authenticator`, which only ever answers Basic); blind tunnels to
  non-credentialed hosts are unauthenticated. All logging goes through the
  shared `containerImages.ts` `redactRegistrySecrets` helper.
- `proxyEnvironment.ts` owns the environment bundle: `HTTP(S)_PROXY`/`NO_PROXY`
  (with `api.anthropic.com` and friends excluded, so long-lived agent API SSE
  traffic never takes the extra hop) and the CA-bundle variables every non-JVM
  ecosystem reads
  (`NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`/`CURL_CA_BUNDLE`/`REQUESTS_CA_BUNDLE`/
  `GIT_SSL_CAINFO`). For the JVM: `JAVA_TOOL_OPTIONS` carries proxy
  host/port/truststore properties but DELIBERATELY NOT the secret (the JVM
  echoes `Picked up JAVA_TOOL_OPTIONS: …` to stderr on every launch, which would
  leak it into build output/transcripts) — the secret instead rides in
  `GRADLE_OPTS`/`MAVEN_OPTS` (`-Dhttp(s).proxyUser`/`-Dhttp(s).proxyPassword` +
  `-Djdk.http.auth.tunneling.disabledSchemes=`, required for the JVM to attempt
  Basic auth over a CONNECT tunnel at all). `placeholderCredentialEnvironment()`
  supplies `GITHUB_ACTOR`/`GITHUB_TOKEN` placeholders — never a real token —
  because Gradle SILENTLY SKIPS a repository whose declared credentials resolve
  to null, so without a placeholder the proxy would never even see the request.
- `packageProxy.ts` owns lifecycle: `shouldRun()` gates on the GitHub
  integration being enabled+configured AND the `packageProxyEnabled` setting;
  `startPackageProxyIfEnabled`/ `stopPackageProxy`/`reconcilePackageProxy`
  publish/withdraw the built env bundle onto `process.env` (so every
  later-spawned agent/host-command/build-tool child inherits it — no per-harness
  plumbing needed), and `packageProxyStatus()` feeds the Settings → GitHub
  readiness sentence via `githubSettings.ts`. `GITHUB_PACKAGE_HOSTS` is the
  credential map's host list —
  `maven.pkg.github.com`/`npm.pkg.github.com`/`nuget.pkg.github.com` ONLY,
  deliberately excluding `api.github.com`/`github.com` so the proxy can never
  become a write capability with the same token.

## Contract notes and rationale

- The credential comes from `githubSettings.getGithubRegistryCredential` (shared
  with `containerImages.ts`'s GHCR pulls); this folder never reads
  `DATA_DIR/settings/*` directly — settings flow in as an injected
  `ProxyCredentialProvider`.
- Never widen `GITHUB_PACKAGE_HOSTS` to `api.github.com`/`github.com`.
- The proxy is NOT stopped during graceful shutdown (`index.ts` deliberately
  omits it): a draining agent turn may be mid-build, and killing dependency
  resolution would fail the very turn the drain is waiting on. It exits with the
  process.
- Any new trust-artifact write must rebuild BOTH `bundle.pem` and the JVM
  truststore together — never let one go stale relative to the other or relative
  to the CA.

## Working notes

- A new credentialed registry host needs both an entry in `GITHUB_PACKAGE_HOSTS`
  (or an equivalent map, if it needs a different credential source) and a doc
  update.
- Prefer the existing `redactRegistrySecrets`/exec-seam patterns from
  `containerImages.ts` over inventing new ones.

## Verification commands

- Run `pnpm --filter @assistant/server test` (tests live beside their modules:
  `certificateAuthority.test.ts`, `proxyServer.test.ts`,
  `proxyEnvironment.test.ts`, `packageProxy.test.ts`).
- Run `pnpm --filter @assistant/server typecheck`.
