/**
 * Package-proxy lifecycle: start/stop, settings reconciliation, and publishing
 * the environment bundle so every spawned agent, host command and build tool
 * gets it.
 *
 * The credential map is the security boundary. Only GitHub PACKAGE registries
 * are authenticated; `api.github.com` and `github.com` are deliberately absent
 * so the proxy can never be turned into a write capability with the same token.
 */
import { randomBytes } from "node:crypto";
import {
  getGithubRegistryCredential,
  getGithubSettings,
} from "../githubSettings.ts";
import { errorText } from "../errors.ts";
import { setChildProcessEnvOverlay } from "../subprocessEnv.ts";
import {
  createLeafCertificateCache,
  loadOrCreateCa,
  writeTrustArtifacts,
  type TrustArtifacts,
} from "./certificateAuthority.ts";
import {
  buildProxyEnvironment,
  placeholderCredentialEnvironment,
} from "./proxyEnvironment.ts";
import {
  startPackageProxy,
  type ProxyCredentialProvider,
  type RunningPackageProxy,
} from "./proxyServer.ts";

/** GitHub package registries the proxy authenticates to. Read surfaces only. */
export const GITHUB_PACKAGE_HOSTS = [
  "maven.pkg.github.com",
  "npm.pkg.github.com",
  "nuget.pkg.github.com",
] as const;

export interface PackageProxyStatus {
  running: boolean;
  url?: string;
  hosts?: string[];
  /** Whether the JVM half is wired (needs a JDK for the truststore). */
  jvmConfigured?: boolean;
  /** Why the proxy is not running, or why part of it is degraded. */
  reason?: string;
}

interface ProxyState {
  proxy: RunningPackageProxy;
  env: Record<string, string>;
  trust: TrustArtifacts;
}

let state: ProxyState | null = null;
let starting: Promise<void> | null = null;

/** Enabled when the GitHub integration is on, its token is set, and the toggle is on. */
function shouldRun(): { enabled: boolean; reason?: string } {
  const settings = getGithubSettings();
  if (!settings.enabled)
    return { enabled: false, reason: "the GitHub integration is disabled" };
  if (!settings.tokenConfigured)
    return { enabled: false, reason: "no GitHub token is configured" };
  if (!settings.packageProxyEnabled)
    return {
      enabled: false,
      reason: "the package proxy is switched off in Settings → GitHub",
    };
  return { enabled: true };
}

function credentialHosts(): Map<string, ProxyCredentialProvider> {
  const provider: ProxyCredentialProvider = () => getGithubRegistryCredential();
  return new Map(GITHUB_PACKAGE_HOSTS.map((host) => [host, provider]));
}

/** Start the proxy when settings allow it; a no-op when already running. */
export async function startPackageProxyIfEnabled(): Promise<PackageProxyStatus> {
  if (starting) await starting;
  if (state) return packageProxyStatus();
  const decision = shouldRun();
  if (!decision.enabled)
    return {
      running: false,
      ...(decision.reason ? { reason: decision.reason } : {}),
    };

  let resolveStart: () => void = () => {};
  starting = new Promise<void>((resolve) => {
    resolveStart = resolve;
  });
  try {
    const ca = await loadOrCreateCa();
    const trust = await writeTrustArtifacts(ca);
    const secret = randomBytes(24).toString("hex");
    const portOverride = Number(process.env.ASSISTANT_PACKAGE_PROXY_PORT ?? "");
    const proxy = await startPackageProxy({
      credentialHosts: credentialHosts(),
      ca,
      leafFor: createLeafCertificateCache(ca),
      secret,
      ...(Number.isFinite(portOverride) && portOverride > 0
        ? { port: portOverride }
        : {}),
    });
    const env = {
      ...buildProxyEnvironment({ url: proxy.url, secret, trust }),
      ...placeholderCredentialEnvironment(),
    };
    // Children only, never `process.env`: Bun's fetch and node:http would
    // route the server's own traffic through the proxy.
    setChildProcessEnvOverlay(env);
    state = { proxy, env, trust };
    if (!trust.jvmTruststorePath) {
      console.warn(
        `[package-proxy] JVM builds will NOT use the proxy: ${trust.jvmReason ?? "no JVM truststore"}`,
      );
    }
    return packageProxyStatus();
  } catch (err) {
    console.warn(`[package-proxy] failed to start: ${errorText(err)}`);
    return { running: false, reason: `failed to start: ${errorText(err)}` };
  } finally {
    resolveStart();
    starting = null;
  }
}

export async function stopPackageProxy(): Promise<void> {
  if (starting) await starting;
  if (!state) return;
  const current = state;
  state = null;
  setChildProcessEnvOverlay(null);
  await current.proxy.close();
}

/** Re-evaluate settings: start, stop, or leave running. */
export async function reconcilePackageProxy(): Promise<PackageProxyStatus> {
  const decision = shouldRun();
  if (!decision.enabled) {
    await stopPackageProxy();
    return {
      running: false,
      ...(decision.reason ? { reason: decision.reason } : {}),
    };
  }
  return startPackageProxyIfEnabled();
}

export function packageProxyStatus(): PackageProxyStatus {
  if (!state) {
    const decision = shouldRun();
    return {
      running: false,
      ...(decision.reason ? { reason: decision.reason } : {}),
    };
  }
  return {
    running: true,
    url: state.proxy.url,
    hosts: [...GITHUB_PACKAGE_HOSTS],
    jvmConfigured: Boolean(state.trust.jvmTruststorePath),
    ...(state.trust.jvmTruststorePath
      ? {}
      : { reason: state.trust.jvmReason ?? "no JVM truststore" }),
  };
}

/** The env bundle currently published (tests/diagnostics). */
export function packageProxyEnvironment(): Record<string, string> | null {
  return state ? { ...state.env } : null;
}
