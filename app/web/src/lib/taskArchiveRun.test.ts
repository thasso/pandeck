import { beforeEach, describe, expect, it } from "vitest";
import type { SessionListItem } from "@assistant/shared";
import type { Task } from "./backlogTree.ts";
import type { ArchiveContext } from "./taskArchive.ts";
import { runTaskArchive } from "./taskArchiveRun.ts";
import { dismissToastKey, getToasts } from "./toast.ts";

function task(patch: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${patch.id}`,
    status: "todo",
    source: { createdBy: "user" },
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as Task;
}

function ctxOf(tasks: Task[]): ArchiveContext {
  return { tasks, sessionById: new Map<string, SessionListItem>() };
}

function recorder() {
  const calls: Array<{ id: string; archived?: boolean }> = [];
  return {
    calls,
    actions: {
      archiveTask: (id: string, archived?: boolean) =>
        calls.push({ id, ...(archived !== undefined ? { archived } : {}) }),
    },
  };
}

const toast = () => getToasts().find((t) => t.key === "backlog-archive");

beforeEach(() => dismissToastKey("backlog-archive"));

describe("runTaskArchive", () => {
  it("archives and offers Undo, which restores exactly what it archived", () => {
    const tasks = [
      task({ id: "a", status: "done", title: "Ship it" }),
      task({ id: "b", status: "done" }),
    ];
    const { calls, actions } = recorder();

    expect(runTaskArchive(["a", "b"], ctxOf(tasks), actions)).toEqual([
      "a",
      "b",
    ]);
    expect(calls).toEqual([
      { id: "a", archived: true },
      { id: "b", archived: true },
    ]);

    const receipt = toast();
    expect(receipt?.message).toBe("Archived 2 Tasks.");
    expect(receipt?.action?.label).toBe("Undo");
    receipt?.action?.onClick();
    expect(calls.slice(2)).toEqual([
      { id: "a", archived: false },
      { id: "b", archived: false },
    ]);
    // The receipt goes with the undo: an Undo that can be pressed twice would
    // re-archive nothing and read as if it failed.
    expect(toast()).toBeUndefined();
  });

  it("names the single Task it archived", () => {
    const tasks = [task({ id: "a", status: "done", title: "Ship it" })];
    const { actions } = recorder();
    runTaskArchive(["a"], ctxOf(tasks), actions);
    expect(toast()?.message).toBe("Archived “Ship it”.");
  });

  it("takes a done epic's finished subtree with it, and Undo brings it back", () => {
    // The bug this exists to prevent: archiving the head alone left the done
    // subtasks behind, promoted to the root and detached from their epic.
    const tasks = [
      task({ id: "a", status: "done", title: "Epic" }),
      task({ id: "b", parentId: "a", status: "done" }),
      task({ id: "c", parentId: "b", status: "done" }),
    ];
    const { calls, actions } = recorder();

    expect(runTaskArchive(["a"], ctxOf(tasks), actions)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(calls).toEqual([
      { id: "a", archived: true },
      { id: "b", archived: true },
      { id: "c", archived: true },
    ]);
    // The receipt names the row the user acted on and counts what followed it:
    // "Archived 3 Tasks" after touching one row reads as a bug.
    expect(toast()?.message).toBe("Archived “Epic” and 2 subtasks.");

    toast()?.action?.onClick();
    expect(calls.slice(3)).toEqual([
      { id: "a", archived: false },
      { id: "b", archived: false },
      { id: "c", archived: false },
    ]);
  });

  it("counts one subtask in the singular", () => {
    const tasks = [
      task({ id: "a", status: "done", title: "Epic" }),
      task({ id: "b", parentId: "a", status: "done" }),
    ];
    const { actions } = recorder();
    runTaskArchive(["a"], ctxOf(tasks), actions);
    expect(toast()?.message).toBe("Archived “Epic” and 1 subtask.");
  });

  it("does not carry off an already-archived subtask, so Undo cannot restore it", () => {
    const tasks = [
      task({ id: "a", status: "done", title: "Epic" }),
      task({ id: "b", parentId: "a", status: "done", archivedAt: 5 }),
    ];
    const { calls, actions } = recorder();
    expect(runTaskArchive(["a"], ctxOf(tasks), actions)).toEqual(["a"]);
    expect(calls).toEqual([{ id: "a", archived: true }]);
    expect(toast()?.message).toBe("Archived “Epic”.");
  });

  it("refuses an epic with open subtasks and archives NOTHING", () => {
    const tasks = [
      task({ id: "a", status: "done", title: "Epic" }),
      task({ id: "b", parentId: "a" }),
      task({ id: "c", parentId: "b", status: "done" }),
    ];
    const { calls, actions } = recorder();

    expect(runTaskArchive(["a"], ctxOf(tasks), actions)).toBeNull();
    expect(calls).toEqual([]);

    const refusal = toast();
    expect(refusal?.tone).toBe("error");
    expect(refusal?.message).toBe("“Epic” still has 1 unfinished subtask.");

    // The escape hatch takes the WHOLE subtree, including the done child, so
    // nothing is left stranded at the root by the parent disappearing.
    expect(refusal?.action?.label).toBe("Archive all 3");
    refusal?.action?.onClick();
    expect(calls).toEqual([
      { id: "a", archived: true },
      { id: "b", archived: true },
      { id: "c", archived: true },
    ]);
    expect(toast()?.message).toBe("Archived 3 Tasks.");
  });

  it("names the target that blocked, not the first one selected", () => {
    const tasks = [
      task({ id: "a", status: "done", title: "Fine" }),
      task({ id: "b", status: "done", title: "Epic" }),
      task({ id: "c", parentId: "b" }),
    ];
    const { actions } = recorder();
    runTaskArchive(["a", "b"], ctxOf(tasks), actions);
    expect(toast()?.message).toBe("“Epic” still has 1 unfinished subtask.");
  });

  it("refuses an unanswered status claim with no way to force it", () => {
    const tasks = [
      task({
        id: "a",
        status: "done",
        title: "Claimed",
        statusSuggestion: { to: "todo", by: { kind: "agent" }, at: 1 },
      } as Partial<Task> & { id: string }),
    ];
    const { calls, actions } = recorder();

    expect(runTaskArchive(["a"], ctxOf(tasks), actions)).toBeNull();
    expect(calls).toEqual([]);
    expect(toast()?.action).toBeUndefined();
  });

  it("does nothing for ids the list does not know", () => {
    const { calls, actions } = recorder();
    expect(runTaskArchive(["ghost"], ctxOf([]), actions)).toBeNull();
    expect(calls).toEqual([]);
    expect(toast()).toBeUndefined();
  });
});
