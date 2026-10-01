/**
 * Variables children get and the server itself must not hold: the package
 * proxy's env bundle. Bun's `fetch` and `node:http` honour `HTTP(S)_PROXY` in
 * `process.env`, so publishing the bundle there routed the server's OWN
 * outbound traffic through the proxy (docs/package-proxy.md).
 */
let childOverlay: Readonly<Record<string, string>> = {};

/** Publish the overlay every later child gets; `null` withdraws it. */
export function setChildProcessEnvOverlay(
  env: Readonly<Record<string, string>> | null,
): void {
  childOverlay = { ...(env ?? {}) };
}

/** `base` with the child overlay applied over it. */
export function withChildProcessEnv(
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return { ...base, ...childOverlay };
}

/**
 * The environment of a child that inherits the server's own: `process.env`
 * plus the overlay. Pass it wherever a spawn would otherwise inherit or spread
 * `process.env`.
 */
export function childProcessEnv(): NodeJS.ProcessEnv {
  return withChildProcessEnv(process.env);
}

/**
 * Environment passed to non-agent subprocesses that do not need the server's
 * credentials. Keep this list small and explicit. In particular, integration,
 * model-provider, and instance administration variables never pass through by
 * default.
 */
const EXTERNAL_SUBPROCESS_ENV_KEYS = [
  // Executable and user-directory discovery.
  "PATH",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  // Temporary files, locale, and timezone.
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_COLLATE",
  "LC_MONETARY",
  "LC_MESSAGES",
  "LC_PAPER",
  "LC_NAME",
  "LC_ADDRESS",
  "LC_TELEPHONE",
  "LC_MEASUREMENT",
  "LC_IDENTIFICATION",
  "LOCALE_ARCHIVE",
  "TZ",
  "TZDIR",
  // Network proxy and CA trust configuration.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NIX_SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  // Headed browser sessions on Linux desktops.
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  // Playwright installation policy and an operator-selected browser cache.
  "PLAYWRIGHT_BROWSERS_PATH",
  "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD",
] as const;

export type TrustedSubprocessEnvOverrides = Readonly<Record<string, string>>;

/**
 * Build an allowlisted environment for an external subprocess.
 *
 * `trustedOverrides` is for server-owned call-site configuration such as an
 * output directory. Never pass user-supplied environment maps into it.
 */
export function externalSubprocessEnv(
  trustedOverrides: TrustedSubprocessEnvOverrides = {},
  source: NodeJS.ProcessEnv = childProcessEnv(),
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of EXTERNAL_SUBPROCESS_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...trustedOverrides };
}
