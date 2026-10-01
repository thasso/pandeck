import { afterEach, describe, expect, test, vi } from "vitest";
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
