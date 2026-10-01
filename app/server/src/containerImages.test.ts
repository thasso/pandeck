import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  ContainerPullError,
  execContainerCommand,
  parseImageRef,
  pullContainerImage,
  redactRegistrySecrets,
  setContainerExecForTests,
  type ContainerExec,
  type ContainerExecRequest,
  type ContainerExecResult,
  type RegistryCredential,
} from "./containerImages.ts";
import { setChildProcessEnvOverlay } from "./subprocessEnv.ts";

const TOKEN = "ghp_pretendtokenvalue0123456789";
const CREDENTIAL: RegistryCredential = { username: "octo", token: TOKEN };
const GHCR_IMAGE = "ghcr.io/acme/acme-sphinx-build:7.24.2";

interface RecordedCall {
  args: string[];
  env?: Record<string, string>;
  stdin?: string;
  /** Whether the temporary DOCKER_CONFIG directory existed when docker ran. */
  configDirPresent: boolean;
}

interface Harness {
  calls: RecordedCall[];
  /** DOCKER_CONFIG directories seen across all invocations. */
  configDirs: Set<string>;
  names(): string[];
}

type Handler = (
  req: ContainerExecRequest,
  call: number,
) => ContainerExecResult | Promise<ContainerExecResult>;

const OK: ContainerExecResult = { code: 0, stdout: "", stderr: "" };
const INSPECT_OUT = `sha256:image-id\t123456\t["ghcr.io/acme/acme-sphinx-build@sha256:${"a".repeat(64)}"]\n`;

/** Install a fake docker with sensible defaults; `overrides` refine one command. */
function installExec(
  overrides: Partial<Record<string, Handler>> = {},
  fallback?: Handler,
): Harness {
  const harness: Harness = {
    calls: [],
    configDirs: new Set<string>(),
    names: () => harness.calls.map((call) => call.args.slice(0, 2).join(" ")),
  };
  let index = 0;
  const exec: ContainerExec = async (req) => {
    const configDir = req.env?.DOCKER_CONFIG;
    if (configDir) harness.configDirs.add(configDir);
    harness.calls.push({
      args: [...req.args],
      ...(req.env ? { env: { ...req.env } } : {}),
      ...(req.stdin === undefined ? {} : { stdin: req.stdin }),
      configDirPresent: Boolean(configDir && existsSync(configDir)),
    });
    const key = req.args[0] === "image" ? "image inspect" : (req.args[0] ?? "");
    const handler = overrides[key] ?? fallback;
    if (handler) return handler(req, index++);
    switch (key) {
      case "version":
        return { code: 0, stdout: "29.6.1\n", stderr: "" };
      case "image inspect":
        return { code: 0, stdout: INSPECT_OUT, stderr: "" };
      case "login":
        return OK;
      case "pull":
        return {
          code: 0,
          stdout: "Status: Downloaded newer image\n",
          stderr: "",
        };
      default:
        return {
          code: 1,
          stdout: "",
          stderr: `unexpected docker ${req.args.join(" ")}`,
        };
    }
  };
  setContainerExecForTests(exec);
  return harness;
}

/** `docker image inspect` misses once (image absent), then succeeds. */
function inspectMissesFirst(): Handler {
  let seen = 0;
  return () =>
    seen++ === 0
      ? { code: 1, stdout: "", stderr: "No such image" }
      : { code: 0, stdout: INSPECT_OUT, stderr: "" };
}

const credentialProvider = async () => CREDENTIAL;

afterEach(() => {
  setContainerExecForTests(null);
});

describe("docker executor", () => {
  test("starts docker with the child overlay the server does not hold", async () => {
    const bin = mkdtempSync(join(tmpdir(), "container-images-docker-"));
    writeFileSync(
      join(bin, "docker"),
      '#!/bin/sh\nprintf %s "$PA_DOCKER_OVERLAY_PROBE"\n',
      { mode: 0o755 },
    );
    const path = process.env.PATH;
    process.env.PATH = [bin, path].filter(Boolean).join(delimiter);
    setChildProcessEnvOverlay({ PA_DOCKER_OVERLAY_PROBE: "docker-overlay" });
    try {
      const result = await execContainerCommand({ args: ["version"] });
      expect(result.stdout).toBe("docker-overlay");
      expect(process.env.PA_DOCKER_OVERLAY_PROBE).toBeUndefined();
    } finally {
      setChildProcessEnvOverlay(null);
      process.env.PATH = path;
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe("docker exiting before it reads stdin", () => {
  test("settles with its exit code instead of an unhandled EPIPE", async () => {
    const bin = mkdtempSync(join(tmpdir(), "container-images-epipe-"));
    writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = [bin, path].filter(Boolean).join(delimiter);
    try {
      // Far past the pipe buffer, so the write fails once docker is gone.
      const result = await execContainerCommand({
        args: ["login"],
        stdin: "x".repeat(4 * 1024 * 1024),
      });
      expect(result.code).toBe(3);
    } finally {
      process.env.PATH = path;
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe("parseImageRef", () => {
  test("normalizes docker-hub short forms and keeps explicit registries", () => {
    expect(parseImageRef("node:24").normalized).toBe(
      "docker.io/library/node:24",
    );
    expect(parseImageRef("acme/tools").normalized).toBe(
      "docker.io/acme/tools:latest",
    );
    const ref = parseImageRef(GHCR_IMAGE);
    expect(ref).toMatchObject({
      registry: "ghcr.io",
      repository: "acme/acme-sphinx-build",
      tag: "7.24.2",
    });
    expect(ref.normalized).toBe(GHCR_IMAGE);
  });

  test("keeps digests and registry ports", () => {
    const digest = `sha256:${"b".repeat(64)}`;
    expect(parseImageRef(`ghcr.io/owner/name@${digest}`).normalized).toBe(
      `ghcr.io/owner/name@${digest}`,
    );
    expect(parseImageRef("localhost:5000/name:dev").registry).toBe(
      "localhost:5000",
    );
  });

  test("rejects references that could reach the CLI as something other than a reference", () => {
    for (const bad of [
      "",
      "   ",
      "-rm",
      "--config=/tmp/x",
      "ghcr.io/owner/name; rm -rf /",
      "ghcr.io/Owner/Name:1",
      "name@sha256:nothex",
      "name:in valid",
    ]) {
      expect(() => parseImageRef(bad), bad).toThrow();
    }
  });
});

describe("redactRegistrySecrets", () => {
  test("removes the token, its base64 form, and auth headers", () => {
    const basic = Buffer.from(`octo:${TOKEN}`, "utf8").toString("base64");
    const text = `login failed for ${TOKEN}\nAuthorization: Basic ${basic}\nheader: Bearer ${TOKEN}`;
    const out = redactRegistrySecrets(text, [TOKEN, `octo:${TOKEN}`]);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(basic);
    expect(out).toContain("«redacted»");
  });

  test("redacts token-shaped strings even when they are not the known secret", () => {
    expect(
      redactRegistrySecrets("saw github_pat_11ABCDEFG0123456789abcdef"),
    ).not.toContain("github_pat_11ABCDEFG0123456789abcdef");
  });
});

describe("pullContainerImage", () => {
  test("authenticates to GHCR with the token on stdin only, then pulls", async () => {
    const harness = installExec({ "image inspect": inspectMissesFirst() });

    const result = await pullContainerImage({
      image: GHCR_IMAGE,
      credential: credentialProvider,
    });

    expect(result).toMatchObject({
      image: GHCR_IMAGE,
      registry: "ghcr.io",
      status: "pulled",
      authenticated: true,
      imageId: "sha256:image-id",
      sizeBytes: 123456,
    });
    expect(result.digest).toBe(`sha256:${"a".repeat(64)}`);

    const login = harness.calls.find((call) => call.args[0] === "login");
    expect(login).toBeDefined();
    expect(login!.args).toEqual([
      "login",
      "ghcr.io",
      "--username",
      "octo",
      "--password-stdin",
    ]);
    expect(login!.stdin).toBe(TOKEN);
    // The token is never an argument or an environment variable.
    expect(
      harness.calls.some((call) =>
        call.args.some((arg) => arg.includes(TOKEN)),
      ),
    ).toBe(false);
    expect(
      harness.calls.some((call) =>
        Object.values(call.env ?? {}).some((value) => value.includes(TOKEN)),
      ),
    ).toBe(false);

    const pull = harness.calls.find((call) => call.args[0] === "pull");
    expect(pull!.args).toEqual(["pull", "--", GHCR_IMAGE]);
    // Login and pull share one private docker config that existed while docker ran.
    expect(login!.env?.DOCKER_CONFIG).toBe(pull!.env?.DOCKER_CONFIG);
    expect(login!.configDirPresent && pull!.configDirPresent).toBe(true);
  });

  test("never sends credentials to a registry other than ghcr.io", async () => {
    let providerCalls = 0;
    const harness = installExec({ "image inspect": inspectMissesFirst() });

    const result = await pullContainerImage({
      image: "node:24",
      credential: async () => {
        providerCalls += 1;
        return CREDENTIAL;
      },
    });

    expect(result).toMatchObject({
      image: "docker.io/library/node:24",
      authenticated: false,
      status: "pulled",
    });
    expect(providerCalls).toBe(0);
    expect(harness.names()).not.toContain("login docker.io");
    expect(harness.calls.some((call) => call.args[0] === "login")).toBe(false);
  });

  test("short-circuits when the image is already present", async () => {
    const harness = installExec();

    const result = await pullContainerImage({
      image: GHCR_IMAGE,
      credential: credentialProvider,
    });

    expect(result).toMatchObject({
      status: "already-present",
      authenticated: false,
    });
    expect(
      harness.calls.some(
        (call) => call.args[0] === "pull" || call.args[0] === "login",
      ),
    ).toBe(false);
  });

  test("refresh pulls again even when the image is present", async () => {
    const harness = installExec();

    const result = await pullContainerImage({
      image: GHCR_IMAGE,
      refresh: true,
      credential: credentialProvider,
    });

    expect(result.status).toBe("pulled");
    expect(
      harness.calls.filter((call) => call.args[0] === "pull"),
    ).toHaveLength(1);
  });

  test("requires the GitHub integration for ghcr.io", async () => {
    const harness = installExec({ "image inspect": inspectMissesFirst() });

    await expect(
      pullContainerImage({ image: GHCR_IMAGE, credential: async () => null }),
    ).rejects.toThrow(/Settings → GitHub/);
    expect(
      harness.calls.some(
        (call) => call.args[0] === "login" || call.args[0] === "pull",
      ),
    ).toBe(false);
  });

  test("fails with a redacted, actionable message when the pull is denied", async () => {
    installExec({
      "image inspect": inspectMissesFirst(),
      pull: () => ({
        code: 1,
        stdout: "",
        stderr: `Error response from daemon: denied (token ${TOKEN})`,
      }),
    });

    const error = await pullContainerImage({
      image: GHCR_IMAGE,
      credential: credentialProvider,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ContainerPullError);
    const message = (error as Error).message;
    expect(message).not.toContain(TOKEN);
    expect(message).toContain("«redacted»");
    expect(message).toContain("read:packages");
  });

  test("removes the temporary docker config on success and on every failure path", async () => {
    const scenarios: Array<[string, Partial<Record<string, Handler>>]> = [
      ["success", {}],
      [
        "login failure",
        { login: () => ({ code: 1, stdout: "", stderr: "unauthorized" }) },
      ],
      [
        "pull failure",
        { pull: () => ({ code: 1, stdout: "", stderr: "manifest unknown" }) },
      ],
      [
        "docker crash",
        {
          pull: () => {
            throw new Error("spawn docker ENOENT");
          },
        },
      ],
    ];
    for (const [label, overrides] of scenarios) {
      const harness = installExec({
        "image inspect": inspectMissesFirst(),
        ...overrides,
      });
      await pullContainerImage({
        image: GHCR_IMAGE,
        credential: credentialProvider,
      }).catch(() => undefined);
      expect(harness.configDirs.size, label).toBeGreaterThan(0);
      for (const dir of harness.configDirs)
        expect(existsSync(dir), `${label}: ${dir} must be removed`).toBe(false);
    }
  });

  test("reports an aborted pull as cancelled and still cleans up", async () => {
    const controller = new AbortController();
    const harness = installExec({
      "image inspect": inspectMissesFirst(),
      pull: () => {
        controller.abort();
        throw Object.assign(new Error("The operation was aborted"), {
          name: "AbortError",
        });
      },
    });

    await expect(
      pullContainerImage({
        image: GHCR_IMAGE,
        credential: credentialProvider,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);
    for (const dir of harness.configDirs) expect(existsSync(dir)).toBe(false);
  });

  test("concurrent requests for the same image share one pull", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = installExec({
      "image inspect": inspectMissesFirst(),
      pull: async () => {
        await gate;
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    const first = pullContainerImage({
      image: GHCR_IMAGE,
      credential: credentialProvider,
    });
    const second = pullContainerImage({
      image: GHCR_IMAGE,
      credential: credentialProvider,
    });
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toEqual(b);
    expect(
      harness.calls.filter((call) => call.args[0] === "pull"),
    ).toHaveLength(1);
    expect(
      harness.calls.filter((call) => call.args[0] === "login"),
    ).toHaveLength(1);
  });

  test("fails clearly when no container runtime is available", async () => {
    installExec({
      version: () => ({
        code: 1,
        stdout: "",
        stderr: "Cannot connect to the Docker daemon",
      }),
    });

    await expect(
      pullContainerImage({ image: GHCR_IMAGE, credential: credentialProvider }),
    ).rejects.toThrow(/No usable container runtime/);
  });
});
