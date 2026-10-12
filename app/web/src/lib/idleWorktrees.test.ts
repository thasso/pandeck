import { describe, expect, it } from "vitest";
import type {
  IdleWorktree,
  PullRequestInventoryItem,
  WorktreeRecord,
} from "@assistant/shared";
import {
  idleForLabel,
  idleWorktreeLabel,
  idleWorktreeRows,
  retirableIdleWorktrees,
} from "./idleWorktrees.ts";

function worktree(id: string): WorktreeRecord {
  return {
    id,
    projectId: "pa",
    mainRepoRoot: "/repo",
    path: `/repo-${id}`,
    branch: id,
    baseBranch: "main",
    baseCommit: "abc",
    status: "active",
    sessionIds: [],
    taskIds: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

function idle(
  id: string,
  kind: IdleWorktree["kind"],
  lastActivityAt = 0,
  patch: Partial<IdleWorktree> = {},
): IdleWorktree {
  return { worktree: worktree(id), kind, lastActivityAt, ...patch };
}

describe("idleWorktreeRows", () => {
  it("orders safest first, then most idle, and leaves covered checkouts to their pull request", () => {
    const rows = idleWorktreeRows(
      [
        idle("dirty", "uncommitted", 1),
        idle("new-done", "delivered", 50),
        idle("old-done", "delivered", 10),
        idle("covered", "delivered", 0),
        idle("gone", "missing", 5),
        idle("unsure", "unknown", 0),
        idle("work", "unmerged", 0),
      ],
      [{ worktreeId: "covered" } as PullRequestInventoryItem],
    );
    expect(rows.map((row) => row.worktree.id)).toEqual([
      "old-done",
      "new-done",
      "gone",
      "work",
      "dirty",
      "unsure",
    ]);
    expect(retirableIdleWorktrees(rows).map((row) => row.worktree.id)).toEqual([
      "old-done",
      "new-done",
    ]);
  });

  it("covers nothing while the inventory has not answered", () => {
    expect(idleWorktreeRows([idle("a", "delivered")], undefined)).toHaveLength(
      1,
    );
  });
});

describe("idleWorktreeLabel", () => {
  it("states what retiring would lose, and never calls unknown clean", () => {
    expect(idleWorktreeLabel(idle("a", "delivered"))).toBe("Nothing unmerged");
    const merged = idle("m", "delivered");
    merged.worktree.pullRequest = { status: "merged", number: 7 };
    expect(idleWorktreeLabel(merged)).toBe("Pull request merged");
    expect(idleWorktreeLabel(idle("a", "unknown"))).toBe("State unknown");
    expect(idleWorktreeLabel(idle("a", "missing"))).toBe("Checkout missing");
    expect(
      idleWorktreeLabel(idle("a", "unmerged", 0, { ahead: 1, pushed: true })),
    ).toBe("1 unmerged commit · pushed");
    expect(
      idleWorktreeLabel(idle("a", "unmerged", 0, { ahead: 3, pushed: false })),
    ).toBe("3 unmerged commits · not pushed");
    expect(
      idleWorktreeLabel(idle("a", "uncommitted", 0, { changedFiles: 4 })),
    ).toBe("4 uncommitted files");
  });

  it("says how long it has been idle", () => {
    const now = 10 * 86_400_000;
    expect(idleForLabel(now - 5 * 60_000, now)).toBe("idle 5 min");
    expect(idleForLabel(now - 3 * 3_600_000, now)).toBe("idle 3 h");
    expect(idleForLabel(now - 3 * 86_400_000, now)).toBe("idle 3 d");
    expect(idleForLabel(now + 1_000, now)).toBe("idle 0 min");
  });
});
