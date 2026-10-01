# Package proxy

Product contract: `docs/package-proxy.md`.

- The credential arrives as an injected `ProxyCredentialProvider`; this folder
  never reads `DATA_DIR/settings/*` itself.
- Never widen `GITHUB_PACKAGE_HOSTS` to `api.github.com` or `github.com`. A new
  credentialed host needs its own entry plus a `docs/package-proxy.md` update.
- The proxy is deliberately NOT stopped during graceful shutdown: a draining
  agent turn may be mid-build, and killing dependency resolution would fail the
  turn the drain is waiting on. It exits with the process.
- Any new trust-artifact write rebuilds BOTH `bundle.pem` and the JVM truststore
  together; neither may go stale relative to the other or to the CA.
- The env bundle reaches children ONLY through `setChildProcessEnvOverlay`
  (`subprocessEnv.ts`), never `process.env`: Bun's `fetch` and `node:http`
  honour it, so the server's own traffic would tunnel through the proxy. A spawn
  that would inherit or spread `process.env` passes `childProcessEnv()`.
