import { describe, expect, it } from "vitest";
import type { SessionListItem } from "@assistant/shared";
import type { Task } from "./backlogTree.ts";
import {
  buildTaskRowMeta,
  taskRowMetaEmpty,
  taskRowsHaveMeta,
  type TaskRowMetaContext,
} from "./taskRowMeta.ts";

const TODAY = "2026-08-06";
const NOW = Date.parse(`${TODAY}T12:00:00Z`);

function task(patch: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${patch.id}`,
    status: "todo",
    source: { createdBy: "user" },
    createdAt: 0,
    updatedAt: NOW,
    ...patch,
  } as Task;
}

function session(patch: Partial<SessionListItem> & { id: string }) {
  return {
    harness: "pi",
    title: `Session ${patch.id}`,
    updatedAt: NOW,
    messageCount: 1,
    ...patch,
  } as SessionListItem;
}

function context(patch: Partial<TaskRowMetaContext> = {}): TaskRowMetaContext {
  return {
    today: TODAY,
    sessionById: new Map(),
    showProjectBadge: false,
    now: NOW,
    ...patch,
  };
}

describe("buildTaskRowMeta: uncommitted changes", () => {
  const worked = task({
    id: "1",
    sessionRefs: [{ sessionId: "s1", origin: "task-start" }],
  });
  const sessionById = new Map([
    ["s1", session({ id: "s1", worktreeId: "wt1" })],
  ]);

  it("marks the worktree the row's own session runs in", () => {
    const meta = buildTaskRowMeta(
      worked,
      context({ sessionById, dirtyWorktrees: new Set(["wt1"]) }),
    );
    expect(meta.worktreeId).toBe("wt1");
    expect(meta.dirty).toBe(true);
  });

  it("says nothing about a worktree it was not told about", () => {
    // Absent is UNKNOWN, not clean — a surface that is handed no slice at all
    // must not turn into a screen of clean-looking branches.
    expect(
      buildTaskRowMeta(
        worked,
        context({ sessionById, dirtyWorktrees: new Set(["wt-other"]) }),
      ).dirty,
    ).toBe(false);
    expect(buildTaskRowMeta(worked, context({ sessionById })).dirty).toBe(
      false,
    );
  });

  it("never claims dirt for a Task with no worktree", () => {
    // The row draws the marker ON the chip that states the code; without one
    // there is nothing to mark, whatever the slice happens to hold.
    const meta = buildTaskRowMeta(
      task({ id: "2" }),
      context({ dirtyWorktrees: new Set(["wt1"]) }),
    );
    expect(meta.dirty).toBe(false);
    expect(taskRowMetaEmpty(meta)).toBe(true);
  });
});

describe("buildTaskRowMeta: workflow", () => {
  it("projects attention for the Task and counts it as non-empty meta", () => {
    const meta = buildTaskRowMeta(
      task({ id: "370" }),
      context({
        workflowByTask: new Map([["370", { running: false, attention: true }]]),
      }),
    );
    expect(meta.workflow).toEqual({ attention: true });
    expect(taskRowMetaEmpty(meta)).toBe(false);
  });
});

describe("taskRowsHaveMeta", () => {
  it("answers for the surfaces that pay for the second line", () => {
    // The desktop rail's tree rows are the one surface with nowhere to state
    // any of this — and so the one that must not make the app poll or watch.
    expect(taskRowsHaveMeta("tight", "backlog")).toBe(false);
    expect(taskRowsHaveMeta("tight", "focus")).toBe(true);
    expect(taskRowsHaveMeta("comfortable", "backlog")).toBe(true);
    expect(taskRowsHaveMeta("comfortable", "inbox")).toBe(true);
  });
});
