import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { sessionStore } from "../../db/sessionStore.ts";
import { backgroundWorkStore } from "../../db/backgroundWorkStore.ts";
import { backgroundWorkSupervisor } from "../../backgroundWork/supervisor.ts";
import { sessionArtifactFile } from "../../mcp/toolGroups/packRuntime.ts";
import { getSettings, updateSettings } from "../../settings.ts";
import type { ToolCallContext, ToolResult } from "../../mcp/tool.ts";
import {
  setContainerExecForTests,
  type ContainerExecRequest,
  type ContainerExecResult,
} from "../../containerImages.ts";

// Override only the credential accessor; the pull service stays real (behind its exec seam).
vi.mock("../../githubSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../githubSettings.ts")>()),
  getGithubRegistryCredential: vi.fn(),
}));

const { getGithubRegistryCredential } = await import("../../githubSettings.ts");
const { containerImagePullTool } = await import("./containerImageTools.ts");

const TOKEN = "ghp_pretendtokenvalue0123456789";
const GHCR_IMAGE = "ghcr.io/acme/acme-sphinx-build:7.24.2";
const INSPECT_OUT = `sha256:image-id\t42\t["ghcr.io/acme/acme-sphinx-build@sha256:${"c".repeat(64)}"]\n`;

const ctx: ToolCallContext = {
  toolCallId: "call",
  session: {
    sessionId: "session-1",
    harness: "claude-sdk",
    agentType: "developer",
  },
};

function installExec(
  overrides: Partial<Record<string, () => ContainerExecResult>> = {},
): ContainerExecRequest[] {
  const calls: ContainerExecRequest[] = [];
  let inspected = 0;
  setContainerExecForTests(async (req) => {
    calls.push({ ...req, ...(req.env ? { env: { ...req.env } } : {}) });
    const key = req.args[0] === "image" ? "image inspect" : (req.args[0] ?? "");
    const override = overrides[key];
    if (override) return override();
    switch (key) {
      case "version":
        return { code: 0, stdout: "29.6.1\n", stderr: "" };
      case "image inspect":
        return inspected++ === 0
          ? { code: 1, stdout: "", stderr: "No such image" }
          : { code: 0, stdout: INSPECT_OUT, stderr: "" };
      default:
        return { code: 0, stdout: "", stderr: "" };
    }
  });
  return calls;
}

function payload(result: ToolResult): Record<string, unknown> {
  const first = result.content[0];
  return JSON.parse(
    first && first.type === "text" ? first.text : "{}",
  ) as Record<string, unknown>;
}

afterEach(() => {
  setContainerExecForTests(null);
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("container_image_pull", () => {
  test("pulls a private GHCR image and returns only safe metadata", async () => {
    vi.mocked(getGithubRegistryCredential).mockResolvedValue({
      username: "octo",
      token: TOKEN,
    });
    const calls = installExec();

    const result = await containerImagePullTool.execute(
      { image: GHCR_IMAGE },
      ctx,
    );
    const body = payload(result);

    expect(body).toMatchObject({
      image: GHCR_IMAGE,
      registry: "ghcr.io",
      status: "pulled",
      authenticated: true,
      imageId: "sha256:image-id",
    });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(calls.some((call) => call.args[0] === "login")).toBe(true);
  });

  test("pulls a public image without asking for credentials", async () => {
    const calls = installExec();

    const body = payload(
      await containerImagePullTool.execute({ image: "node:24" }, ctx),
    );

    expect(body).toMatchObject({
      image: "docker.io/library/node:24",
      authenticated: false,
      status: "pulled",
    });
    expect(getGithubRegistryCredential).not.toHaveBeenCalled();
    expect(calls.some((call) => call.args[0] === "login")).toBe(false);
  });

  test("points at Settings → GitHub when GHCR has no credential", async () => {
    vi.mocked(getGithubRegistryCredential).mockResolvedValue(null);
    installExec();

    await expect(
      containerImagePullTool.execute({ image: GHCR_IMAGE }, ctx),
    ).rejects.toThrow(/Settings → GitHub/);
  });

  test("reports a missing container runtime instead of attempting a pull", async () => {
    const calls = installExec({
      version: () => ({
        code: 1,
        stdout: "",
        stderr: "docker: command not found",
      }),
    });

    await expect(
      containerImagePullTool.execute({ image: GHCR_IMAGE }, ctx),
    ).rejects.toThrow(/No container runtime is available/);
    expect(calls.some((call) => call.args[0] === "pull")).toBe(false);
  });

  test("rejects a reference that is not a plain image reference", async () => {
    installExec();

    await expect(
      containerImagePullTool.execute({ image: "--config=/tmp/evil" }, ctx),
    ).rejects.toThrow();
  });
});

describe("container_image_pull in the background", () => {
  let serial = 0;
  function owner(): ToolCallContext {
    const sessionId = `image-background-${++serial}`;
    sessionStore.upsert({
      id: sessionId,
      scope: "user",
      harness: "pi",
      agentType: "developer",
    });
    return {
      toolCallId: `call-${serial}`,
      session: { sessionId, harness: "pi", agentType: "developer" },
    };
  }
  function gated() {
    let request: ContainerExecRequest | undefined;
    let finish!: (result: ContainerExecResult) => void;
    let present = false;
    setContainerExecForTests(async (req) => {
      if (req.args[0] === "version")
        return { code: 0, stdout: "29", stderr: "" };
      if (req.args[0] === "image")
        return {
          code: present ? 0 : 1,
          stdout: present ? INSPECT_OUT : "",
          stderr: "",
        };
      if (req.args[0] === "pull") {
        request = req;
        return new Promise<ContainerExecResult>((resolve, reject) => {
          req.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
          finish = (result) => {
            present = true;
            resolve(result);
          };
        });
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    return {
      request: () => request,
      finish: (result = { code: 0, stdout: "", stderr: "" }) => finish(result),
    };
  }
  const image = "docker.io/library/node:24";
  function artifact(taskId: string) {
    const item = backgroundWorkStore.getItem(taskId)!;
    return JSON.parse(
      readFileSync(
        sessionArtifactFile(item.ownerSessionId, item.evidence!.artifactId!)!
          .path,
        "utf8",
      ),
    );
  }
  test("returns at once and captures the same payload as a foreground pull", async () => {
    vi.useFakeTimers();
    const exec = gated();
    const ctx = owner();
    const started = payload(
      await containerImagePullTool.execute({ image, background: true }, ctx),
    );
    expect(started).toMatchObject({
      taskId: expect.any(String),
      state: "running",
    });
    expect(backgroundWorkStore.getItem(String(started.taskId))).toMatchObject({
      backend: "server-task",
      kind: "image-pull",
      label: `Image pull ${image}`,
    });
    await vi.waitFor(() => expect(exec.request()).toBeDefined());
    exec.finish();
    await vi.waitFor(() =>
      expect(backgroundWorkStore.getItem(String(started.taskId))?.state).toBe(
        "completed",
      ),
    );
    const result = artifact(String(started.taskId));
    expect(result).toMatchObject({
      image,
      status: "pulled",
      note: expect.stringContaining("now in the local store"),
    });
    expect(
      backgroundWorkStore.getItem(String(started.taskId))?.outcomeSummary,
    ).toContain(image);
    const fgExec = gated();
    const fg = containerImagePullTool.execute({ image }, owner());
    await vi.waitFor(() => expect(fgExec.request()).toBeDefined());
    fgExec.finish();
    const foreground = payload(await fg);
    expect({ ...result, durationMs: 0 }).toEqual({
      ...foreground,
      durationMs: 0,
    });
  });
  test("a present image returns inline; missing runtime and ineligible owners admit nothing", async () => {
    installExec({
      "image inspect": () => ({ code: 0, stdout: INSPECT_OUT, stderr: "" }),
    });
    const ctx = owner();
    expect(
      payload(
        await containerImagePullTool.execute({ image, background: true }, ctx),
      ).status,
    ).toBe("already-present");
    expect(
      backgroundWorkStore.listItems({ ownerSessionId: ctx.session.sessionId }),
    ).toEqual([]);
    installExec({
      version: () => ({ code: 1, stdout: "", stderr: "no docker" }),
    });
    await expect(
      containerImagePullTool.execute({ image, background: true }, ctx),
    ).rejects.toThrow("No container runtime");
    installExec();
    await expect(
      containerImagePullTool.execute(
        { image, refresh: true, background: true },
        { ...ctx, session: { ...ctx.session, sessionId: "no-such-owner" } },
      ),
    ).rejects.toThrow("Background work denied");
  });
  test.each(["background", "foreground"])(
    "stopping the %s subscriber does not kill the other session's pull",
    async (stopped) => {
      const exec = gated();
      const ctx = owner();
      const started = payload(
        await containerImagePullTool.execute({ image, background: true }, ctx),
      );
      await vi.waitFor(() => expect(exec.request()).toBeDefined());
      const turn = new AbortController();
      const progress = vi.fn();
      const fg = containerImagePullTool.execute(
        { image },
        { ...owner(), signal: turn.signal, progress },
      );
      const fgSettled = fg.catch((e: Error) => e);
      await vi.waitFor(() =>
        expect(JSON.stringify(progress.mock.calls)).toContain(
          "Waiting for an in-progress pull",
        ),
      );
      if (stopped === "background") {
        await backgroundWorkSupervisor.stopOne({
          itemId: String(started.taskId),
          ownerSessionId: ctx.session.sessionId,
          sourceRequestId: "stop-pull",
          reason: "test Stop",
        });
        expect(backgroundWorkStore.getItem(String(started.taskId))?.state).toBe(
          "stopped",
        );
      } else {
        turn.abort();
        expect(await fgSettled).toBeInstanceOf(Error);
      }
      expect(exec.request()!.signal?.aborted).toBe(false);
      exec.finish();
      if (stopped === "background")
        expect(payload(await fg).status).toBe("pulled");
      else
        await vi.waitFor(() =>
          expect(
            backgroundWorkStore.getItem(String(started.taskId))?.state,
          ).toBe("completed"),
        );
    },
  );
  test("uses the frozen own-timeout before deadline Stop and aborts the last subscription", async () => {
    vi.useFakeTimers();
    const before = getSettings().backgroundWork;
    updateSettings({ backgroundWork: { ...before, taskLifetimeMinutes: 5 } });
    try {
      const exec = gated();
      const started = payload(
        await containerImagePullTool.execute(
          { image, background: true },
          owner(),
        ),
      );
      await vi.waitFor(() => expect(exec.request()).toBeDefined());
      await vi.advanceTimersByTimeAsync(240_000);
      await vi.waitFor(() =>
        expect(backgroundWorkStore.getItem(String(started.taskId))?.state).toBe(
          "failed",
        ),
      );
      const item = backgroundWorkStore.getItem(String(started.taskId))!;
      expect(item.stopOrigin).toBeUndefined();
      expect(item.outcomeSummary).toContain("did not finish within 240 s");
      expect(exec.request()!.signal?.aborted).toBe(true);
    } finally {
      updateSettings({ backgroundWork: before });
    }
  });
  test("redacts a failed pull's background summary", async () => {
    vi.mocked(getGithubRegistryCredential).mockResolvedValue({
      username: "octo",
      token: TOKEN,
    });
    const exec = gated();
    const started = payload(
      await containerImagePullTool.execute(
        { image: GHCR_IMAGE, background: true },
        owner(),
      ),
    );
    await vi.waitFor(() => expect(exec.request()).toBeDefined());
    exec.finish({ code: 1, stdout: "", stderr: `denied: Bearer ${TOKEN}` });
    await vi.waitFor(() =>
      expect(backgroundWorkStore.getItem(String(started.taskId))?.state).toBe(
        "failed",
      ),
    );
    expect(
      backgroundWorkStore.getItem(String(started.taskId))?.outcomeSummary,
    ).not.toContain(TOKEN);
  });
});
