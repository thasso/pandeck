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
const { hub } = await import("./hub.ts");
const { piStore } = await import("./piSdk/piStore.ts");
const { canonicalPiSessionPath } = await import("./sessionStorage.ts");
const { addWorktreeComment } = await import("./worktrees/worktreeComments.ts");
const { mainWorktreeId } = await import("./worktrees/worktreeResolve.ts");

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", ...args],
    { cwd, stdio: "ignore" },
  );
}

interface FakeSessionManager {
  getSessionId(): string;
  getSessionFile(): string | undefined;
}

interface PiStoreInternals {
  create: (
    ...args: unknown[]
  ) => Promise<{ session: unknown; notices: unknown[] }>;
  track: (
    _kind: string,
    session: { sessionId: string; sessionFile?: string },
    _notices: unknown[],
    _cwd: string,
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

  const originalAcquireNew = hub.acquireNew;
  const originalBroadcastSessions = hub.broadcastSessions;
  (
    hub as unknown as {
      acquireNew: (...args: unknown[]) => Promise<{ sessionId: string }>;
    }
  ).acquireNew = async () => ({ sessionId });
  (
    hub as unknown as { broadcastSessions: () => Promise<void> }
  ).broadcastSessions = async () => {};
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
    const originalCreate = internals.create;
    const originalTrack = internals.track;
    let reopenedProfileId: string | undefined;
    internals.create = async (...args: unknown[]) => {
      const manager = args[1] as FakeSessionManager;
      reopenedProfileId = args[5] as string;
      return {
        session: {
          sessionId: manager.getSessionId(),
          sessionFile: manager.getSessionFile(),
          sessionManager: manager,
        },
        notices: [],
      };
    };
    internals.track = (_kind, session) => ({
      sessionId: session.sessionId,
      ...(session.sessionFile !== undefined
        ? { sessionFile: session.sessionFile }
        : {}),
    });
    try {
      await piStore.acquireExisting("assistant", file, sessionId);
      assert.equal(reopenedProfileId, profile.id);
    } finally {
      internals.create = originalCreate;
      internals.track = originalTrack;
    }
  } finally {
    (hub as unknown as { acquireNew: typeof originalAcquireNew }).acquireNew =
      originalAcquireNew;
    (
      hub as unknown as { broadcastSessions: typeof originalBroadcastSessions }
    ).broadcastSessions = originalBroadcastSessions;
  }
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
