/**
 * The environment bundle that makes ordinary build tools use the package proxy.
 *
 * This is the whole "generic" part of the design: instead of teaching each
 * ecosystem a new repository URL, we set the standard proxy/CA variables that
 * curl, git, npm/pnpm, pip, cargo, go and the JVM already understand, so a
 * project's own `settings.gradle`/`.npmrc` keeps working unchanged.
 */
import { JVM_TRUSTSTORE_PASSWORD } from "./certificateAuthority.ts";
import type { TrustArtifacts } from "./certificateAuthority.ts";

/**
 * Hosts that must NOT go through the proxy. Agent API traffic is long-lived
 * SSE; routing it through an extra local hop buys nothing and risks stalls.
 */
const NO_PROXY_HOSTS = [
  "localhost",
  "127.0.0.1",
  "::1",
  "api.anthropic.com",
  "statsig.anthropic.com",
  "sentry.io",
];

export interface ProxyEnvironmentInput {
  /** Proxy base URL WITHOUT credentials, e.g. http://127.0.0.1:8899. */
  url: string;
  /** Per-boot secret; travels as proxy credentials in the URL. */
  secret: string;
  trust: TrustArtifacts;
}

/**
 * Build the env overlay. The proxy secret rides in the URL userinfo because
 * that is the only form every client library agrees on for proxy credentials
 * (curl, git, npm and the JVM all accept `http://user:pass@host:port`).
 */
export function buildProxyEnvironment(
  input: ProxyEnvironmentInput,
): Record<string, string> {
  const url = new URL(input.url);
  url.username = "assistant";
  url.password = input.secret;
  const proxyUrl = url.toString().replace(/\/$/, "");
  const env: Record<string, string> = {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: NO_PROXY_HOSTS.join(","),
    no_proxy: NO_PROXY_HOSTS.join(","),
    NODE_EXTRA_CA_CERTS: input.trust.bundlePath,
    SSL_CERT_FILE: input.trust.bundlePath,
    CURL_CA_BUNDLE: input.trust.bundlePath,
    REQUESTS_CA_BUNDLE: input.trust.bundlePath,
    GIT_SSL_CAINFO: input.trust.bundlePath,
  };
  if (input.trust.jvmTruststorePath) {
    // The JVM ignores HTTPS_PROXY and PEM bundles; it needs system properties
    // and a PKCS12 truststore. JAVA_TOOL_OPTIONS reaches every JVM launch,
    // including Gradle's daemon.
    //
    // The proxy SECRET deliberately does NOT go here: the JVM echoes
    // "Picked up JAVA_TOOL_OPTIONS: …" to stderr on every launch, which would
    // print it into build output and session transcripts. Credentials ride in
    // the build-tool-specific variables below, which are not echoed.
    env.JAVA_TOOL_OPTIONS = [
      `-Dhttp.proxyHost=${url.hostname}`,
      `-Dhttp.proxyPort=${url.port}`,
      `-Dhttps.proxyHost=${url.hostname}`,
      `-Dhttps.proxyPort=${url.port}`,
      `-Dhttp.nonProxyHosts=${NO_PROXY_HOSTS.filter((host) => !host.includes(":")).join("|")}`,
      `-Djavax.net.ssl.trustStore=${input.trust.jvmTruststorePath}`,
      `-Djavax.net.ssl.trustStorePassword=${JVM_TRUSTSTORE_PASSWORD}`,
    ].join(" ");
    // Java answers a proxy challenge only through an Authenticator, and only
    // for Basic — and it refuses Basic over a CONNECT tunnel until
    // `jdk.http.auth.tunneling.disabledSchemes` is cleared. Gradle and Maven
    // install that authenticator from these properties.
    const auth = [
      "-Djdk.http.auth.tunneling.disabledSchemes=",
      `-Dhttp.proxyUser=${url.username}`,
      `-Dhttp.proxyPassword=${input.secret}`,
      `-Dhttps.proxyUser=${url.username}`,
      `-Dhttps.proxyPassword=${input.secret}`,
    ].join(" ");
    env.GRADLE_OPTS = auth;
    env.MAVEN_OPTS = auth;
  }
  return env;
}

/**
 * Placeholder registry credentials. Build tools that declare credentials but
 * resolve them to null are the norm (`settings.gradle` reading `GITHUB_ACTOR`/
 * `GITHUB_TOKEN`), and Gradle SILENTLY SKIPS such a repository rather than
 * failing — so the proxy would never see the request. These placeholders make
 * the tool issue the request; the proxy replaces the header with the real one.
 */
export function placeholderCredentialEnvironment(): Record<string, string> {
  return {
    GITHUB_ACTOR: "assistant-package-proxy",
    GITHUB_TOKEN: "package-proxy-placeholder",
  };
}
