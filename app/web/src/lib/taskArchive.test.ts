import { describe, expect, it } from "vitest";
import type { SessionListItem } from "@assistant/shared";
import type { Task } from "./backlogTree.ts";
import {
  archiveBlocker,
  archiveBlockerMessage,
  archiveSet,
  descendantsOf,
  quickArchiveOffered,
  type ArchiveContext,
} from "./taskArchive.ts";

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

function ctx(tasks: Task[], sessions: SessionListItem[] = []): ArchiveContext {
  return {
    tasks,
    sessionById: new Map(sessions.map((session) => [session.id, session])),
  };
}

function streaming(id: string, isStreaming: boolean): SessionListItem {
  return { id, isStreaming } as SessionListItem;
}

describe("archiveBlocker", () => {
  it("allows a done leaf", () => {
    const tasks = [task({ id: "a", status: "done" })];
    expect(archiveBlocker(["a"], ctx(tasks))).toBeNull();
  });

  it("allows a Task that is not done — archiving is also 'not doing this'", () => {
    const tasks = [task({ id: "a" })];
    expect(archiveBlocker(["a"], ctx(tasks))).toBeNull();
  });

  it("refuses a done parent whose subtask is still open", () => {
    const tasks = [
      task({ id: "a", status: "done" }),
      task({ id: "b", parentId: "a" }),
    ];
    expect(archiveBlocker(["a"], ctx(tasks))).toEqual({
      kind: "open-subtasks",
      openIds: ["b"],
      taskId: "a",
    });
  });

  it("looks down the WHOLE subtree, not just direct children", () => {
    const tasks = [
      task({ id: "a", status: "done" }),
      task({ id: "b", parentId: "a", status: "done" }),
      task({ id: "c", parentId: "b", status: "doing" }),
    ];
    expect(archiveBlocker(["a"], ctx(tasks))).toEqual({
      kind: "open-subtasks",
      openIds: ["c"],
      taskId: "a",
    });
  });

  it("allows the epic when the open subtasks are in the same archive set", () => {
    // Nothing is stranded: the whole subtree leaves the list together.
    const tasks = [
      task({ id: "a", status: "done" }),
      task({ id: "b", parentId: "a" }),
    ];
    expect(archiveBlocker(["a", "b"], ctx(tasks))).toBeNull();
  });

  it("ignores subtasks that are already archived", () => {
    const tasks = [
      task({ id: "a", status: "done" }),
      task({ id: "b", parentId: "a", archivedAt: 5 }),
    ];
    expect(archiveBlocker(["a"], ctx(tasks))).toBeNull();
  });

  it("refuses while an agent's status claim is unanswered", () => {
    const tasks = [
      task({
        id: "a",
        status: "done",
        statusSuggestion: { to: "todo", by: { kind: "agent" }, at: 1 },
      } as Partial<Task> & { id: string }),
    ];
    expect(archiveBlocker(["a"], ctx(tasks))).toEqual({
      kind: "pending-suggestion",
      taskId: "a",
    });
  });

  it("allows an ANSWERED claim through — it is provenance, not a question", () => {
    const tasks = [
      task({
        id: "a",
        status: "done",
        statusSuggestion: { to: "done", by: { kind: "agent" }, at: 1 },
      } as Partial<Task> & { id: string }),
    ];
    expect(archiveBlocker(["a"], ctx(tasks))).toBeNull();
  });

  it("refuses while a session started from the Task is streaming", () => {
    const tasks = [
      task({
        id: "a",
        status: "done",
        sessionRefs: [{ sessionId: "s1", origin: "task-start" }],
      } as Partial<Task> & { id: string }),
    ];
    expect(archiveBlocker(["a"], ctx(tasks, [streaming("s1", true)]))).toEqual({
      kind: "working",
      taskId: "a",
    });
  });

  it("ignores a session that merely REFERENCED the Task", () => {
    const tasks = [
      task({
        id: "a",
        status: "done",
        sessionRefs: [{ sessionId: "s1", origin: "reference" }],
      } as Partial<Task> & { id: string }),
    ];
    expect(
      archiveBlocker(["a"], ctx(tasks, [streaming("s1", true)])),
    ).toBeNull();
  });

  it("reports WHICH target blocked, not the one clicked first", () => {
    const tasks = [
      task({ id: "a", status: "done" }),
      task({ id: "b", status: "done" }),
      task({ id: "c", parentId: "b" }),
    ];
    expect(archiveBlocker(["a", "b"], ctx(tasks))).toEqual({
      kind: "open-subtasks",
      openIds: ["c"],
      taskId: "b",
    });
  });

  it("refuses the epic for a claim on the subtask it would carry off", () => {
    // The cascade takes the finished subtask, so its unanswered question would
    // leave with it instead of staying visible at the root.
    const tasks = [
      task({ id: "a", status: "done" }),
      task({
        id: "b",
        parentId: "a",
        status: "done",
        statusSuggestion: { to: "todo", by: { kind: "agent" }, at: 1 },
      } as Partial<Task> & { id: string }),
    ];
    expect(archiveBlocker(["a"], ctx(tasks))).toEqual({
      kind: "pending-suggestion",
      taskId: "b",
    });
    expect(archiveBlocker(["b"], ctx(tasks))).toEqual({
      kind: "pending-suggestion",
      taskId: "b",
    });
  });

  it("refuses the epic while a session on a finished subtask streams", () => {
    const tasks = [
      task({ id: "a", status: "done" }),
      task({
        id: "b",
        parentId: "a",
        status: "done",
        sessionRefs: [{ sessionId: "s1", origin: "task-start" }],
      } as Partial<Task> & { id: string }),
    ];
    expect(archiveBlocker(["a"], ctx(tasks, [streaming("s1", true)]))).toEqual({
      kind: "working",
      taskId: "b",
    });
  });

  it("survives a parent cycle", () => {
    const tasks = [
      task({ id: "a", status: "done", parentId: "b" }),
      task({ id: "b", status: "done", parentId: "a" }),
    ];
    expect(archiveBlocker(["a"], ctx(tasks))).toBeNull();
  });
});

describe("archiveSet", () => {
  it("takes the finished subtree with the epic, parent before child", () => {
    const tasks = [
      task({ id: "a", status: "done" }),
      task({ id: "b", parentId: "a", status: "done" }),
      task({ id: "c", parentId: "b", status: "done" }),
      task({ id: "d", status: "done" }),
    ];
    expect(archiveSet(["a"], ctx(tasks))).toEqual(["a", "b", "c"]);
  });

  it("leaves UNFINISHED descendants out — that is the blocker's business", () => {
    const tasks = [
      task({ id: "a", status: "done" }),
      task({ id: "b", parentId: "a", status: "doing" }),
      task({ id: "c", parentId: "a", status: "done" }),
    ];
    expect(archiveSet(["a"], ctx(tasks))).toEqual(["a", "c"]);
  });

  it("takes an unfinished descendant that was REQUESTED (the escape hatch)", () => {
    const tasks = [
      task({ id: "a", status: "done" }),
      task({ id: "b", parentId: "a" }),
    ];
    expect(archiveSet(["a", "b"], ctx(tasks))).toEqual(["a", "b"]);
  });

  it("skips rows already archived, and keeps reaching past them", () => {
    // An archived row needs no archiving, and including it would make Undo
    // restore an archive the user made earlier and separately.
    const tasks = [
      task({ id: "a", status: "done" }),
      task({ id: "b", parentId: "a", status: "done", archivedAt: 5 }),
      task({ id: "c", parentId: "b", status: "done" }),
    ];
    expect(archiveSet(["a"], ctx(tasks))).toEqual(["a", "c"]);
    expect(archiveSet(["b"], ctx(tasks))).toEqual(["c"]);
  });

  it("deduplicates an epic requested together with its own subtask", () => {
    const tasks = [
      task({ id: "a", status: "done" }),
      task({ id: "b", parentId: "a", status: "done" }),
    ];
    expect(archiveSet(["b", "a"], ctx(tasks))).toEqual(["b", "a"]);
  });

  it("ignores ids the list does not know", () => {
    expect(archiveSet(["ghost"], ctx([]))).toEqual([]);
  });
});

describe("descendantsOf", () => {
  it("excludes the root and returns the full subtree", () => {
    const tasks = [
      task({ id: "a" }),
      task({ id: "b", parentId: "a" }),
      task({ id: "c", parentId: "b" }),
      task({ id: "d" }),
    ];
    expect(descendantsOf(tasks, "a").map((t) => t.id)).toEqual(["b", "c"]);
  });
});

describe("quickArchiveOffered", () => {
  it("is offered on a finished leaf", () => {
    const tasks = [task({ id: "a", status: "done" })];
    expect(quickArchiveOffered(tasks[0]!, ctx(tasks))).toBe(true);
  });

  it("is NOT offered on unfinished work, even though archiving is allowed", () => {
    const tasks = [task({ id: "a", status: "doing" })];
    expect(quickArchiveOffered(tasks[0]!, ctx(tasks))).toBe(false);
    expect(archiveBlocker(["a"], ctx(tasks))).toBeNull();
  });

  it("is offered on a done epic whose whole subtree is finished", () => {
    const tasks = [
      task({ id: "a", status: "done" }),
      task({ id: "b", parentId: "a", status: "done" }),
    ];
    expect(quickArchiveOffered(tasks[0]!, ctx(tasks))).toBe(true);
    // And the gesture takes the subtask along, rather than promoting it.
    expect(archiveSet(["a"], ctx(tasks))).toEqual(["a", "b"]);
  });

  it("is not offered on a done epic with open subtasks", () => {
    const tasks = [
      task({ id: "a", status: "done" }),
      task({ id: "b", parentId: "a" }),
    ];
    expect(quickArchiveOffered(tasks[0]!, ctx(tasks))).toBe(false);
  });
});

describe("archiveBlockerMessage", () => {
  it("counts the open subtasks", () => {
    expect(
      archiveBlockerMessage(
        { kind: "open-subtasks", openIds: ["b"], taskId: "a" },
        "Epic",
      ),
    ).toBe("“Epic” still has 1 unfinished subtask.");
    expect(
      archiveBlockerMessage({
        kind: "open-subtasks",
        openIds: ["b", "c"],
        taskId: "a",
      }),
    ).toBe("That Task still has 2 unfinished subtasks.");
  });
});
