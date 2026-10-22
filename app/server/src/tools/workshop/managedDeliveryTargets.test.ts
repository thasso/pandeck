import { afterEach, expect, test, vi } from "vitest";
import { resolveManagedHosting } from "./managedDeliveryTargets.ts";
import type { ResolvedPushTarget } from "../../pushWorkflow.ts";

const remote = vi.hoisted(() => ({ url: "" }));
vi.mock("../../gitExec.ts", async (original) => ({
  ...(await original<typeof import("../../gitExec.ts")>()),
  gitOptional: async () => ({ code: 0, stdout: remote.url, stderr: "" }),
}));
vi.mock("../../githubSettings.ts", () => ({
  getGithubConfigIfAvailable: () => ({
    token: "test",
    apiBaseUrl: "https://api.github.com",
  }),
}));
vi.mock("../../forgejoSettings.ts", () => ({
  getForgejoConfigIfAvailable: () => ({
    token: "test",
    baseUrl: "https://forgejo.example",
  }),
}));
afterEach(() => vi.unstubAllGlobals());

test.each(["github.com", "forgejo.example"])(
  "foreground %s write converges after the turn aborts",
  async (host) => {
    remote.url = `https://${host}/acme/repo.git`;
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: (response: Response) => void;
    let signal!: AbortSignal;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        expect(init.method).toBe(host === "github.com" ? "PUT" : "POST");
        signal = init.signal;
        entered();
        return new Promise<Response>((resolve, reject) => {
          finish = resolve;
          signal.addEventListener(
            "abort",
            () => reject(new Error("write aborted")),
            { once: true },
          );
        });
      }),
    );
    const controller = new AbortController();
    const hosted = await resolveManagedHosting(
      { repoRoot: "/repo", remote: "origin" } as ResolvedPushTarget,
      controller.signal,
    );
    const result = hosted!.provider
      .mergePullRequest(42, {
        method: "squash",
        deleteBranch: false,
        expectedHeadSha: "head",
      })
      .catch((error: unknown) => error);
    await writing;
    controller.abort(new Error("turn stopped"));
    // GitHub answers through merge-async, Forgejo through its plain merge.
    finish(
      new Response(
        JSON.stringify(
          host === "github.com" ? { status: "merged" } : { merged: true },
        ),
        { status: 200 },
      ),
    );
    expect(await result).toMatchObject({
      outcome: "merged",
      number: 42,
      branchDeleted: false,
    });
    expect(signal.aborted).toBe(false);
  },
);

test.each(["github.com", "forgejo.example"])(
  "managed %s provider reads abort with the job",
  async (host) => {
    remote.url = `https://${host}/acme/repo.git`;
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let signal!: AbortSignal;
    let rejectRead!: (error: Error) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        signal = init.signal;
        entered();
        return new Promise<Response>((_resolve, reject) => {
          rejectRead = reject;
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error("read aborted"),
              ),
            { once: true },
          );
        });
      }),
    );
    const controller = new AbortController();
    const hosted = await resolveManagedHosting(
      { repoRoot: "/repo", remote: "origin" } as ResolvedPushTarget,
      controller.signal,
      controller.signal,
    );
    const request = hosted!.provider
      .pullRequestDetail(42)
      .catch((error: unknown) => error);
    await reading;
    controller.abort(new Error("job stopped"));
    const aborted = signal.aborted;
    rejectRead(new Error("job stopped"));
    expect(await request).toMatchObject({ message: "job stopped" });
    expect(aborted).toBe(true);
  },
);
