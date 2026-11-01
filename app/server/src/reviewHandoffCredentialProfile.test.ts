import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "review-handoff-profile-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

vi.mock("./session/runtimePrompt.ts", () => ({
  subscribeHarnessOpened: () => () => {},
  promptRuntimeSession: async () => {},
}));

const { Connection } = await import("./connection.ts");
const { createCredentialProfile } = await import("./credentialProfiles.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { projectStore } = await import("./db/projectStore.ts");
await import("./hub.ts");
const { piStore } = await import("./piSdk/piStore.ts");
const { canonicalPiSessionPath } = await import("./sessionStorage.ts");
const { addWorktreeComment } = await import("./worktrees/worktreeComments.ts");
const { mainWorktreeId } = await import("./worktrees/worktreeResolve.ts");
const worktreeStore = await import("./db/worktreeStore.ts");
const settings = await import("./settings.ts");

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", ...args],
    { cwd, stdio: "ignore" },
  );
}

const { openPiEngine } = await import("./piSdk/piEngineHost.ts");

interface PiStoreInternals {
  openEngine: (
    spec: import("./piSdk/piEngineHost.ts").PiEngineOpenSpec,
  ) => Promise<import("./piSdk/piEngineHost.ts").PiEngineOpened>;
  track: (
    _kind: string,
    opened: import("./piSdk/piEngineHost.ts").PiEngineOpened,
  ) => { sessionId: string; sessionFile?: string };
}

test("pi review handoff persists the selected profile and cold reopen recovers it", async () => {
  const repo = join(tmp, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "review.txt"), "line one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  projectStore.put({
    id: "review-profile-project",
    name: "Review Profile",
    key: "RVP",
    description: "",
    status: "active",
    localPaths: [{ path: repo, kind: "repo", match: "prefix" }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const worktreeId = mainWorktreeId("review-profile-project");
  const comment = await addWorktreeComment({
    worktreeId,
    body: "Please review this.",
    author: { kind: "user" },
    anchor: { path: "review.txt", side: "new", line: 1 },
  });
  const profile = createCredentialProfile({
    name: "Review account",
    provider: "openai-codex",
  });
  const sessionId = "review-profile-session";

  const originalAcquireNew = piStore.acquireNew;
  (
    piStore as unknown as {
      acquireNew: (...args: unknown[]) => Promise<{ sessionId: string }>;
    }
  ).acquireNew = async () => ({ sessionId });
  const sent: unknown[] = [];
  const fakeWs = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => sent.push(JSON.parse(payload)),
  };
  const connection = new (
    Connection as unknown as new (ws: unknown) => Record<string, unknown>
  )(fakeWs) as unknown as {
    onAttachWorktreeComments: (
      worktreeId: string,
      commentIds: string[],
      target: Record<string, unknown>,
    ) => Promise<void>;
    view: () => void;
  };
  connection.view = () => {};

  try {
    await connection.onAttachWorktreeComments(worktreeId, [comment.id], {
      kind: "new",
      harness: "pi",
      agentType: "assistant",
      credentialProfileId: profile.id,
      additionalPrompt: "Address the review.",
    });
    assert.equal(sent.length, 0);
    assert.equal(sessionStore.get(sessionId)?.credentialProfileId, profile.id);

    const file = canonicalPiSessionPath(sessionId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: new Date().toISOString(),
          cwd: repo,
        }),
        JSON.stringify({
          type: "message",
          id: "review-entry",
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: "user",
            content: "Address the review.",
            timestamp: Date.now(),
          },
        }),
        "",
      ].join("\n"),
    );

    const internals = piStore as unknown as PiStoreInternals;
    const originalOpenEngine = internals.openEngine;
    const originalTrack = internals.track;
    let reopenedProfileId: string | undefined;
    internals.openEngine = (spec) => {
      reopenedProfileId = spec.credentialProfileId;
      return openPiEngine(spec, {} as never, async (_spec, _ctx, { sm }) => ({
        session: {
          sessionId: sm.getSessionId(),
          sessionFile: sm.getSessionFile(),
          sessionManager: sm,
          subscribe: () => () => {},
        } as never,
        notices: [],
      }));
    };
    internals.track = (_kind, { engine }) => ({
      sessionId: engine.sessionId,
      ...(engine.sessionFile !== undefined
        ? { sessionFile: engine.sessionFile }
        : {}),
    });
    try {
      await piStore.acquireExisting("assistant", file, sessionId);
      assert.equal(reopenedProfileId, profile.id);
    } finally {
      internals.openEngine = originalOpenEngine;
      internals.track = originalTrack;
    }
  } finally {
    (
      piStore as unknown as {
        acquireNew: typeof originalAcquireNew;
      }
    ).acquireNew = originalAcquireNew;
  }
});

test("a Claude review handoff on a non-Claude account is refused before anything is linked", async () => {
  const repo = join(tmp, "claude-repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "review.txt"), "line one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  projectStore.put({
    id: "review-claude-project",
    name: "Review Claude",
    key: "RVC",
    description: "",
    status: "active",
    localPaths: [{ path: repo, kind: "repo", match: "prefix" }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const worktreeId = mainWorktreeId("review-claude-project");
  const comment = await addWorktreeComment({
    worktreeId,
    body: "Please review this.",
    author: { kind: "user" },
    anchor: { path: "review.txt", side: "new", line: 1 },
  });
  const openAi = createCredentialProfile({
    name: "Not Claude",
    provider: "openai-codex",
  });
  const real = settings.getSettings();
  vi.spyOn(settings, "getSettings").mockReturnValue({
    ...real,
    claudeSdk: { ...real.claudeSdk, enabled: true },
  });
  const link = vi.spyOn(worktreeStore, "linkSessionToWorktree");
  const sent: Array<{ type: string; message?: string }> = [];
  const connection = new (
    Connection as unknown as new (ws: unknown) => Record<string, unknown>
  )({
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => sent.push(JSON.parse(payload)),
  }) as unknown as {
    onAttachWorktreeComments: (
      worktreeId: string,
      commentIds: string[],
      target: Record<string, unknown>,
    ) => Promise<void>;
  };

  try {
    await connection.onAttachWorktreeComments(worktreeId, [comment.id], {
      kind: "new",
      harness: "claude-sdk",
      agentType: "assistant",
      credentialProfileId: openAi.id,
    });
    assert.ok(
      sent.some(
        (message) =>
          message.type === "error" &&
          /enabled Claude credential profile/.test(message.message ?? ""),
      ),
    );
    assert.equal(link.mock.calls.length, 0);
  } finally {
    vi.restoreAllMocks();
  }
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
