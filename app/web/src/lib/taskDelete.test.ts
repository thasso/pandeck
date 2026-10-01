import { describe, expect, it } from "vitest";
import { deleteConfirmation, deleteSet } from "./taskDelete.ts";
import type { Task } from "./backlogTree.ts";

function task(id: string, parentId?: string, title = `Task ${id}`): Task {
  return {
    id,
    title,
    status: "todo",
    ...(parentId ? { parentId } : {}),
  } as Task;
}

/** An epic with a child and a grandchild, plus an unrelated root. */
const tree = [
  task("epic"),
  task("child", "epic"),
  task("grandchild", "child"),
  task("other"),
];

describe("deleteSet", () => {
  it("takes the whole subtree, not just the row", () => {
    // The server promotes a deleted Task's children to roots, so anything left
    // behind is not spared — it is scattered.
    expect(new Set(deleteSet(tree, ["epic"]))).toEqual(
      new Set(["epic", "child", "grandchild"]),
    );
  });

  it("takes UNFINISHED descendants too, unlike the archive cascade", () => {
    // An archive can refuse to tidy away open work because the parent survives
    // to hold it. Here there is nothing left to be attached to.
    const withOpen = [task("epic"), { ...task("child", "epic") }];
    expect(deleteSet(withOpen, ["epic"])).toHaveLength(2);
  });

  it("orders every child before its parent", () => {
    const order = deleteSet(tree, ["epic"]);
    expect(order.indexOf("grandchild")).toBeLessThan(order.indexOf("child"));
    expect(order.indexOf("child")).toBeLessThan(order.indexOf("epic"));
  });

  it("orders by the TREE, not by the order the ids arrived in", () => {
    // A child requested before its own parent still has to go first, or the
    // parent's removal promotes it to a root on the way past.
    const order = deleteSet(tree, ["child", "epic"]);
    expect(order.indexOf("grandchild")).toBeLessThan(order.indexOf("child"));
    expect(order.indexOf("child")).toBeLessThan(order.indexOf("epic"));
  });

  it("deduplicates an overlapping request", () => {
    expect(deleteSet(tree, ["epic", "child", "grandchild"])).toHaveLength(3);
  });

  it("leaves out ids the list does not have", () => {
    expect(deleteSet(tree, ["ghost"])).toEqual([]);
    expect(deleteSet(tree, ["other"])).toEqual(["other"]);
  });

  it("survives a parent cycle rather than hanging", () => {
    const cyclic = [task("a", "b"), task("b", "a")];
    expect(deleteSet(cyclic, ["a"]).length).toBeGreaterThan(0);
  });
});

describe("deleteConfirmation", () => {
  it("names the Task and declares the subtree coming with it", () => {
    const { title, body } = deleteConfirmation(
      tree,
      ["epic"],
      deleteSet(tree, ["epic"]),
    );
    expect(title).toContain("Task epic");
    expect(body).toContain("cannot be undone");
    // The count is the POINT: agreeing to delete one row is not agreeing to
    // delete three, and this is the last moment it can be declined.
    expect(body).toContain("2 subtasks");
  });

  it("says subtask in the singular", () => {
    const targets = ["child"];
    const body = deleteConfirmation(
      tree,
      targets,
      deleteSet(tree, targets),
    ).body;
    expect(body).toContain("1 subtask.");
    expect(body).not.toContain("subtasks");
  });

  it("says nothing about subtasks when there are none", () => {
    const body = deleteConfirmation(tree, ["other"], ["other"]).body;
    expect(body).toBe("This cannot be undone.");
  });

  it("counts Tasks when several were asked for", () => {
    const { title } = deleteConfirmation(
      tree,
      ["other", "epic"],
      deleteSet(tree, ["other", "epic"]),
    );
    expect(title).toBe("Delete 2 Tasks?");
  });
});
