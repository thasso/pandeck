/**
 * Unit test for the additive SQLite task foundation (Branch B). Run through the
 * server Vitest suite:
 *   pnpm --filter @assistant/server test src/db/taskStore.test.ts
 *
 * Roots the data dir at an isolated temp dir, then exercises the tasks store,
 * the generic links graph, and per-type id sequences.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "task-store-test-"));
process.env.ASSISTANT_CWD = tmp;

const { taskStore } = await import("./taskStore.ts");
const { addLink, outgoing } = await import("./links.ts");
const { closeDb } = await import("./index.ts");

test("SQLite task foundation: tasks, links, sequences", async () => {
  /* --------------------------- create + sequences ------------------------- */
  const t1 = taskStore.create({ title: "First", createdBy: "user" });
  const t2 = taskStore.create({
    title: "Second",
    priority: "high",
    description: "body two",
  });
  assert.equal(t1.id, 1, "first task id is 1 (per-type sequence)");
  assert.equal(t2.id, 2, "second task id is 2 (contiguous +1)");
  assert.equal(taskStore.displayId(t1.id), "Task-1", "display id");
  assert.equal(t1.status, "todo");
  assert.equal(t2.priority, "high");

  /* -------------------------------- update -------------------------------- */
  const done = taskStore.setStatus(t1.id, "done")!;
  assert.equal(done.status, "done");
  assert.ok(done.completedAt, "completedAt set on done");
  const reopened = taskStore.setStatus(t1.id, "todo")!;
  assert.equal(
    reopened.completedAt,
    undefined,
    "completedAt cleared when leaving done",
  );
  const renamed = taskStore.update(t1.id, {
    title: "First!",
    dueDate: "2026-07-10",
  })!;
  assert.equal(renamed.title, "First!");
  assert.equal(renamed.dueDate, "2026-07-10");
  taskStore.update(t1.id, { dueDate: null });
  assert.equal(
    taskStore.get(t1.id)!.dueDate,
    undefined,
    "dueDate cleared with null",
  );

  /* -------------------------------- search -------------------------------- */
  assert.deepEqual(
    taskStore.search("body two").map((t) => t.id),
    [t2.id],
    "search matches description",
  );
  assert.equal(taskStore.list().length, 2, "list returns both");

  /* ------------------------------- archive -------------------------------- */
  taskStore.setArchived(t2.id, true);
  assert.equal(taskStore.list().length, 1, "archived hidden by default");
  assert.equal(
    taskStore.list({ includeArchived: true }).length,
    2,
    "archived included on request",
  );
  taskStore.setArchived(t2.id, false);

  /* ------------------------------ hierarchy ------------------------------- */
  const parent = taskStore.create({ title: "Parent" });
  const childA = taskStore.create({ title: "Child A" });
  const childB = taskStore.create({ title: "Child B" });
  taskStore.setParent(childA.id, parent.id);
  taskStore.setParent(childB.id, parent.id);
  assert.deepEqual(
    taskStore.children(parent.id).map((t) => t.id),
    [childA.id, childB.id],
    "children ordered by insertion",
  );
  assert.equal(taskStore.parentOf(childA.id), parent.id, "parentOf");
  // Single parent: re-parent childA under childB.
  taskStore.setParent(childA.id, childB.id);
  assert.equal(
    taskStore.parentOf(childA.id),
    childB.id,
    "re-parent replaces the single parent edge",
  );
  assert.deepEqual(
    taskStore.children(parent.id).map((t) => t.id),
    [childB.id],
    "old parent no longer lists childA",
  );
  // Cycle rejection: parent cannot become a child of its descendant.
  assert.throws(
    () => taskStore.setParent(parent.id, childA.id),
    /cycle/i,
    "cycle rejected",
  );
  assert.throws(
    () => taskStore.setParent(parent.id, parent.id),
    /own parent/i,
    "self-parent rejected",
  );

  /* ------------------------------ relations ------------------------------- */
  taskStore.setProject(t1.id, "acme");
  assert.equal(taskStore.projectOf(t1.id), "acme", "project set");
  taskStore.setProject(t1.id, "other");
  assert.equal(taskStore.projectOf(t1.id), "other", "single project replaced");
  taskStore.setProject(t1.id, null);
  assert.equal(taskStore.projectOf(t1.id), undefined, "project cleared");

  taskStore.linkSession(t1.id, "sess-uuid-1");
  assert.deepEqual(
    taskStore.sessionsFor(t1.id),
    ["sess-uuid-1"],
    "session context edge",
  );

  taskStore.setJira(t1.id, ["APP-7", "OPS-3"]);
  assert.deepEqual(
    taskStore.jiraFor(t1.id).sort(),
    ["APP-7", "OPS-3"],
    "jira links",
  );

  taskStore.addUrl(t1.id, "https://example.com/x", "related");
  assert.deepEqual(
    taskStore.urlsFor(t1.id),
    [{ url: "https://example.com/x", kind: "related" }],
    "url link + metadata",
  );

  /* -------------------- project follows the parent ------------------------ */
  const epic = taskStore.create({ title: "Epic" });
  const sub = taskStore.create({ title: "Sub" });
  const leaf = taskStore.create({ title: "Leaf" });
  taskStore.setParent(leaf.id, sub.id);
  taskStore.setProject(epic.id, "acme");
  // A move under a parent that has a project pulls the node AND its subtree in.
  taskStore.setParent(sub.id, epic.id);
  assert.equal(taskStore.projectOf(sub.id), "acme", "moved node inherits");
  assert.equal(taskStore.projectOf(leaf.id), "acme", "so does its subtree");
  // Assigning cascades down, never up.
  taskStore.setProject(epic.id, "other");
  assert.equal(taskStore.projectOf(leaf.id), "other", "assign cascades down");
  taskStore.setProject(leaf.id, "acme");
  assert.equal(taskStore.projectOf(epic.id), "other", "no upward cascade");
  // Clearing is local, and re-stating the same parent is not a move.
  taskStore.setProject(sub.id, null);
  taskStore.setParent(sub.id, epic.id);
  assert.equal(
    taskStore.projectOf(sub.id),
    undefined,
    "a deliberate unset survives a save that changes no parent",
  );
  // …but an assignment on the epic re-fills it, even one re-stating the project
  // the epic already has: the cascade must not stop at an already-correct node.
  taskStore.setProject(epic.id, "other");
  assert.equal(
    taskStore.projectOf(sub.id),
    "other",
    "an ancestor assignment re-fills a cleared child",
  );
  // Reparenting to the root leaves the project alone: do not destroy it.
  taskStore.setProject(sub.id, "acme");
  taskStore.setParent(sub.id, null);
  assert.equal(taskStore.projectOf(sub.id), "acme", "root move keeps it");

  // A cycle cannot be built through `setParent`, but stored data may already
  // hold one (the ancestor walk breaks out of it rather than throwing), so the
  // cascade terminates on one instead of blowing the stack.
  const loopA = taskStore.create({ title: "Loop A" });
  const loopB = taskStore.create({ title: "Loop B" });
  addLink(
    { type: "task", id: String(loopA.id) },
    "subtask",
    { type: "task", id: String(loopB.id) },
    { position: 0 },
  );
  addLink(
    { type: "task", id: String(loopB.id) },
    "subtask",
    { type: "task", id: String(loopA.id) },
    { position: 0 },
  );
  taskStore.setProject(loopA.id, "acme");
  assert.equal(taskStore.projectOf(loopB.id), "acme", "cascade terminates");
  taskStore.remove(loopA.id);
  taskStore.remove(loopB.id);

  /* --------------------------- remove + cleanup --------------------------- */
  taskStore.remove(t1.id);
  assert.equal(taskStore.get(t1.id), undefined, "removed task gone");
  assert.equal(
    outgoing({ type: "task", id: String(t1.id) }).length,
    0,
    "removed task edges cleaned up",
  );

  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});
