import { describe, expect, it } from "vitest";
import type {
  SessionListItem,
  TaskSummary,
  WorktreeRecord,
} from "@assistant/shared";
import { worktreeForTask } from "./worktrees.ts";

function worktree(
  partial: Partial<WorktreeRecord> & { id: string },
): WorktreeRecord {
  return {
    projectId: "pa",
    mainRepoRoot: "/repo",
    path: `/worktrees/${partial.id}`,
    branch: partial.id,
    baseBranch: "main",
    baseCommit: "abc",
    status: "active",
    sessionIds: [],
    taskIds: [],
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

function session(
  partial: Partial<SessionListItem> & { id: string },
): SessionListItem {
  return {
    harness: "pi",
    title: partial.id,
    updatedAt: 0,
    ...partial,
  } as SessionListItem;
}

function task(partial: Partial<TaskSummary> & { id: string }): TaskSummary {
  return {
    title: partial.id,
    status: "todo",
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  } as TaskSummary;
}

describe("worktreeForTask", () => {
  it("prefers the task's own in_worktree edge", () => {
    const worktrees = [
      worktree({ id: "wt-a" }),
      worktree({ id: "wt-b", taskIds: ["227"] }),
    ];
    expect(worktreeForTask("227", worktrees, [], [])).toBe("wt-b");
  });

  it("breaks an ambiguous edge on the most recent worktree rather than list order", () => {
    const worktrees = [
      worktree({ id: "wt-old", taskIds: ["227"], updatedAt: 10 }),
      worktree({ id: "wt-new", taskIds: ["227"], updatedAt: 90 }),
    ];
    expect(worktreeForTask("227", worktrees, [], [])).toBe("wt-new");
  });

  it("falls back to the newest session that claims the task and runs in a worktree", () => {
    const worktrees = [worktree({ id: "wt-a" }), worktree({ id: "wt-b" })];
    const sessions = [
      session({ id: "s1", worktreeId: "wt-a", updatedAt: 10 }),
      session({ id: "s2", worktreeId: "wt-b", updatedAt: 90 }),
    ];
    const sessionRefsValue = [
      { sessionId: "s1" },
      { sessionId: "s2" },
    ] as TaskSummary["sessionRefs"];
    const tasks = [
      task({
        id: "227",
        ...(sessionRefsValue !== undefined
          ? { sessionRefs: sessionRefsValue }
          : {}),
      }),
    ];
    expect(worktreeForTask("227", worktrees, sessions, tasks)).toBe("wt-b");
  });

  it("ignores sessions that claim the task but run nowhere", () => {
    const worktrees = [worktree({ id: "wt-a" })];
    const sessions = [session({ id: "s1", updatedAt: 90 })];
    const sessionRefsValue = [
      { sessionId: "s1" },
    ] as TaskSummary["sessionRefs"];
    const tasks = [
      task({
        id: "227",
        ...(sessionRefsValue !== undefined
          ? { sessionRefs: sessionRefsValue }
          : {}),
      }),
    ];
    expect(worktreeForTask("227", worktrees, sessions, tasks)).toBeUndefined();
  });

  it("ignores sessions in a worktree that is no longer listed", () => {
    const sessions = [
      session({ id: "s1", worktreeId: "wt-gone", updatedAt: 90 }),
    ];
    const sessionRefsValue = [
      { sessionId: "s1" },
    ] as TaskSummary["sessionRefs"];
    const tasks = [
      task({
        id: "227",
        ...(sessionRefsValue !== undefined
          ? { sessionRefs: sessionRefsValue }
          : {}),
      }),
    ];
    expect(
      worktreeForTask("227", [worktree({ id: "wt-a" })], sessions, tasks),
    ).toBeUndefined();
  });

  // A Task's edge outlives the checkout it names, so a removed worktree must
  // never be staged — the session would be created against a missing cwd.
  it("never returns a removed worktree, by either rule", () => {
    const removed = worktree({ id: "wt-dead", taskIds: ["227"], removedAt: 5 });
    expect(worktreeForTask("227", [removed], [], [])).toBeUndefined();

    const sessions = [
      session({ id: "s1", worktreeId: "wt-dead", updatedAt: 90 }),
    ];
    const sessionRefsValue = [
      { sessionId: "s1" },
    ] as TaskSummary["sessionRefs"];
    const tasks = [
      task({
        id: "227",
        ...(sessionRefsValue !== undefined
          ? { sessionRefs: sessionRefsValue }
          : {}),
      }),
    ];
    expect(worktreeForTask("227", [removed], sessions, tasks)).toBeUndefined();
  });

  it("degrades on an unloaded worktree list and on a task nothing claims", () => {
    expect(worktreeForTask("227", null, [], [])).toBeUndefined();
    expect(
      worktreeForTask(
        "227",
        [worktree({ id: "wt-a" })],
        [],
        [task({ id: "227" })],
      ),
    ).toBeUndefined();
  });
});
