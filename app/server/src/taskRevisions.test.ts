/**
 * Notify-with-ids IS the revision bump (docs/state-sync.md).
 *
 * Every public write of the Task domain — plus the comment write that changes a
 * list badge — must report the rows it touched, because an unreported row is
 * one whose viewers never hear about the change. The coverage guard at the end
 * is the part that survives new code: a newly exported write fails this test
 * until it is exercised here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  archiveTask,
  createTask,
  deleteTask,
  linkSessionToTask,
  markTaskProcessed,
  notifyTaskChange,
  readTask,
  reorderTasks,
  sweepCompletedTaskArchive,
  taskRevisionIndex,
  unarchiveTask,
  unlinkSessionEverywhere,
  updateTask,
  TASK_AUTO_ARCHIVE_AFTER_MS,
} from "./tasks.ts";
import { addTaskComment } from "./taskComments.ts";
import { deleteProject, upsertProject } from "./projectRegistry.ts";

const SRC = dirname(fileURLToPath(import.meta.url));

function revisionOf(id: string): number {
  const entry = taskRevisionIndex().get(id);
  assert.ok(entry, `no revision row for Task ${id}`);
  return entry.revision;
}

/** Run `write` and assert it moved the revision of every id in `ids`. */
function movesRevisions(ids: string[], write: () => void): void {
  const before = ids.map((id) => revisionOf(id));
  write();
  ids.forEach((id, index) => {
    assert.ok(
      revisionOf(id) > before[index]!,
      `Task ${id} was written without reporting its id through notify()`,
    );
  });
}

function discard(...ids: string[]): void {
  for (const id of ids) {
    try {
      deleteTask(id);
    } catch {
      /* already gone */
    }
  }
}

test("every Task write reports the rows it touched", () => {
  const task = createTask({
    title: "Revision subject",
    source: { createdBy: "user" },
  });
  const epic = createTask({
    title: "Revision epic",
    source: { createdBy: "user" },
  });
  const child = createTask({
    title: "Revision child",
    parentId: epic.id,
    source: { createdBy: "user" },
  });
  // An arrival: `markTaskProcessed` only writes an untriaged Task.
  const arrival = createTask({
    title: "Revision arrival",
    source: { createdBy: "agent" },
  });

  try {
    // A create stamps the new row above the zero every pre-existing row was
    // backfilled with, or its first event would be discarded as stale.
    assert.ok(revisionOf(task.id) > 0);

    movesRevisions([task.id], () =>
      updateTask(task.id, { title: "Renamed", actor: { kind: "user" } }),
    );
    movesRevisions([task.id], () => archiveTask(task.id));
    movesRevisions([task.id], () => unarchiveTask(task.id));
    movesRevisions([task.id], () =>
      linkSessionToTask(task.id, { sessionId: "sess-revision" }),
    );
    movesRevisions([task.id], () => unlinkSessionEverywhere("sess-revision"));
    movesRevisions([epic.id, task.id], () =>
      reorderTasks(
        [epic.id, task.id],
        [
          { id: epic.id, parentId: null },
          { id: task.id, parentId: epic.id },
        ],
        true,
      ),
    );
    movesRevisions([task.id], () =>
      addTaskComment({
        taskId: task.id,
        authorKind: "user",
        authorName: "Alice",
        body: "trace",
      }),
    );
    movesRevisions([task.id], () => notifyTaskChange([task.id]));
    movesRevisions([arrival.id], () => markTaskProcessed(arrival.id));

    // A project assignment CASCADES down the subtree: the child's row moved as
    // much as the parent's, and reporting only the named id would leave every
    // open Backlog showing the child in its old project.
    movesRevisions([epic.id, child.id], () =>
      updateTask(epic.id, { projectId: "revision-project" }),
    );

    movesRevisions([task.id], () => deleteTask(task.id));
    assert.equal(
      taskRevisionIndex().get(task.id)?.live,
      false,
      "a deleted Task leaves the live projection but keeps a revision to delete with",
    );
  } finally {
    discard(task.id, child.id, epic.id, arrival.id);
  }
});

test("deleting a parent reports the children it orphans", () => {
  const epic = createTask({
    title: "Deleted epic",
    source: { createdBy: "user" },
  });
  const child = createTask({
    title: "Orphaned child",
    parentId: epic.id,
    source: { createdBy: "user" },
  });
  try {
    assert.equal(readTask(child.id)?.parentId, epic.id);
    // The delete drops the parent's `subtask` edges, so the child becomes a
    // root. Unreported, it would keep a `parentId` naming a Task that no longer
    // exists, and the next Backlog drag would send that dead id back as a
    // placement — which `reorderTasks` refuses, failing the whole reorder.
    movesRevisions([child.id], () => deleteTask(epic.id));
    assert.equal(readTask(child.id)?.parentId, undefined);
  } finally {
    discard(child.id, epic.id);
  }
});

test("deleting a Project reports the Tasks it orphans", () => {
  const task = createTask({
    title: "Task in a doomed project",
    projectId: "revision-doomed",
    source: { createdBy: "user" },
  });
  upsertProject({ id: "revision-doomed", name: "Doomed", key: "RVDM" });
  try {
    assert.equal(readTask(task.id)?.projectId, "revision-doomed");
    // Deleting the Project sweeps its `in_project` edges, which is a write to
    // every Task in it. Nothing else repairs those rows any more: the Backlog
    // would show a project chip for a Project that is gone until a resubscribe.
    movesRevisions([task.id], () => deleteProject("revision-doomed"));
    assert.equal(readTask(task.id)?.projectId, undefined);
  } finally {
    discard(task.id);
  }
});

test("the retention sweep archives through the same seam", () => {
  const done = createTask({
    title: "Swept Task",
    status: "done",
    source: { createdBy: "user" },
  });
  try {
    const before = revisionOf(done.id);
    const swept = sweepCompletedTaskArchive(
      Date.now() + TASK_AUTO_ARCHIVE_AFTER_MS + 1,
    );
    assert.ok(swept.includes(done.id), "the aged Task was swept");
    assert.ok(
      revisionOf(done.id) > before,
      "the sweep's archive reported its id like any other write",
    );
    assert.equal(
      taskRevisionIndex().get(done.id)?.live,
      false,
      "an archived Task leaves the live projection, which is a delete event",
    );
  } finally {
    discard(done.id);
  }
});

test("every exported Task write is covered by the revision test", () => {
  const source = readFileSync(join(SRC, "tasks.ts"), "utf8");
  const exported = [...source.matchAll(/^export function (\w+)/gm)].map(
    (match) => match[1]!,
  );
  // Reads, projections and lifecycle control: they write no Task row, so they
  // have nothing to report.
  const readsOnly = new Set([
    "listTasks",
    "readTask",
    "listSessionTasks",
    "listRelatedGlobalTasks",
    "findOriginTask",
    "subscribeTaskChanges",
    "taskIndexVersion",
    "taskRevisionIndex",
    "taskRevisionDigest",
    "taskStateItems",
    "taskSummaryFor",
    "taskLinkedSessionIds",
    "shiftLocalDateKey",
    "startTaskAutoArchiveSweep",
    "stopTaskAutoArchiveSweep",
  ]);
  const covered = new Set([
    "createTask",
    "updateTask",
    "archiveTask",
    "unarchiveTask",
    "deleteTask",
    "linkSessionToTask",
    "unlinkSessionEverywhere",
    "reorderTasks",
    "markTaskProcessed",
    "notifyTaskChange",
    "sweepCompletedTaskArchive",
  ]);
  const uncovered = exported.filter(
    (name) => !readsOnly.has(name) && !covered.has(name),
  );
  assert.deepEqual(
    uncovered,
    [],
    "a new Task write must prove it reports its touched ids (exercise it above)",
  );
});
