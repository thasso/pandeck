import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ForgejoApiConfig } from "../../forgejoClient.ts";
import type { ForgejoReleaseApprovalBody } from "@assistant/shared";

vi.mock("../../forgejoSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../forgejoSettings.ts")>()),
  getForgejoToolConfig: vi.fn(),
  getForgejoDefaultOwner: vi.fn(() => ""),
  getForgejoBaseUrl: vi.fn(() => ""),
}));

const { getForgejoToolConfig, getForgejoDefaultOwner, getForgejoBaseUrl } =
  await import("../../forgejoSettings.ts");
// Importing the tools module also registers the "forgejoRelease" executor.
const { forgejoCreateReleaseTool } = await import("./forgejoReleaseTools.ts");
const { resolveApproval, approvalsForSession, setApprovalBroadcastForTests } =
  await import("../../pendingApprovals.ts");

const config: ForgejoApiConfig = {
  baseUrl: "https://git.example.com",
  token: "fj_test",
};
const originalFetch = globalThis.fetch;
const HEAD_SHA = "a".repeat(40);

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

/**
 * One instance stub: `routes` answers a path suffix with [status, body], and
 * everything unrouted 404s — the shape the tool reads as "not there yet".
 * Recorded calls are the assertion surface for ORDER (tag before release).
 */
function stubForgejo(routes: Record<string, [number, unknown]>) {
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
      if (!route) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(route[1]), { status: route[0] });
    },
  ) as unknown as typeof fetch;
  return calls;
}

const repoRoutes = {
  "GET /repos/acme/app": [200, { default_branch: "main" }],
  "GET /repos/acme/app/git/commits/main": [
    200,
    { sha: HEAD_SHA, commit: { message: "Merge pull request #7\n\nbody" } },
  ],
} satisfies Record<string, [number, unknown]>;

beforeEach(() => {
  vi.mocked(getForgejoToolConfig).mockReturnValue(config);
  vi.mocked(getForgejoDefaultOwner).mockReturnValue("");
  vi.mocked(getForgejoBaseUrl).mockReturnValue(config.baseUrl);
  setApprovalBroadcastForTests(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  setApprovalBroadcastForTests(null);
  vi.clearAllMocks();
});

describe("forgejo release approvals (unified subsystem)", () => {
  test("stages a pending approval pinned to the resolved commit, writing nothing", async () => {
    const sessionId = "fj-release";
    const calls = stubForgejo(repoRoutes);

    const result = await forgejoCreateReleaseTool.execute(
      { repo: "acme/app", tag: "v0.3.0", notes: "### Tasks" } as never,
      ctxFor(sessionId) as never,
    );

    expect(result.terminate).toBe(true);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    const card = latest(sessionId);
    expect(card.kind).toBe("forgejoRelease");
    expect(card.status).toBe("pending");
    const body = card.body as ForgejoReleaseApprovalBody;
    expect(body.tag).toBe("v0.3.0");
    // The default branch was resolved to a commit, and it is the commit — not
    // the branch name — that the approved write will tag.
    expect(body.targetSha).toBe(HEAD_SHA);
    expect(body.targetSubject).toBe("Merge pull request #7");
  });

  test("approving creates the annotated tag BEFORE the release", async () => {
    const sessionId = "fj-release-approve";
    const calls = stubForgejo({
      ...repoRoutes,
      "POST /repos/acme/app/tags": [201, { name: "v0.3.0" }],
      "POST /repos/acme/app/releases": [
        201,
        { html_url: "https://git.example.com/acme/app/releases/tag/v0.3.0" },
      ],
    });

    await forgejoCreateReleaseTool.execute(
      { repo: "acme/app", tag: "v0.3.0", notes: "notes" } as never,
      ctxFor(sessionId) as never,
    );
    const { card, outcomePrompt } = await resolveApproval(
      latest(sessionId).id,
      "approved",
    );

    const writes = calls.filter((call) => call.method === "POST");
    expect(writes.map((call) => call.path)).toEqual([
      "/repos/acme/app/tags",
      "/repos/acme/app/releases",
    ]);
    expect(writes[0]!.body).toMatchObject({
      tag_name: "v0.3.0",
      target: HEAD_SHA,
      message: "Release v0.3.0",
    });
    expect(writes[1]!.body).toMatchObject({
      tag_name: "v0.3.0",
      target_commitish: HEAD_SHA,
      name: "v0.3.0",
      body: "notes",
      draft: false,
      prerelease: false,
    });
    expect(card.status).toBe("executed");
    expect(card.resultUrl).toBe(
      "https://git.example.com/acme/app/releases/tag/v0.3.0",
    );
    expect(outcomePrompt).toContain("APPROVED");
  });

  test("an existing release is refused while proposing, before any card exists", async () => {
    const sessionId = "fj-release-exists";
    stubForgejo({
      ...repoRoutes,
      "GET /repos/acme/app/releases/tags/v0.3.0": [200, { id: 4 }],
    });

    await expect(
      forgejoCreateReleaseTool.execute(
        { repo: "acme/app", tag: "v0.3.0" } as never,
        ctxFor(sessionId) as never,
      ),
    ).rejects.toThrow(/already has a release/);
    expect(approvalsForSession(sessionId)).toHaveLength(0);
  });

  test("a tag left at the same commit by a failed run is reused, not recreated", async () => {
    const sessionId = "fj-release-retry";
    const calls = stubForgejo({
      ...repoRoutes,
      "GET /repos/acme/app/tags/v0.3.0": [200, { commit: { sha: HEAD_SHA } }],
      "POST /repos/acme/app/releases": [201, {}],
    });

    await forgejoCreateReleaseTool.execute(
      { repo: "acme/app", tag: "v0.3.0" } as never,
      ctxFor(sessionId) as never,
    );
    const { card } = await resolveApproval(latest(sessionId).id, "approved");

    expect(card.status).toBe("executed");
    expect(
      calls.filter((call) => call.path === "/repos/acme/app/tags"),
    ).toHaveLength(0);
  });

  test("a tag pointing at another commit fails the execution instead of moving it", async () => {
    const sessionId = "fj-release-conflict";
    stubForgejo({
      ...repoRoutes,
      "GET /repos/acme/app/tags/v0.3.0": [
        200,
        { commit: { sha: "b".repeat(40) } },
      ],
    });

    await forgejoCreateReleaseTool.execute(
      { repo: "acme/app", tag: "v0.3.0" } as never,
      ctxFor(sessionId) as never,
    );
    const { card } = await resolveApproval(latest(sessionId).id, "approved");

    expect(card.status).toBe("failed");
    expect(card.error).toContain("already points at");
  });

  test("rejecting writes nothing", async () => {
    const sessionId = "fj-release-reject";
    const calls = stubForgejo(repoRoutes);

    await forgejoCreateReleaseTool.execute(
      { repo: "acme/app", tag: "v0.3.0" } as never,
      ctxFor(sessionId) as never,
    );
    const { card } = await resolveApproval(latest(sessionId).id, "rejected");

    expect(card.status).toBe("rejected");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  test("an unusable tag name is rejected without asking the instance", async () => {
    const calls = stubForgejo(repoRoutes);
    for (const tag of ["", "v1 0", "-v1", "v1..2", "refs/tags/"]) {
      await expect(
        forgejoCreateReleaseTool.execute(
          { repo: "acme/app", tag } as never,
          ctxFor("fj-release-badtag") as never,
        ),
      ).rejects.toThrow(/tag name/);
    }
    expect(calls).toHaveLength(0);
  });

  test("an explicit target is resolved to its commit", async () => {
    const sessionId = "fj-release-target";
    stubForgejo({
      ...repoRoutes,
      "GET /repos/acme/app/git/commits/deadbeef": [
        200,
        { sha: "c".repeat(40), commit: { message: "pinned" } },
      ],
    });

    await forgejoCreateReleaseTool.execute(
      { repo: "acme/app", tag: "v0.3.0", target: "deadbeef" } as never,
      ctxFor(sessionId) as never,
    );

    const body = latest(sessionId).body as ForgejoReleaseApprovalBody;
    expect(body.targetSha).toBe("c".repeat(40));
    expect(body.targetRef).toBe("deadbeef");
  });
});
