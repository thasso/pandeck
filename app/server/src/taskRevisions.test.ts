/**
 * Notify-with-ids IS the revision bump (docs/state-sync.md).
 *
 * Every public write of the Task domain must report the rows it touched,
 * because an unreported row is one whose viewers never hear about the change. The coverage guard at the end
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
  subscribeTaskChanges,
  sweepCompletedTaskArchive,
  taskRevisionIndex,
  unarchiveTask,
  unlinkSessionEverywhere,
  updateTask,
  TASK_AUTO_ARCHIVE_AFTER_MS,
} from "./tasks.ts";
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

test("a Task link write reports BOTH of its Tasks", () => {
  const a = createTask({ title: "Link end A", source: { createdBy: "user" } });
  const b = createTask({ title: "Link end B", source: { createdBy: "user" } });
  const c = createTask({ title: "Link end C", source: { createdBy: "user" } });
  try {
    // A link is a fact about both ends; a viewer of either one owes an event.
    movesRevisions([a.id, b.id], () =>
      updateTask(a.id, { addLinks: [{ type: "blocks", taskId: b.id }] }),
    );
    // Replacing the type, from the other end, still touches both.
    movesRevisions([a.id, b.id], () =>
      updateTask(b.id, { addLinks: [{ type: "relates", taskId: a.id }] }),
    );
    movesRevisions([a.id, b.id], () =>
      updateTask(a.id, { removeLinks: [b.id] }),
    );
    // A create with links reports the Tasks it linked to.
    let created = "";
    movesRevisions([c.id], () => {
      created = createTask({
        title: "Linked at birth",
        addLinks: [{ type: "blocked-by", taskId: c.id }],
        source: { createdBy: "agent" },
      }).id;
    });
    discard(created);
  } finally {
    discard(a.id, b.id, c.id);
  }
});

test("deleting a linked Task reports the Tasks that lose the link", () => {
  const doomed = createTask({
    title: "Deleted linked Task",
    source: { createdBy: "user" },
  });
  const blocked = createTask({
    title: "Loses its blocker",
    source: { createdBy: "user" },
  });
  const related = createTask({
    title: "Loses its relation",
    source: { createdBy: "user" },
  });
  try {
    updateTask(doomed.id, {
      addLinks: [
        { type: "blocks", taskId: blocked.id },
        { type: "relates", taskId: related.id },
      ],
    });
    movesRevisions([doomed.id, blocked.id, related.id], () =>
      deleteTask(doomed.id),
    );
    assert.equal(readTask(blocked.id)?.links, undefined);
    assert.equal(readTask(related.id)?.links, undefined);
  } finally {
    discard(doomed.id, blocked.id, related.id);
  }
});

/**
 * Run `write` and return the id sets it notified, one entry per notification.
 */
function heardDuring(write: () => void): string[][] {
  const heard: string[][] = [];
  const unsubscribe = subscribeTaskChanges((ids) => heard.push([...ids]));
  try {
    write();
  } finally {
    unsubscribe();
  }
  return heard;
}

test("a status, title or archive change reports every linked Task once", () => {
  const subject = createTask({
    title: "Neighbour subject",
    source: { createdBy: "user" },
  });
  const blocks = createTask({
    title: "Waits on the subject",
    source: { createdBy: "user" },
  });
  const blocker = createTask({
    title: "The subject waits on it",
    source: { createdBy: "user" },
  });
  const related = createTask({
    title: "Related to the subject",
    source: { createdBy: "user" },
  });
  const bystander = createTask({
    title: "Not linked",
    source: { createdBy: "user" },
  });
  try {
    updateTask(subject.id, {
      addLinks: [
        { type: "blocks", taskId: blocks.id },
        { type: "blocked-by", taskId: blocker.id },
        { type: "relates", taskId: related.id },
      ],
    });
    const everyone = [subject.id, blocks.id, blocker.id, related.id].sort();
    const writes: Array<[string, () => void]> = [
      [
        "status",
        () =>
          updateTask(subject.id, { status: "done", actor: { kind: "user" } }),
      ],
      ["title", () => updateTask(subject.id, { title: "Neighbour renamed" })],
      ["archive", () => archiveTask(subject.id)],
      ["unarchive", () => unarchiveTask(subject.id)],
      [
        "several fields at once",
        () =>
          updateTask(subject.id, {
            title: "Neighbour renamed again",
            status: "todo",
            description: "and a body",
            actor: { kind: "user" },
          }),
      ],
    ];
    for (const [what, write] of writes) {
      let heard: string[][] = [];
      movesRevisions(everyone, () => {
        heard = heardDuring(write);
      });
      assert.equal(heard.length, 1, `${what}: one notification per write`);
      assert.deepEqual(
        [...heard[0]!].sort(),
        everyone,
        `${what}: the subject and each linked Task, each exactly once`,
      );
    }
    // The blocker's own status change reaches the subject it holds up, which
    // is what moves the subject's open-blocker count in the list.
    assert.deepEqual(
      heardDuring(() =>
        updateTask(blocker.id, { status: "done", actor: { kind: "user" } }),
      ).map((ids) => [...ids].sort()),
      [[blocker.id, subject.id].sort()],
    );
    assert.equal(
      heardDuring(() => updateTask(bystander.id, { title: "Still alone" }))
        .flat()
        .includes(subject.id),
      false,
    );
  } finally {
    discard(subject.id, blocks.id, blocker.id, related.id, bystander.id);
  }
});

test("a change linked Tasks cannot see reports only the Task itself", () => {
  const subject = createTask({
    title: "Quiet subject",
    source: { createdBy: "user" },
  });
  const other = createTask({
    title: "Quiet neighbour",
    source: { createdBy: "user" },
  });
  try {
    updateTask(subject.id, {
      addLinks: [{ type: "blocks", taskId: other.id }],
    });
    const writes: Array<[string, () => void]> = [
      ["description", () => updateTask(subject.id, { description: "Body" })],
      ["priority", () => updateTask(subject.id, { priority: "high" })],
      ["dates", () => updateTask(subject.id, { scheduledFor: "2026-10-20" })],
      // Saving the title it already has is not a rename.
      ["same title", () => updateTask(subject.id, { title: "Quiet subject" })],
      // A suggestOnly status write records a claim: the status does not move.
      [
        "agent suggestion",
        () =>
          updateTask(subject.id, {
            status: "done",
            actor: { kind: "agent", id: "session-1" },
            suggestOnly: true,
          }),
      ],
      // Archiving an already archived Task changes nothing either.
      ["re-unarchive", () => unarchiveTask(subject.id)],
    ];
    for (const [what, write] of writes)
      assert.deepEqual(
        heardDuring(write),
        [[subject.id]],
        `${what}: the linked Task is not told`,
      );
    assert.equal(readTask(subject.id)?.status, "todo");
  } finally {
    discard(subject.id, other.id);
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
    "openTaskBlockerCounts",
    "listSessionTasks",
    "listRelatedGlobalTasks",
    "findOriginTask",
    "subscribeTaskChanges",
    "taskIndexVersion",
    "taskRevisionIndex",
    "taskRevisionDigest",
    "taskStateItems",
    "taskSummaryFor",
    "taskRevision",
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
