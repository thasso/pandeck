import assert from "node:assert/strict";
import { test } from "vitest";
import type { ClientTimelineEntry } from "@assistant/shared/runtime";
import { buildCommitSessionManager } from "./claudeCommitContext.ts";

const entries: ClientTimelineEntry[] = [
  {
    id: "u1",
    seq: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: "edit the config" }],
  },
  {
    id: "hidden-u",
    seq: 1,
    createdAt: "2026-01-01T00:00:00.500Z",
    type: "message",
    role: "user",
    origin: { kind: "system" },
    hidden: true,
    content: [{ type: "text", text: "question-panel continuation" }],
  },
  {
    id: "a1",
    seq: 2,
    createdAt: "2026-01-01T00:00:01.000Z",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "toolCall",
        toolCallId: "t1",
        name: "Write",
        input: { path: "config/app.json" },
      },
    ],
  },
  {
    id: "tr1",
    seq: 3,
    createdAt: "2026-01-01T00:00:02.000Z",
    type: "message",
    role: "toolResult",
    toolCallId: "t1",
    content: [{ type: "text", text: "ok" }],
  },
  {
    id: "cmd-c1",
    seq: 4,
    createdAt: "2026-01-01T00:00:03.000Z",
    type: "command.result",
    name: "commit",
    card: {
      kind: "commit",
      id: "c1",
      commit: {
        status: "committed",
        commitHash: "abc1234",
        files: [],
        totals: { files: 1, additions: 1, deletions: 0 },
        blockers: [],
        warnings: [],
        addressedTasks: [],
      } as never,
    },
  },
  {
    id: "tool-c2",
    seq: 5,
    createdAt: "2026-01-01T00:00:04.000Z",
    type: "message",
    role: "toolResult",
    toolCallId: "t2",
    toolName: "mcp__pa__worktree_commit",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "committed",
          dryRun: false,
          forced: false,
          commitHash: "def5678",
          files: [],
          totals: { files: 1, additions: 1, deletions: 0 },
          blockers: [],
          warnings: [],
        }),
      },
    ],
  },
];

test("builds commit workflow branch from normalized Claude timeline", () => {
  const manager = buildCommitSessionManager(() => entries) as {
    getBranch(): Array<{
      type: string;
      id: string;
      message?: { role: string; content: unknown };
      customType?: string;
      data?: { status?: string };
    }>;
  };
  const branch = manager.getBranch();

  assert.equal(
    branch.length,
    4,
    "ordinary tool results stay hidden while commit results become checkpoints",
  );
  assert.deepEqual(branch[0], {
    type: "message",
    id: "u1",
    message: { role: "user", content: "edit the config" },
  });
  assert.deepEqual(branch[1], {
    type: "message",
    id: "a1",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "t1",
          name: "write",
          arguments: { path: "config/app.json" },
        },
      ],
    },
  });
  assert.equal(branch[2]?.type, "custom");
  assert.equal(branch[2]?.customType, "workshop.commit");
  assert.equal(branch[2]?.data?.status, "committed");
  assert.equal(branch[3]?.type, "custom");
  assert.equal(branch[3]?.customType, "workshop.commit");
  assert.equal(branch[3]?.data?.status, "committed");
});

test("checkpoints a tool commit within the same turn, then adopts its durable result", () => {
  const timeline = [...entries];
  const manager = buildCommitSessionManager(() => timeline);
  manager.appendCustomEntry("workshop.commit", {
    status: "committed",
    commitHash: "same-turn-commit",
  });
  const pending = manager.getBranch() as Array<{
    id: string;
    customType?: string;
    data?: { commitHash?: string };
  }>;
  assert.equal(pending.at(-1)?.data?.commitHash, "same-turn-commit");
  assert.match(pending.at(-1)?.id ?? "", /^pending-tool-commit-/);

  timeline.push({
    id: "tool-c3",
    seq: 6,
    createdAt: "2026-01-01T00:00:05.000Z",
    type: "message",
    role: "toolResult",
    toolCallId: "t3",
    toolName: "mcp__pa__worktree_commit",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "committed",
          dryRun: false,
          forced: false,
          commitHash: "same-turn-commit",
          files: [],
          totals: { files: 0, additions: 0, deletions: 0 },
          blockers: [],
          warnings: [],
        }),
      },
    ],
  });
  const durable = manager.getBranch() as Array<{
    id: string;
    data?: { commitHash?: string };
  }>;
  assert.equal(durable.at(-1)?.id, "tool-c3");
  assert.equal(
    durable.filter((entry) => entry.data?.commitHash === "same-turn-commit")
      .length,
    1,
  );
});
