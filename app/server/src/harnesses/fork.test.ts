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
const { sessionRuntime } = await import("../session/runtimeInstance.ts");
const { piNativeFile } = await import("../sessionStorage.ts");

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

/**
 * Give `id` the bindings listed, in seq order, the last one active. Each is
 * `[harness, account, native id, startedSeq, resumedSeq?]`.
 */
function seedBindings(
  id: string,
  bindings: Array<
    [
      "pi" | "claude-sdk",
      string,
      string | null,
      number,
      number | null,
      string | null,
    ]
  >,
): void {
  const [first] = bindings;
  assert.ok(
    sessionStore.upsert({
      id,
      harness: first![0],
      agentType: "developer",
      credentialProfileId: first![1],
    }),
  );
  getDb()
    .prepare("DELETE FROM session_engine_binding WHERE session_id = ?")
    .run(id);
  bindings.forEach(
    ([harness, account, native, startedSeq, resumed, model], i) =>
      getDb()
        .prepare(
          `INSERT INTO session_engine_binding (
           session_id, seq, harness, credential_profile_id, provider, model,
           thinking_level, native_session_id, started_seq, started_run_id,
           resumed_seq, created_at_ms, ended_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, 'high', ?, ?, NULL, ?, ?, ?)`,
        )
        .run(
          id,
          i + 1,
          harness,
          account,
          harness === "pi" ? "openai-codex" : "claude",
          model,
          native,
          startedSeq,
          resumed,
          i + 1,
          i === bindings.length - 1 ? null : i + 2,
        ),
  );
}

/** A log for `forkAnchors`: `[seq, own anchor?]` per entry, ids `e<seq>`. */
function fakeLog(entries: Array<[number, string?]>) {
  return vi
    .spyOn(sessionRuntime, "forkAnchors")
    .mockImplementation((_id, entryId, nativeHolds) => {
      const index = entries.findIndex(([seq]) => `e${seq}` === entryId);
      if (index < 0) return { entryFound: false };
      const [seq, own] = entries[index]!;
      for (let i = index - 1; i >= 0; i--) {
        const [previousSeq, previous] = entries[i]!;
        if (!previous || (nativeHolds && !nativeHolds(previousSeq))) continue;
        return {
          entryFound: true,
          seq,
          ...(own ? { own } : {}),
          previous,
          previousEntryId: `e${previousSeq}`,
        };
      }
      return { entryFound: true, seq, ...(own ? { own } : {}) };
    });
}

test("a fork from an entry an earlier Claude binding wrote cuts that Claude session, on its account and model", async () => {
  const id = "claude-then-pi";
  seedBindings(id, [
    ["claude-sdk", "cp_claude", "native-claude", 0, null, "opus"],
    ["pi", "cp_pi", id, 10, null, "gpt-5.6-sol"],
  ]);
  fakeLog([
    [2, "claude-u"],
    [3, "claude-a"],
    [12, "pi-a"],
  ]);
  const claudeFork = vi
    .spyOn(claudeSdkStore, "forkSession")
    .mockResolvedValue({ sessionId: "child-c" } as never);
  const piFork = vi.spyOn(piStore, "forkSession");
  // The session runs on pi now; the entry is Claude's.
  const anchors = sessionRuntime.forkAnchors(id, "e3");
  const prepared = prepareFork("pi", {
    ...request,
    id,
    entryId: "e3",
    position: "at",
    anchors,
  });
  assert.ok("fork" in prepared);
  await prepared.fork();
  assert.equal(piFork.mock.calls.length, 0);
  assert.equal(claudeFork.mock.calls[0]?.[0], id);
  assert.equal(claudeFork.mock.calls[0]?.[1].anchor, "claude-a");
  assert.deepEqual(claudeFork.mock.calls[0]?.[1].binding, {
    nativeSessionId: "native-claude",
    credentialProfileId: "cp_claude",
    modelId: "opus",
    thinkingLevel: "high",
  });
});

test("a fork from an entry an earlier pi binding wrote cuts pi's transcript on its account", async () => {
  const id = "pi-then-claude";
  seedBindings(id, [
    ["pi", "cp_pi", id, 0, null, "gpt-5.6-sol"],
    ["claude-sdk", "cp_claude", "native-claude", 10, null, "opus"],
  ]);
  fakeLog([
    [2, "pi-u"],
    [3, "pi-a"],
    [12, "claude-a"],
  ]);
  const piFork = vi
    .spyOn(piStore, "forkSession")
    .mockResolvedValue({ sessionId: "child-p" } as never);
  const claudeFork = vi.spyOn(claudeSdkStore, "forkSession");
  const prepared = prepareFork("claude-sdk", {
    ...request,
    id,
    // The active binding's file names Claude's record, never pi's transcript.
    file: "/claude/record.json",
    entryId: "e3",
    position: "before",
    anchors: sessionRuntime.forkAnchors(id, "e3"),
  });
  assert.ok("fork" in prepared);
  await prepared.fork();
  assert.equal(claudeFork.mock.calls.length, 0);
  const [kind, file, anchor, position, entryId, cut] = piFork.mock.calls[0]!;
  assert.deepEqual(
    { kind, file, anchor, position, entryId, cut },
    {
      kind: "developer",
      file: piNativeFile(id, id),
      anchor: "pi-a",
      position: "before",
      entryId: "e3",
      cut: { credentialProfileId: "cp_pi" },
    },
  );
});

test("a fork from the active binding after a switch cuts it, never at another engine's anchor", async () => {
  const id = "pi-then-claude-active";
  seedBindings(id, [
    ["pi", "cp_pi", id, 0, null, "gpt-5.6-sol"],
    ["claude-sdk", "cp_claude", "native-claude", 10, null, "opus"],
  ]);
  // Claude's first prompt on its fresh session: what precedes it is pi's.
  fakeLog([
    [3, "pi-a"],
    [11, "claude-u"],
    [12, "claude-a"],
  ]);
  const claudeFork = vi.spyOn(claudeSdkStore, "forkSession");
  assert.deepEqual(
    prepareFork("claude-sdk", {
      ...request,
      id,
      entryId: "e11",
      position: "before",
      anchors: sessionRuntime.forkAnchors(id, "e11"),
    }),
    {
      refusal:
        "Failed to fork session: there is nothing before this prompt to branch from.",
    },
  );
  assert.equal(claudeFork.mock.calls.length, 0);
});

test("a fork on a return finds its cut in the Claude session the return resumed", async () => {
  const id = "claude-pi-claude";
  seedBindings(id, [
    ["claude-sdk", "cp_claude", "native-claude", 0, null, "opus"],
    ["pi", "cp_pi", id, 10, null, "gpt-5.6-sol"],
    ["claude-sdk", "cp_claude", "native-claude", 20, 1, "sonnet"],
  ]);
  fakeLog([
    [3, "claude-a"],
    [12, "pi-a"],
    [21, "claude-u2"],
  ]);
  const claudeFork = vi
    .spyOn(claudeSdkStore, "forkSession")
    .mockResolvedValue({ sessionId: "child-r" } as never);
  const prepared = prepareFork("claude-sdk", {
    ...request,
    id,
    entryId: "e21",
    position: "before",
    anchors: sessionRuntime.forkAnchors(id, "e21"),
  });
  assert.ok("fork" in prepared);
  await prepared.fork();
  // pi's entry sits between them, but it is not in this native session.
  assert.equal(claudeFork.mock.calls[0]?.[1].anchor, "claude-a");
  assert.equal(claudeFork.mock.calls[0]?.[1].keepThroughEntryId, "e3");
  assert.deepEqual(claudeFork.mock.calls[0]?.[1].binding, {
    nativeSessionId: "native-claude",
    credentialProfileId: "cp_claude",
    modelId: "sonnet",
    thinkingLevel: "high",
  });
});

test("a session that never switched forks exactly as before", async () => {
  const id = "never-switched";
  sessionStore.upsert({
    id,
    harness: "claude-sdk",
    agentType: "developer",
    credentialProfileId: "cp_claude",
  });
  const anchors = vi.spyOn(sessionRuntime, "forkAnchors");
  const claudeFork = vi
    .spyOn(claudeSdkStore, "forkSession")
    .mockResolvedValue({ sessionId: "child-n" } as never);
  const prepared = prepareFork("claude-sdk", {
    ...request,
    id,
    position: "at",
    anchors: { entryFound: true, own: "native-2", seq: 4 },
  });
  assert.ok("fork" in prepared);
  await prepared.fork();
  assert.equal(anchors.mock.calls.length, 0);
  assert.equal("binding" in claudeFork.mock.calls[0]![1], false);
});
