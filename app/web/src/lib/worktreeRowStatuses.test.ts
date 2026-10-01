import { describe, expect, it } from "vitest";
import type { WorktreeGitStatus, WorktreeRecord } from "@assistant/shared";
import {
  cacheableWorktreeStatuses,
  rowWorktreeStatus,
  worktreeSilhouetteKey,
} from "./worktreeRowStatuses.ts";

function status(
  worktreeId: string,
  overrides: Partial<WorktreeGitStatus> = {},
): WorktreeGitStatus {
  return {
    worktreeId,
    branch: worktreeId,
    head: "abc",
    dirty: false,
    filesChanged: 0,
    untracked: 0,
    additions: 0,
    deletions: 0,
    ahead: 1,
    behind: 0,
    merged: false,
    updatedAt: 1,
    fetchedAt: 1,
    ...overrides,
  };
}

function worktree(id: string): WorktreeRecord {
  return {
    id,
    projectId: "project",
    mainRepoRoot: "/repo",
    path: `/repo/worktrees/${id}`,
    branch: id,
    baseBranch: "main",
    baseCommit: "abc",
    status: "active",
    sessionIds: [],
    taskIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("rowWorktreeStatus", () => {
  it("lays a row out from the last known status until its watch answers", () => {
    expect(rowWorktreeStatus({}, { one: status("one") }, "one")?.ahead).toBe(1);
  });

  it("prefers this episode's status over what the browser remembers", () => {
    const live = { one: status("one", { ahead: 4 }) };
    expect(rowWorktreeStatus(live, { one: status("one") }, "one")?.ahead).toBe(
      4,
    );
  });

  it("stays unknown for a worktree neither record has seen", () => {
    expect(rowWorktreeStatus({}, {}, "one")).toBeUndefined();
  });
});

describe("cacheableWorktreeStatuses", () => {
  it("keeps a remembered status no watch answered this episode", () => {
    // The erase this exists to prevent: an app opened without ever visiting a
    // worktree surface would otherwise write an empty record over the heights
    // the next cold start paints from.
    const kept = cacheableWorktreeStatuses({}, { one: status("one") }, [
      worktree("one"),
    ]);
    expect(kept.one?.ahead).toBe(1);
  });

  it("stores what this episode observed over what it remembered", () => {
    const kept = cacheableWorktreeStatuses(
      { one: status("one", { dirty: true }) },
      { one: status("one") },
      [worktree("one")],
    );
    expect(kept.one?.dirty).toBe(true);
  });

  it("drops a status whose worktree is no longer in the cached list", () => {
    const kept = cacheableWorktreeStatuses(
      { one: status("one"), gone: status("gone") },
      {},
      [worktree("one")],
    );
    expect(Object.keys(kept)).toEqual(["one"]);
  });
});

describe("worktreeSilhouetteKey", () => {
  it("says nothing new when a push only moves counts inside a drawn shape", () => {
    expect(worktreeSilhouetteKey({ one: status("one", { dirty: true }) })).toBe(
      worktreeSilhouetteKey({
        one: status("one", {
          dirty: true,
          filesChanged: 9,
          additions: 120,
          deletions: 38,
          updatedAt: 99,
        }),
      }),
    );
  });

  it("moves when a worktree gains a status, whatever order it arrives in", () => {
    const both = worktreeSilhouetteKey({
      two: status("two"),
      one: status("one"),
    });
    expect(both).not.toBe(worktreeSilhouetteKey({ one: status("one") }));
    expect(both).toBe(
      worktreeSilhouetteKey({ one: status("one"), two: status("two") }),
    );
  });

  it("moves for every element a row draws, so a written silhouette is rewritten", () => {
    // Each of these changes what the row shows and therefore its height, and
    // each must schedule a cache write even though the id set is unchanged.
    const base = { one: status("one", { ahead: 0 }) };
    const key = worktreeSilhouetteKey(base);
    for (const overrides of [
      { dirty: true },
      { merged: true },
      { ahead: 2 },
      { behind: 2 },
      { upstream: { ahead: 0, behind: 0 } },
      { baseUpstream: { ahead: 1, behind: 0 } },
    ] satisfies Partial<WorktreeGitStatus>[]) {
      expect(
        worktreeSilhouetteKey({
          one: status("one", { ahead: 0, ...overrides }),
        }),
      ).not.toBe(key);
    }
  });
});
