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
  const prepared = prepareFork("pi", {
    ...request,
    position: "at",
    anchors: { entryFound: true },
  });
  assert.ok("refusal" in prepared);
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
    .mockResolvedValue({ sessionId: "child" } as never);

  const prepared = prepareFork("claude-sdk", {
    ...request,
    position: "at",
    anchors: { entryFound: true, own: "native-2" },
  });
  assert.ok("fork" in prepared);
  const child = await prepared.fork();

  assert.equal(child.sessionId, "child");
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
