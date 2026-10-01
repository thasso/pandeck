import { describe, expect, test } from "vitest";
import {
  buildProxyEnvironment,
  placeholderCredentialEnvironment,
} from "./proxyEnvironment.ts";

const trust = {
  bundlePath: "/data/package-proxy/bundle.pem",
  jvmTruststorePath: "/data/package-proxy/jvm-truststore.p12",
};

describe("proxy environment bundle", () => {
  test("sets the standard proxy and CA variables every ecosystem reads", () => {
    const env = buildProxyEnvironment({
      url: "http://127.0.0.1:8899",
      secret: "s3cret",
      trust,
    });

    expect(env.HTTPS_PROXY).toBe("http://assistant:s3cret@127.0.0.1:8899");
    expect(env.https_proxy).toBe(env.HTTPS_PROXY);
    for (const key of [
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
      "CURL_CA_BUNDLE",
      "REQUESTS_CA_BUNDLE",
      "GIT_SSL_CAINFO",
    ]) {
      expect(env[key], key).toBe(trust.bundlePath);
    }
  });

  test("keeps agent API traffic off the proxy", () => {
    const env = buildProxyEnvironment({
      url: "http://127.0.0.1:8899",
      secret: "s",
      trust,
    });

    expect(env.NO_PROXY).toContain("api.anthropic.com");
    expect(env.NO_PROXY).toContain("localhost");
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  test("configures the JVM with proxy properties and the combined truststore", () => {
    const env = buildProxyEnvironment({
      url: "http://127.0.0.1:8899",
      secret: "s",
      trust,
    });

    expect(env.JAVA_TOOL_OPTIONS).toContain("-Dhttps.proxyHost=127.0.0.1");
    expect(env.JAVA_TOOL_OPTIONS).toContain("-Dhttps.proxyPort=8899");
    expect(env.JAVA_TOOL_OPTIONS).toContain(
      `-Djavax.net.ssl.trustStore=${trust.jvmTruststorePath}`,
    );
    expect(env.JAVA_TOOL_OPTIONS).toContain("-Dhttp.nonProxyHosts=");
  });

  test("keeps the secret OUT of JAVA_TOOL_OPTIONS (the JVM echoes it to stderr on every launch)", () => {
    const env = buildProxyEnvironment({
      url: "http://127.0.0.1:8899",
      secret: "s3cret-value",
      trust,
    });

    expect(env.JAVA_TOOL_OPTIONS).not.toContain("s3cret-value");
    expect(env.JAVA_TOOL_OPTIONS).not.toContain("proxyPassword");
  });

  test("carries JVM proxy credentials in GRADLE_OPTS/MAVEN_OPTS instead, with tunneling auth enabled", () => {
    const env = buildProxyEnvironment({
      url: "http://127.0.0.1:8899",
      secret: "s3cret-value",
      trust,
    });

    for (const key of ["GRADLE_OPTS", "MAVEN_OPTS"]) {
      expect(env[key], key).toContain("-Dhttps.proxyPassword=s3cret-value");
      expect(env[key], key).toContain(
        "-Djdk.http.auth.tunneling.disabledSchemes=",
      );
    }
  });

  test("omits every JVM-only variable when no truststore could be built", () => {
    const env = buildProxyEnvironment({
      url: "http://127.0.0.1:8899",
      secret: "s",
      trust: {
        bundlePath: trust.bundlePath,
        jvmTruststorePath: null,
        jvmReason: "no JVM on PATH",
      },
    });

    expect(env.JAVA_TOOL_OPTIONS).toBeUndefined();
    expect(env.GRADLE_OPTS).toBeUndefined();
    expect(env.MAVEN_OPTS).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeDefined();
  });

  test("supplies placeholder registry credentials, never a real token", () => {
    // Gradle SILENTLY SKIPS a repository whose declared credentials are null,
    // so the proxy would never see the request without these.
    const env = placeholderCredentialEnvironment();

    expect(env.GITHUB_ACTOR).toBeTruthy();
    expect(env.GITHUB_TOKEN).toBe("package-proxy-placeholder");
    expect(env.GITHUB_TOKEN).not.toMatch(/^gh[pousr]_/);
  });
});
