import { afterEach, describe, expect, test, vi } from "vitest";
import type { GithubSettings } from "@assistant/shared";

vi.mock("../githubSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../githubSettings.ts")>()),
  getGithubSettings: vi.fn(),
  getGithubRegistryCredential: vi.fn(),
}));

const { getGithubSettings, getGithubRegistryCredential } =
  await import("../githubSettings.ts");
const {
  packageProxyEnvironment,
  packageProxyStatus,
  reconcilePackageProxy,
  startPackageProxyIfEnabled,
  stopPackageProxy,
  GITHUB_PACKAGE_HOSTS,
} = await import("./packageProxy.ts");
const { childProcessEnv, externalSubprocessEnv } =
  await import("../subprocessEnv.ts");

function settings(overrides: Partial<GithubSettings> = {}): GithubSettings {
  return {
    enabled: true,
    tokenConfigured: true,
    defaultOwner: "",
    packageProxyEnabled: true,
    ...overrides,
  };
}

afterEach(async () => {
  await stopPackageProxy();
  vi.clearAllMocks();
});

describe("package proxy lifecycle", () => {
  test("starts when the GitHub integration is on and publishes the env bundle to children", async () => {
    vi.mocked(getGithubSettings).mockReturnValue(settings());
    vi.mocked(getGithubRegistryCredential).mockResolvedValue({
      username: "octo",
      token: "ghp_token_value_0123456789",
    });

    const status = await startPackageProxyIfEnabled();

    expect(status.running).toBe(true);
    expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(status.hosts).toEqual([...GITHUB_PACKAGE_HOSTS]);
    const children = childProcessEnv();
    expect(children.HTTPS_PROXY).toContain(new URL(status.url!).host);
    expect(children.NODE_EXTRA_CA_CERTS).toContain("package-proxy");
    // The published bundle carries a placeholder, never the real token.
    expect(children.GITHUB_TOKEN).toBe("package-proxy-placeholder");
    expect(JSON.stringify(packageProxyEnvironment())).not.toContain(
      "ghp_token_value_0123456789",
    );
    // Allowlisted external processes (the browser MCP) get it too.
    expect(externalSubprocessEnv().HTTPS_PROXY).toBe(children.HTTPS_PROXY);
  });

  test("never publishes the bundle on the server's own process.env", async () => {
    // Bun's fetch and node:http honour HTTP(S)_PROXY for the process holding
    // them, so the server's own traffic would tunnel through its proxy.
    const before = { ...process.env };
    vi.mocked(getGithubSettings).mockReturnValue(settings());

    await startPackageProxyIfEnabled();

    const bundle = packageProxyEnvironment();
    expect(bundle).not.toBeNull();
    for (const key of Object.keys(bundle!))
      expect(process.env[key], key).toBe(before[key]);
    await stopPackageProxy();
    expect(process.env).toEqual(before);
  });

  test("withdraws every published variable on stop", async () => {
    vi.mocked(getGithubSettings).mockReturnValue(settings());
    await startPackageProxyIfEnabled();

    const bundle = packageProxyEnvironment()!;

    await stopPackageProxy();

    for (const key of Object.keys(bundle))
      expect(childProcessEnv()[key], key).toBe(process.env[key]);
    expect(packageProxyEnvironment()).toBeNull();
    expect(packageProxyStatus().running).toBe(false);
  });

  test("stays off — with a reason — when the integration or the toggle is off", async () => {
    for (const [overrides, expected] of [
      [{ enabled: false }, /integration is disabled/],
      [{ tokenConfigured: false }, /no GitHub token/],
      [{ packageProxyEnabled: false }, /switched off/],
    ] as const) {
      vi.mocked(getGithubSettings).mockReturnValue(settings(overrides));

      const status = await startPackageProxyIfEnabled();

      expect(status.running).toBe(false);
      expect(status.reason).toMatch(expected);
      expect(childProcessEnv()).toEqual(process.env);
    }
  });

  test("reconcile stops a running proxy once the toggle goes off", async () => {
    vi.mocked(getGithubSettings).mockReturnValue(settings());
    await startPackageProxyIfEnabled();
    expect(packageProxyStatus().running).toBe(true);

    vi.mocked(getGithubSettings).mockReturnValue(
      settings({ packageProxyEnabled: false }),
    );
    const status = await reconcilePackageProxy();

    expect(status.running).toBe(false);
    expect(childProcessEnv()).toEqual(process.env);
  });

  test("does not authenticate anything outside the GitHub package registries", () => {
    // api.github.com / github.com would turn a read-only package capability
    // into a full API (and write) capability with the same token.
    expect([...GITHUB_PACKAGE_HOSTS]).not.toContain("api.github.com");
    expect([...GITHUB_PACKAGE_HOSTS]).not.toContain("github.com");
    expect(
      [...GITHUB_PACKAGE_HOSTS].every((host) =>
        host.endsWith(".pkg.github.com"),
      ),
    ).toBe(true);
  });
});
