/**
 * `project_create`: the proposal writes nothing, and approval creates the
 * repository on the provider, registers the Project, and clones it. Provider
 * APIs are stubbed through `fetch`; the clone runs against a real temp bare
 * repository over file://.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ProjectCreateApprovalBody } from "@assistant/shared";

vi.mock("../../forgejoSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../forgejoSettings.ts")>()),
  getForgejoToolConfig: vi.fn(),
  getForgejoConfigIfAvailable: vi.fn(),
}));
vi.mock("../../githubSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../githubSettings.ts")>()),
  getGithubToolConfig: vi.fn(),
  getGithubConfigIfAvailable: vi.fn(),
}));

const tmp = mkdtempSync(join(tmpdir(), "project-create-tool-"));
const { updateSettings } = await import("../../settings.ts");
updateSettings({ projectsRoot: join(tmp, "projects") });

const forgejoSettings = await import("../../forgejoSettings.ts");
const githubSettings = await import("../../githubSettings.ts");
const { getProject, upsertProject } = await import("../../projectRegistry.ts");
const { noMainRepoMessage } =
  await import("../../worktrees/worktreeResolve.ts");
// Importing the tool module also registers the "projectCreate" executor.
const { projectCreateTool } = await import("./projectCreateTool.ts");
const { projectRegistryWriteTool } = await import("./projectRegistryTools.ts");
const { resolveApproval, approvalsForSession, setApprovalBroadcastForTests } =
  await import("../../pendingApprovals.ts");

const forgejo = { baseUrl: "https://git.example.com", token: "fj_test" };
const github = { token: "gh_test", apiBaseUrl: "https://api.github.com" };
const originalFetch = globalThis.fetch;

const ctxFor = (sessionId: string) => ({
  toolCallId: "c",
  session: {
    sessionId,
    harness: "pi" as const,
    agentType: "developer" as const,
  },
  signal: new AbortController().signal,
});
const latest = (sessionId: string) => approvalsForSession(sessionId).at(-1)!;
const propose = (sessionId: string, params: Record<string, unknown>) =>
  projectCreateTool.execute(params as never, ctxFor(sessionId) as never);
const approve = (sessionId: string) =>
  resolveApproval(latest(sessionId).id, "approved");

/**
 * A provider stub: `routes` answers `METHOD /path` with [status, body];
 * anything unrouted 404s, which the tool reads as "not there yet". Paths drop
 * the API prefix, so GitHub and Forgejo routes read the same.
 */
function stubApi(routes: Record<string, [number, unknown]>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  globalThis.fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace("/api/v1", "");
      const method = init?.method ?? "GET";
      calls.push({
        method,
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const route = routes[`${method} ${path}`];
      if (!route)
        return new Response('{"message":"Not Found"}', { status: 404 });
      return new Response(JSON.stringify(route[1]), { status: route[0] });
    },
  ) as unknown as typeof fetch;
  return calls;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  );
}

beforeEach(() => {
  vi.mocked(forgejoSettings.getForgejoToolConfig).mockReturnValue(forgejo);
  vi.mocked(forgejoSettings.getForgejoConfigIfAvailable).mockReturnValue(
    forgejo,
  );
  vi.mocked(githubSettings.getGithubToolConfig).mockReturnValue(github);
  vi.mocked(githubSettings.getGithubConfigIfAvailable).mockReturnValue(github);
  setApprovalBroadcastForTests(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  setApprovalBroadcastForTests(null);
  vi.clearAllMocks();
});

describe("project_create", () => {
  test("stages a pending card and writes nothing", async () => {
    const calls = stubApi({ "GET /user": [200, { login: "alice" }] });

    const result = await propose("pc-stage", {
      project: {
        name: "Review Agents",
        key: "RA",
        description: "Agents that review code changes.\n\nMore detail.",
      },
      repository: { provider: "forgejo" },
    });

    expect(result.terminate).toBe(true);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(getProject("review-agents")).toBeNull();
    const card = latest("pc-stage");
    expect(card.kind).toBe("projectCreate");
    expect(card.status).toBe("pending");
    const body = card.body as ProjectCreateApprovalBody;
    expect(body.project).toMatchObject({ id: "review-agents", key: "RA" });
    // Owner defaults to the token's account; repositories default private.
    expect(body.repository).toEqual({
      mode: "create",
      provider: "forgejo",
      owner: "alice",
      name: "review-agents",
      private: true,
      description: "Agents that review code changes.",
    });
    expect(body.cloneDir).toBe(join(tmp, "projects", "review-agents"));
  });

  test("approving creates an initialized Forgejo repository, then registers the project", async () => {
    const calls = stubApi({
      "GET /user": [200, { login: "alice" }],
      "POST /user/repos": [
        201,
        {
          ssh_url: "ssh://git@git.example.com:2222/alice/fresh.git",
          html_url: "https://git.example.com/alice/fresh",
        },
      ],
    });
    await propose("pc-forgejo", {
      project: { name: "Fresh", key: "FR" },
      repository: { provider: "forgejo" },
      clone: false,
    });

    const { card } = await approve("pc-forgejo");

    expect(card.status).toBe("executed");
    expect(card.resultUrl).toBe("https://git.example.com/alice/fresh");
    const create = calls.find((call) => call.method === "POST")!;
    expect(create.body).toMatchObject({
      name: "fresh",
      private: true,
      auto_init: true,
      default_branch: "main",
    });
    expect(getProject("fresh")?.repoUrl).toBe(
      "ssh://git@git.example.com:2222/alice/fresh.git",
    );
  });

  test("an organization owner creates under the organization on GitHub", async () => {
    const calls = stubApi({
      "GET /user": [200, { login: "alice" }],
      "POST /orgs/acme/repos": [
        201,
        {
          ssh_url: "git@github.com:acme/widget.git",
          html_url: "https://github.com/acme/widget",
        },
      ],
    });
    await propose("pc-github-org", {
      project: { name: "Widget", key: "WG" },
      repository: { provider: "github", owner: "acme", private: false },
      clone: false,
    });
    const { card } = await approve("pc-github-org");

    expect(card.status).toBe("executed");
    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/orgs/acme/repos",
      body: { name: "widget", private: false, auto_init: true },
    });
    expect(getProject("widget")?.repoUrl).toBe(
      "git@github.com:acme/widget.git",
    );
  });

  test("refuses a repository that already exists", async () => {
    stubApi({
      "GET /user": [200, { login: "alice" }],
      "GET /repos/alice/taken": [200, { empty: false }],
    });
    await expect(
      propose("pc-taken", {
        project: { name: "Taken", key: "TK" },
        repository: { provider: "forgejo" },
      }),
    ).rejects.toThrow(/already exists on Forgejo/);
    expect(approvalsForSession("pc-taken")).toHaveLength(0);
  });

  test("refuses an id that is already a project", async () => {
    upsertProject({ id: "existing", name: "Existing", key: "EX" });
    await expect(
      propose("pc-dup", { project: { name: "Existing", key: "EX" } }),
    ).rejects.toThrow(/already exists/);
  });

  test("refuses provider and url together", async () => {
    await expect(
      propose("pc-both", {
        project: { name: "Both", key: "BO" },
        repository: {
          provider: "forgejo",
          url: "ssh://git@git.example.com/acme/both.git",
        },
      }),
    ).rejects.toThrow(/not both/);
  });

  test("linking an EMPTY Forgejo repository commits a README on approval", async () => {
    const url = "ssh://git@git.example.com:2222/acme/review-bots.git";
    const calls = stubApi({
      "GET /repos/acme/review-bots": [200, { empty: true }],
      "POST /repos/acme/review-bots/contents/README.md": [201, {}],
    });
    await propose("pc-seed", {
      project: {
        name: "Review Bots",
        key: "RB",
        description: "Bots that review.",
      },
      repository: { url },
      clone: false,
    });
    const body = latest("pc-seed").body as ProjectCreateApprovalBody;
    expect(body.repository).toEqual({
      mode: "link",
      url,
      provider: "forgejo",
      repo: "acme/review-bots",
      seedReadme: true,
    });

    const { card } = await approve("pc-seed");

    expect(card.status).toBe("executed");
    const seed = calls.find((call) => call.method === "POST")!;
    expect(seed.path).toBe("/repos/acme/review-bots/contents/README.md");
    const content = (seed.body as { content: string }).content;
    expect(Buffer.from(content, "base64").toString("utf8")).toBe(
      "# Review Bots\n\nBots that review.\n",
    );
    expect(getProject("review-bots")?.repoUrl).toBe(url);
  });

  test("clones a linked repository, and says so when it has no commits", async () => {
    const bare = join(tmp, "remote", "empty.git");
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "--bare", "-b", "main");
    stubApi({});

    await propose("pc-clone", {
      project: { name: "Unborn", key: "UB" },
      repository: { url: `file://${bare}` },
    });
    const { card } = await approve("pc-clone");

    expect(card.status).toBe("executed");
    expect(card.resultSummary).toMatch(/cloned into/);
    expect(card.resultSummary).toMatch(/no commits yet/);
    const project = getProject("unborn")!;
    expect(project.localPaths?.[0]?.path).toBe(join(tmp, "projects", "unborn"));
    await expect(noMainRepoMessage(project)).resolves.toMatch(
      /has no commits yet/,
    );
  });
});

describe("project_create approval re-checks", () => {
  test("refuses before any remote write when the projects root moved", async () => {
    const calls = stubApi({ "GET /user": [200, { login: "alice" }] });
    await propose("pc-root-moved", {
      project: { name: "Moved Root", key: "MR" },
      repository: { provider: "forgejo" },
    });
    updateSettings({ projectsRoot: join(tmp, "elsewhere") });
    try {
      const { card } = await approve("pc-root-moved");
      expect(card.status).toBe("failed");
      expect(card.error).toMatch(/projects folder changed/);
    } finally {
      updateSettings({ projectsRoot: join(tmp, "projects") });
    }
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    expect(getProject("moved-root")).toBeNull();
  });

  test("refuses before any remote write when the clone folder appeared", async () => {
    const calls = stubApi({ "GET /user": [200, { login: "alice" }] });
    await propose("pc-dir-appeared", {
      project: { name: "Squatted", key: "SQ" },
      repository: { provider: "forgejo" },
    });
    mkdirSync(join(tmp, "projects", "squatted"), { recursive: true });

    const { card } = await approve("pc-dir-appeared");

    expect(card.status).toBe("failed");
    expect(card.error).toMatch(/appeared since this was proposed/);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  test("a clone failure after creation keeps the created repository on the card", async () => {
    const missing = `file://${join(tmp, "nowhere", "gone.git")}`;
    stubApi({
      "GET /user": [200, { login: "alice" }],
      "POST /user/repos": [201, { ssh_url: missing }],
    });
    await propose("pc-clone-fails", {
      project: { name: "Half Done", key: "HD" },
      repository: { provider: "forgejo" },
    });

    const { card } = await approve("pc-clone-fails");

    expect(card.status).toBe("failed");
    expect(card.error).toMatch(
      /Cloning the repository failed after it created alice\/half-done/,
    );
    expect((card.body as ProjectCreateApprovalBody).resultRepoUrl).toBe(
      missing,
    );
    expect(getProject("half-done")?.repoUrl).toBe(missing);
  });

  test("a linked repository emptied after the proposal still gets its README", async () => {
    const url = "ssh://git@git.example.com/acme/emptied.git";
    const routes: Record<string, [number, unknown]> = {
      "GET /repos/acme/emptied": [200, { empty: false }],
      "POST /repos/acme/emptied/contents/README.md": [201, {}],
    };
    const calls = stubApi(routes);
    await propose("pc-emptied", {
      project: { name: "Emptied", key: "EM" },
      repository: { url },
      clone: false,
    });
    expect(
      (latest("pc-emptied").body as ProjectCreateApprovalBody).repository,
    ).not.toHaveProperty("seedReadme");
    routes["GET /repos/acme/emptied"] = [200, { empty: true }];

    const { card } = await approve("pc-emptied");

    expect(card.status).toBe("executed");
    expect(calls.at(-1)?.path).toBe("/repos/acme/emptied/contents/README.md");
  });
});

describe("project_create repository URLs", () => {
  test("refuses a credential-bearing URL without echoing it", async () => {
    stubApi({});
    for (const url of [
      "https://acme:ghp_example_fake_token@github.com/acme/app.git",
      "https://ghp_example_fake_token@github.com/acme/app.git",
      "https://github.com/acme/app.git?token=ghp_SECRET",
    ]) {
      const error = await propose("pc-secret", {
        project: { name: "Secret", key: "SE" },
        repository: { url },
      }).catch((caught: unknown) => caught as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/without credentials/);
      expect((error as Error).message).not.toContain("ghp_example_fake_token");
      expect((error as Error).message).not.toContain("ghp_SECRET");
    }
    expect(approvalsForSession("pc-secret")).toHaveLength(0);
  });

  test("an ssh user is not a credential", async () => {
    stubApi({ "GET /repos/acme/ssh-ok": [200, { empty: false }] });
    await propose("pc-ssh-user", {
      project: { name: "SSH OK", key: "SO" },
      repository: { url: "ssh://git@git.example.com:2222/acme/ssh-ok.git" },
      clone: false,
    });
    expect(latest("pc-ssh-user").status).toBe("pending");
  });

  test("strips a Forgejo base-path prefix from an HTTPS clone URL", async () => {
    const prefixed = { baseUrl: "https://git.example.com/git", token: "t" };
    vi.mocked(forgejoSettings.getForgejoToolConfig).mockReturnValue(prefixed);
    vi.mocked(forgejoSettings.getForgejoConfigIfAvailable).mockReturnValue(
      prefixed,
    );
    const calls = stubApi({
      "GET /git/repos/acme/prefixed": [200, { empty: false }],
    });
    await propose("pc-prefix", {
      project: { name: "Prefixed", key: "PF" },
      repository: { url: "https://git.example.com/git/acme/prefixed.git" },
      clone: false,
    });
    expect(calls[0]?.path).toBe("/git/repos/acme/prefixed");
    expect(
      (latest("pc-prefix").body as ProjectCreateApprovalBody).repository,
    ).toMatchObject({ provider: "forgejo", repo: "acme/prefixed" });
  });
});

describe("project_registry_write upsertProject", () => {
  const write = (params: Record<string, unknown>) =>
    (projectRegistryWriteTool.execute as (p: unknown) => Promise<unknown>)(
      params,
    );

  test("routes a NEW project to project_create", async () => {
    await expect(
      write({
        operation: "upsertProject",
        project: { name: "Brand New", key: "BN" },
      }),
    ).rejects.toThrow(/project_create/);
    expect(getProject("brand-new")).toBeNull();
  });

  test("still updates an existing project", async () => {
    upsertProject({ id: "kept", name: "Kept", key: "KP" });
    await write({
      operation: "upsertProject",
      project: { id: "kept", name: "Kept", key: "KP", description: "Now." },
    });
    expect(getProject("kept")?.description).toBe("Now.");
  });
});
