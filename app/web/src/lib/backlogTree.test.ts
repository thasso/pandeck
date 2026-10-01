import { describe, expect, it } from "vitest";
import type { Task } from "./backlogTree.ts";
import { flattenTasks, orderTasks } from "./backlogTree.ts";

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

const ids = (tasks: Task[]) => tasks.map((item) => item.id);

/**
 * The Backlog tree is the HAND-ARRANGED view: what the user dragged is the only
 * thing that decides where a row sits. Working on a Task — cycling its status,
 * scheduling it, assigning it a project — touches `updatedAt`, and none of that
 * may move it in the list.
 */
describe("orderTasks is decided by the manual order alone", () => {
  it("follows sortOrder, not recency", () => {
    const tasks = [
      task({ id: "a", sortOrder: 0, updatedAt: 10 }),
      task({ id: "b", sortOrder: 1, updatedAt: 300 }),
      task({ id: "c", sortOrder: 2, updatedAt: 200 }),
    ];
    expect(ids(orderTasks(tasks))).toEqual(["a", "b", "c"]);
  });

  it("keeps a positioned row still when its status changes", () => {
    const before = [
      task({ id: "a", sortOrder: 0, updatedAt: 10 }),
      task({ id: "b", sortOrder: 1, updatedAt: 11 }),
      task({ id: "c", sortOrder: 2, updatedAt: 12 }),
    ];
    const after = before.map((item) =>
      item.id === "c"
        ? { ...item, status: "doing" as const, updatedAt: 99 }
        : item,
    );
    expect(ids(orderTasks(after))).toEqual(ids(orderTasks(before)));
  });

  it("keeps a row the user has NEVER dragged at the spot it arrived in", () => {
    // The server hands every Task a position as it joins its group, negative for
    // a root arrival so it lands above what is already there. From then on the
    // row is ordinary: nothing it or its neighbours do moves it, and only a drag
    // renumbers the group.
    const capture = task({ id: "9", sortOrder: -1, createdAt: 500 });
    const before = [
      task({ id: "1", sortOrder: 0, createdAt: 1 }),
      task({ id: "2", sortOrder: 1, createdAt: 2 }),
      capture,
    ];
    expect(ids(orderTasks(before))).toEqual(["9", "1", "2"]);

    // Working the row, a neighbour finishing, a newer capture arriving above it:
    // its place among the rows it arrived with does not move.
    const after = [
      ...before.map((item) =>
        item.id === "9"
          ? { ...item, status: "doing" as const, updatedAt: 999 }
          : item.id === "1"
            ? { ...item, status: "done" as const, updatedAt: 998 }
            : item,
      ),
      task({ id: "10", sortOrder: -2, createdAt: 600 }),
    ];
    expect(ids(orderTasks(after))).toEqual(["10", "9", "1", "2"]);
  });

  it("keeps a LEGACY unpositioned row still when its status changes", () => {
    // Rows created before the server assigned a position on arrival have none,
    // and fall back to arrival order. Ticking one to doing must not shuffle it.
    const before = [
      task({ id: "new-1", createdAt: 300, updatedAt: 300 }),
      task({ id: "new-2", createdAt: 200, updatedAt: 200 }),
      task({ id: "old", sortOrder: 0, createdAt: 1, updatedAt: 1 }),
    ];
    expect(ids(orderTasks(before))).toEqual(["new-1", "new-2", "old"]);
    const after = before.map((item) =>
      item.id === "new-2"
        ? { ...item, status: "doing" as const, updatedAt: 999 }
        : item,
    );
    expect(ids(orderTasks(after))).toEqual(["new-1", "new-2", "old"]);
  });

  it("keeps siblings that share a sortOrder still when one changes status", () => {
    // The server hands a joining Task a free position, so a collision is a
    // legacy row or a position a caller stated itself through `task_manage`.
    // Either way the tie must not be broken by a mutable property.
    const before = [
      task({ id: "a", sortOrder: 0, createdAt: 1, updatedAt: 1 }),
      task({ id: "b", sortOrder: 1, createdAt: 2, updatedAt: 2 }),
      task({ id: "moved-in", sortOrder: 1, createdAt: 3, updatedAt: 3 }),
    ];
    const after = before.map((item) =>
      item.id === "b"
        ? { ...item, status: "done" as const, updatedAt: 999 }
        : item,
    );
    expect(ids(orderTasks(after))).toEqual(ids(orderTasks(before)));
  });

  it("orders each sibling group on its own", () => {
    const rows = flattenTasks([
      task({ id: "parent", sortOrder: 0 }),
      task({ id: "child-b", parentId: "parent", sortOrder: 1, updatedAt: 500 }),
      task({ id: "child-a", parentId: "parent", sortOrder: 0, updatedAt: 1 }),
      task({ id: "root-b", sortOrder: 1 }),
    ]);
    expect(rows.map((row) => row.item.id)).toEqual([
      "parent",
      "child-a",
      "child-b",
      "root-b",
    ]);
  });
});
