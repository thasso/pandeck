import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { hostingProviderFor } from "./gitHosting.ts";
import { getGithubToolConfig, updateGithubSettings } from "./githubSettings.ts";
import { updateForgejoSettings } from "./forgejoSettings.ts";

vi.mock("./githubSettings.ts", async (importActual) => {
  const actual = await importActual<typeof import("./githubSettings.ts")>();
  return { ...actual, getGithubToolConfig: vi.fn(actual.getGithubToolConfig) };
});

beforeEach(() => {
  updateGithubSettings({ enabled: true, token: "github-fixture" });
  updateForgejoSettings({
    enabled: true,
    baseUrl: "https://git.example.com:8443/root/api/v1/",
    token: "forgejo-fixture",
  });
});
afterEach(() => vi.restoreAllMocks());

const repository = { owner: "a b", repo: "r#1" };

test.each(["github", "forgejo"] as const)(
  "explicit %s factory preserves config, identity, encoding and parent cancellation",
  async (service) => {
    if (service === "github")
      vi.mocked(getGithubToolConfig).mockReturnValueOnce({
        token: "custom",
        apiBaseUrl: "https://github-api.example.invalid",
      });
    const controller = new AbortController();
    const provider = hostingProviderFor(
      { service, ...repository },
      controller.signal,
    );
    expect(provider.kind).toBe(service);
    expect(provider.repository).toEqual({
      host: service === "github" ? "github.com" : "git.example.com:8443",
      ...repository,
    });
    expect(provider.repoWebUrl).toBe(
      service === "github"
        ? "https://github.com/a b/r#1"
        : "https://git.example.com:8443/root/a b/r#1",
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        expect(String(input)).toBe(
          service === "github"
            ? "https://github-api.example.invalid/repos/a%20b/r%231/pulls/2"
            : "https://git.example.com:8443/root/api/v1/repos/a%20b/r%231/pulls/2",
        );
        expect(new Headers(init?.headers).get("authorization")).toBe(
          service === "github" ? "Bearer custom" : "token forgejo-fixture",
        );
        controller.abort();
        expect(init?.signal?.aborted).toBe(true);
        return new Response(JSON.stringify({ body: "text" }));
      });
    expect(fetch).not.toHaveBeenCalled();
    expect(await provider.pullRequestBody(2)).toBe("text");
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test("factory uses tool settings errors, never the other integration", () => {
  updateGithubSettings({ enabled: false });
  expect(() =>
    hostingProviderFor({ service: "github", ...repository }),
  ).toThrow("GitHub tools are disabled");
  updateGithubSettings({ enabled: true, clearToken: true });
  expect(() =>
    hostingProviderFor({ service: "github", ...repository }),
  ).toThrow("Missing GitHub token");
  updateForgejoSettings({ enabled: false });
  expect(() =>
    hostingProviderFor({ service: "forgejo", ...repository }),
  ).toThrow("Forgejo tools are disabled");
  updateForgejoSettings({ enabled: true, baseUrl: "" });
  expect(() =>
    hostingProviderFor({ service: "forgejo", ...repository }),
  ).toThrow("Missing Forgejo base URL");
  expect(() =>
    hostingProviderFor({ service: "other", ...repository } as never),
  ).toThrow("Unsupported git hosting service");
});

test("Forgejo permits anonymous public reads but refuses writes without a token", async () => {
  updateForgejoSettings({ clearToken: true });
  const provider = hostingProviderFor({ service: "forgejo", ...repository });
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_input, init) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return new Response(JSON.stringify({ body: null }));
    });
  expect(await provider.pullRequestBody(1)).toBe("");
  await expect(
    provider.createPullRequest({ title: "T", head: "feature", base: "main" }),
  ).rejects.toThrow("A Forgejo access token is not configured");
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each([undefined, false, true])(
  "GitHub serializes draft=%s only when supplied",
  async (draft) => {
    const provider = hostingProviderFor({
      service: "github",
      owner: "acme",
      repo: "repo",
    });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          title: "T",
          body: "",
          head: "feature",
          base: "main",
          ...(draft !== undefined ? { draft } : {}),
        });
        return new Response(JSON.stringify({ number: 1 }));
      });
    await provider.createPullRequest({
      title: "T",
      head: "feature",
      base: "main",
      ...(draft !== undefined ? { draft } : {}),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test.each(["github", "forgejo"] as const)(
  "%s body edit returns only optional URL metadata",
  async (service) => {
    const provider = hostingProviderFor({
      service,
      owner: "acme",
      repo: "repo",
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({ body: "" });
      return new Response(JSON.stringify({}));
    });
    expect(await provider.editPullRequestBody(1, "")).toEqual({});
  },
);
