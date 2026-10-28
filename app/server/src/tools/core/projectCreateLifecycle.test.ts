/**
 * `project_create`'s clone-folder checks on the Worker (W5): the proposal and
 * the approval's pre-check reject before any card or remote write, and a
 * Worker failure at the late check or inside the clone fails like a clone
 * failure, keeping its classification, and recovers through `cloneRepo`
 * (`docs/workers.md`, W5). Provider APIs are stubbed through `fetch`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  ApprovalCard,
  ProjectCreateApprovalBody,
} from "@assistant/shared";

vi.mock("../../forgejoSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../forgejoSettings.ts")>()),
  getForgejoToolConfig: vi.fn(),
  getForgejoConfigIfAvailable: vi.fn(),
}));

/** Every executor's thrown errors, as thrown: the card keeps only the text. */
const executed = vi.hoisted(() => ({
  thrown: [] as unknown[],
  executors: new Map<
    string,
    {
      execute(
        card: ApprovalCard,
        context: Record<string, unknown>,
      ): Promise<unknown>;
    }
  >(),
}));
vi.mock("../../pendingApprovals.ts", async (importActual) => {
  const actual =
    await importActual<typeof import("../../pendingApprovals.ts")>();
  return {
    ...actual,
    registerApprovalExecutor: ((kind, executor) => {
      const wrapped = {
        ...executor,
        async execute(card: ApprovalCard, context: Record<string, unknown>) {
          try {
            return await executor.execute(card, context);
          } catch (error) {
            executed.thrown.push(error);
            throw error;
          }
        },
      };
      executed.executors.set(kind, wrapped);
      return actual.registerApprovalExecutor(kind, wrapped);
    }) as typeof actual.registerApprovalExecutor,
  };
});

const tmp = mkdtempSync(join(tmpdir(), "project-create-lifecycle-"));
const { updateSettings } = await import("../../settings.ts");
updateSettings({ projectsRoot: join(tmp, "projects") });

const forgejoSettings = await import("../../forgejoSettings.ts");
const { getProject } = await import("../../projectRegistry.ts");
const { projectCreateTool } = await import("./projectCreateTool.ts");
const { projectRegistryWriteTool } = await import("./projectRegistryTools.ts");
const { resolveApproval, approvalsForSession, setApprovalBroadcastForTests } =
  await import("../../pendingApprovals.ts");
const { isWorkerFailure } = await import("../../workers/fileClient.ts");
const { scriptWorkerAnswersForTests } =
  await import("../../test/workerAnswers.ts");
const { FILE_METHODS } = await import("../../workerProtocol/fileMethods.ts");
const { LIFECYCLE_METHODS } =
  await import("../../workerProtocol/lifecycleMethods.ts");

const forgejo = { baseUrl: "https://git.example.com", token: "fj_test" };
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

/** Answers `METHOD /path` with [status, body]; anything unrouted 404s. */
function stubApi(routes: Record<string, [number, unknown]>) {
  const calls: Array<{ method: string; path: string }> = [];
  globalThis.fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace("/api/v1", "");
      const method = init?.method ?? "GET";
      calls.push({ method, path });
      const route = routes[`${method} ${path}`];
      if (!route)
        return new Response('{"message":"Not Found"}', { status: 404 });
      return new Response(JSON.stringify(route[1]), { status: route[0] });
    },
  ) as unknown as typeof fetch;
  return calls;
}

/** A bare repository with one commit on `main`, as a file:// URL. */
function seededRemote(name: string): string {
  const bare = join(tmp, "remote", `${name}.git`);
  const seed = join(tmp, "remote", `${name}-seed`);
  execFileSync("git", ["init", "--bare", "-b", "main", bare]);
  execFileSync("git", ["clone", "--quiet", bare, seed]);
  writeFileSync(join(seed, "readme.md"), "hello\n");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
      { cwd: seed },
    );
  git("add", "-A");
  git("commit", "-qm", "seed");
  git("push", "-q", "origin", "main");
  return `file://${bare}`;
}

type Script = ReturnType<typeof scriptWorkerAnswersForTests>;
const scripts: Script[] = [];
function script(...args: Parameters<typeof scriptWorkerAnswersForTests>) {
  const armed = scriptWorkerAnswersForTests(...args);
  scripts.push(armed);
  return armed;
}

beforeEach(() => {
  vi.mocked(forgejoSettings.getForgejoToolConfig).mockReturnValue(forgejo);
  vi.mocked(forgejoSettings.getForgejoConfigIfAvailable).mockReturnValue(
    forgejo,
  );
  setApprovalBroadcastForTests(() => {});
  executed.thrown.length = 0;
});
afterEach(() => {
  while (scripts.length > 0) scripts.pop()!.disarm();
  globalThis.fetch = originalFetch;
  setApprovalBroadcastForTests(null);
  vi.clearAllMocks();
});

const cloneDirOf = (id: string) => join(tmp, "projects", id);

describe("project_create's clone-folder checks on the Worker", () => {
  test("(c) a Worker failure at the proposal's check throws, with no card", async () => {
    stubApi({ "GET /user": [200, { login: "alice" }] });
    script(FILE_METHODS.exists, [
      {
        match: (request) => request.path === cloneDirOf("probe-proposal"),
        action: "fail",
      },
    ]);
    await expect(
      propose("pcl-proposal", {
        project: { name: "Probe Proposal", key: "PP" },
        repository: { provider: "forgejo" },
      }),
    ).rejects.toSatisfy(isWorkerFailure);
    expect(approvalsForSession("pcl-proposal")).toEqual([]);
  });

  test("(d) a Worker failure at the approval's pre-check refuses before any remote write", async () => {
    const calls = stubApi({ "GET /user": [200, { login: "alice" }] });
    await propose("pcl-precheck", {
      project: { name: "Probe Precheck", key: "PQ" },
      repository: { provider: "forgejo" },
    });
    script(FILE_METHODS.exists, [
      {
        match: (request) => request.path === cloneDirOf("probe-precheck"),
        action: "fail",
      },
    ]);

    const { card } = await approve("pcl-precheck");

    expect(card.status).toBe("failed");
    expect(executed.thrown.map(isWorkerFailure)).toEqual([true]);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    expect(getProject("probe-precheck")).toBeNull();
  });

  for (const at of ["late check", "clone's mkdir"] as const)
    test(`(${at === "late check" ? "e" : "f"}) a Worker failure at the ${at} fails like a clone failure and recovers by cloneRepo`, async () => {
      const id = at === "late check" ? "probe-late" : "probe-mkdir";
      const remote = seededRemote(id);
      stubApi({
        "GET /user": [200, { login: "alice" }],
        "POST /user/repos": [201, { ssh_url: remote }],
      });
      const session = `pcl-${id}`;
      await propose(session, {
        project: {
          name: id === "probe-late" ? "Probe Late" : "Probe Mkdir",
          key: id === "probe-late" ? "PL" : "PM",
        },
        repository: { provider: "forgejo" },
      });
      const cloneDir = cloneDirOf(id);
      const armed =
        at === "late check"
          ? // The approval's pre-check passes; the late check fails.
            script(FILE_METHODS.exists, [
              {
                match: (request) => request.path === cloneDir,
                skip: 1,
                times: 1,
                action: "fail",
              },
            ])
          : script(LIFECYCLE_METHODS.mkdir, [
              {
                match: (request) => request.path === join(tmp, "projects"),
                action: "fail",
              },
            ]);

      const { card } = await approve(session);

      expect(armed.seen.some((request) => request.action === "fail")).toBe(
        true,
      );
      expect(card.status).toBe("failed");
      expect(card.error).toMatch(
        new RegExp(
          `^Cloning the repository failed after it created alice/${id} and registered project ${id}: Scripted Worker failure for `,
        ),
      );
      expect(executed.thrown).toHaveLength(1);
      expect(isWorkerFailure(executed.thrown[0])).toBe(true);
      const body = card.body as ProjectCreateApprovalBody;
      expect(body.resultRepoUrl).toBe(remote);
      expect(getProject(id)?.repoUrl).toBe(remote);
      expect(getProject(id)?.localPaths ?? []).toEqual([]);
      expect(existsSync(cloneDir)).toBe(false);

      // Replaying the approval refuses: the project is already registered.
      await expect(
        executed.executors.get("projectCreate")!.execute(card, {}),
      ).rejects.toThrow();
      expect(getProject(id)?.localPaths ?? []).toEqual([]);

      armed.disarm();
      await projectRegistryWriteTool.execute(
        { operation: "cloneRepo", id, confirm: true } as never,
        ctxFor(session) as never,
      );
      expect(existsSync(join(cloneDir, "readme.md"))).toBe(true);
      expect(getProject(id)?.localPaths).toEqual([
        { path: cloneDir, kind: "repo", match: "prefix" },
      ]);
    });
});
