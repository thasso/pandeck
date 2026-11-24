/**
 * `prepareFork`: each engine's cut and refusals, and the parent's worktree
 * edge carried to the child.
 *   pnpm --filter @assistant/server test src/harnesses/fork.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "harness-fork-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { prepareFork } = await import("./fork.ts");
const { claudeSdkStore } = await import("../claudeSdk/claudeSdkStore.ts");
const { piStore } = await import("../piSdk/piStore.ts");
const worktreeStore = await import("../db/worktreeStore.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { getDb } = await import("../db/index.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const request = {
  id: "parent",
  kind: "developer",
  file: "/sessions/parent.jsonl",
  entryId: "entry-2",
} as const;

test("a Claude fork the transcript cannot cut is refused before anything is written", () => {
  const fork = vi.spyOn(claudeSdkStore, "forkSession");
  assert.deepEqual(
    prepareFork("claude-sdk", {
      ...request,
      position: "before",
      anchors: { entryFound: true, own: "native-2" },
    }),
    {
      refusal:
        "Failed to fork session: there is nothing before this prompt to branch from.",
    },
  );
  assert.deepEqual(
    prepareFork("claude-sdk", {
      ...request,
      position: "at",
      anchors: { entryFound: true },
    }),
    {
      refusal:
        "Failed to fork session: this message has no provider anchor to branch from.",
    },
  );
  assert.equal(fork.mock.calls.length, 0);
});

test("a pi fork without the entry's own anchor is refused before pi branches", () => {
  const fork = vi.spyOn(piStore, "forkSession");
  assert.deepEqual(
    prepareFork("pi", {
      ...request,
      position: "at",
      anchors: { entryFound: true },
    }),
    {
      refusal:
        "Failed to fork session: this message has no provider anchor to branch from.",
    },
  );
  assert.equal(fork.mock.calls.length, 0);
});

test("a Claude fork cuts at the chosen turn and carries the parent's worktree", async () => {
  vi.spyOn(worktreeStore, "worktreeIdForSession").mockImplementation((id) =>
    id === "parent" ? "wt-parent" : undefined,
  );
  const links: string[] = [];
  vi.spyOn(worktreeStore, "linkSessionToWorktree").mockImplementation(
    (sessionId, worktreeId) => void links.push(`${sessionId}->${worktreeId}`),
  );
  const fork = vi
    .spyOn(claudeSdkStore, "forkSession")
    .mockImplementation(async (parentId) => {
      const parent = sessionStore.get(parentId);
      sessionStore.claimScope({
        id: "child",
        harness: "claude-sdk",
        agentType: "developer",
        ...(parent?.requiresEnterprise ? { requiresEnterprise: true } : {}),
      });
      return { sessionId: "child" } as never;
    });

  sessionStore.upsert({
    id: "parent",
    harness: "claude-sdk",
    agentType: "developer",
    requiresEnterprise: true,
  });
  const prepared = prepareFork("claude-sdk", {
    ...request,
    position: "at",
    anchors: { entryFound: true, own: "native-2" },
  });
  assert.ok("fork" in prepared);
  const child = await prepared.fork();

  assert.equal(child.sessionId, "child");
  assert.equal(sessionStore.get("child")?.requiresEnterprise, true);
  assert.equal(fork.mock.calls[0]?.[0], "parent");
  assert.deepEqual(
    { ...fork.mock.calls[0]?.[1], forkOrigin: undefined },
    {
      anchor: "native-2",
      keepThroughEntryId: "entry-2",
      forkOrigin: undefined,
    },
  );
  assert.equal(fork.mock.calls[0]?.[1].forkOrigin.parentEntryId, "entry-2");
  assert.deepEqual(links, ["child->wt-parent"]);
});

test("a pi engine claims inherited enterprise metadata before returning its fork", async () => {
  const parentId = "pi-enterprise-parent";
  const childId = "pi-enterprise-child";
  sessionStore.upsert({
    id: parentId,
    harness: "pi",
    agentType: "developer",
    requiresEnterprise: true,
  });
  vi.spyOn(piStore, "forkSession").mockImplementation(async () => {
    const parent = sessionStore.get(parentId);
    sessionStore.claimScope({
      id: childId,
      harness: "pi",
      agentType: "developer",
      ...(parent?.requiresEnterprise ? { requiresEnterprise: true } : {}),
    });
    return { sessionId: childId } as never;
  });
  const prepared = prepareFork("pi", {
    ...request,
    id: parentId,
    file: "/sessions/pi-enterprise-parent.jsonl",
    position: "before",
    anchors: { entryFound: true, own: "native-2" },
  });
  assert.ok("fork" in prepared);
  await prepared.fork();
  assert.equal(sessionStore.get(childId)?.requiresEnterprise, true);
});

test("a fork inherits the parent's stored compaction window", async () => {
  sessionStore.upsert({
    id: "window-parent",
    harness: "claude-sdk",
    agentType: "developer",
  });
  sessionStore.setCompactionWindow("window-parent", 180_000);
  const applied: Array<number | null> = [];
  vi.spyOn(claudeSdkStore, "forkSession").mockImplementation(async () => {
    sessionStore.upsert({
      id: "window-child",
      harness: "claude-sdk",
      agentType: "developer",
    });
    return {
      sessionId: "window-child",
      applyCompactionWindow: async (tokens: number | null) => {
        applied.push(tokens);
        return {};
      },
      broadcastState: () => {},
    } as never;
  });
  const prepared = prepareFork("claude-sdk", {
    ...request,
    id: "window-parent",
    position: "at",
    anchors: { entryFound: true, own: "native-2" },
  });
  assert.ok("fork" in prepared);
  await prepared.fork();
  assert.equal(sessionStore.get("window-child")?.compactionWindow, 180_000);
  assert.deepEqual(applied, [180_000]);
});

test("a fork copies none of the parent's held inputs, and the parent keeps them", async () => {
  const queue = await import("../promptQueue.ts");
  const { promptQueueStore } = await import("../db/promptQueueStore.ts");
  vi.spyOn(claudeSdkStore, "forkSession").mockImplementation(async () => {
    sessionStore.claimScope({
      id: "held-child",
      harness: "claude-sdk",
      agentType: "developer",
    });
    return { sessionId: "held-child" } as never;
  });
  sessionStore.upsert({
    id: "held-parent",
    harness: "claude-sdk",
    agentType: "developer",
  });
  queue.holdInput("held-parent", "/review-pr 7");
  const prepared = prepareFork("claude-sdk", {
    ...request,
    id: "held-parent",
    position: "at",
    anchors: { entryFound: true, own: "native-2" },
  });
  assert.ok("fork" in prepared);
  const child = await prepared.fork();
  assert.deepEqual(queue.promptQueueField(child.sessionId), {});
  assert.deepEqual(
    promptQueueStore.listHeld("held-parent").map((input) => input.text),
    ["/review-pr 7"],
  );
});

test("a session that switched engines refuses every fork before an engine is asked", () => {
  const id = "parent-switched";
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "developer",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      credentialProfileId: "cp_pi",
    }),
  );
  // Seed a second binding: no production writer starts one yet.
  getDb()
    .prepare(
      "UPDATE session_engine_binding SET ended_at_ms = 1 WHERE session_id = ? AND ended_at_ms IS NULL",
    )
    .run(id);
  getDb()
    .prepare(
      `INSERT INTO session_engine_binding (
         session_id, seq, harness, credential_profile_id, provider, model,
         thinking_level, native_session_id, started_seq, started_run_id,
         created_at_ms, ended_at_ms
       ) VALUES (?, 2, 'claude-sdk', 'cp_claude', 'claude', 'claude-opus-5-5', NULL, NULL, 10, NULL, 2, NULL)`,
    )
    .run(id);
  const claudeFork = vi.spyOn(claudeSdkStore, "forkSession");
  const piFork = vi.spyOn(piStore, "forkSession");
  for (const harness of ["claude-sdk", "pi"] as const)
    assert.deepEqual(
      prepareFork(harness, {
        ...request,
        id,
        position: "at",
        anchors: { entryFound: true, own: "native-2" },
      }),
      {
        refusal:
          "Forking a session that switched engines is not available yet.",
      },
    );
  assert.equal(claudeFork.mock.calls.length, 0);
  assert.equal(piFork.mock.calls.length, 0);
});
