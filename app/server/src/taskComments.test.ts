/**
 * Task activity-trace comments (Task 116): store ordering + counts, domain add,
 * delete cleanup, archive-keeps-comments, and the authoritative broadcast +
 * commentCount refresh. Isolated to a temp data dir.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import type { ServerMessage } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "task-comments-test-"));
process.env.ASSISTANT_CWD = tmp;

const { createTask, deleteTask, archiveTask, listTasks } =
  await import("./tasks.ts");
const { addTaskComment, listTaskComments } = await import("./taskComments.ts");
const { taskCommentStore } = await import("./db/taskCommentStore.ts");
const { hub } = await import("./hub.ts");
const { closeDb } = await import("./db/index.ts");

/** The task-list broadcast is coalesced (see `hub.flushTaskBroadcast`); end its window. */
const settled = () => hub.flushPendingBroadcastsForTests();

test("Task comments: append-only trace, counts, broadcast, and lifecycle cleanup", async () => {
  const messages: ServerMessage[] = [];
  // Subscribed to the Task list (the badge counts ride on it) but holding no
  // Task's trace.
  const viewer = {
    send: (message: ServerMessage) => messages.push(message),
    wantsTopic: (topic: string) => topic === "tasks",
  };
  hub.register(viewer);
  try {
    const task = createTask({
      title: "Activity trace task",
      source: { createdBy: "user" },
    });
    const other = createTask({
      title: "Untouched task",
      source: { createdBy: "user" },
    });

    /* --------------------------- add + ordering ---------------------------- */
    const first = addTaskComment({
      taskId: task.id,
      authorKind: "user",
      authorName: "Alice",
      body: "first",
    });
    const second = addTaskComment({
      taskId: task.id,
      authorKind: "agent",
      authorName: "Assistant",
      authorSessionId: "sess-1",
      body: "second",
    });
    const list = listTaskComments(task.id);
    assert.deepEqual(
      list.map((c) => c.body),
      ["first", "second"],
      "chronological, oldest first",
    );
    assert.equal(list[0]!.id, first.id);
    assert.equal(list[1]!.author.kind, "agent");
    assert.equal(
      list[1]!.author.sessionId,
      "sess-1",
      "agent session id retained",
    );
    assert.equal(second.taskId, task.id);

    /* ------------------------------- counts -------------------------------- */
    const summaries = listTasks();
    assert.equal(
      summaries.find((t) => t.id === task.id)?.commentCount,
      2,
      "commentCount reflects the trace",
    );
    assert.equal(
      summaries.find((t) => t.id === other.id)?.commentCount,
      undefined,
      "no count key when empty",
    );

    /* ----------------------------- broadcast ------------------------------- */
    // A trace reaches only the viewers holding that Task. This one holds none,
    // so it must see the list refresh (badges are everyone's) and no comments.
    assert.equal(
      messages.some((m) => m.type === "commentEvents"),
      false,
      "a viewer without the Task open gets no trace",
    );
    await settled();
    const batch = [...messages].reverse().find((m) => m.type === "stateEvents");
    assert.ok(
      batch && batch.type === "stateEvents" && batch.topic === "tasks",
      "adding a comment reports the Task through the change seam for badges",
    );
    const upsert = batch.events.find(
      (event) => event.kind === "upsert" && event.id === task.id,
    );
    assert.ok(upsert?.kind === "upsert");
    assert.equal(
      upsert.item.commentCount,
      2,
      "the event carries the refreshed badge count",
    );

    const holderMessages: ServerMessage[] = [];
    const holder = {
      send: (message: ServerMessage) => holderMessages.push(message),
      wantsComments: (target: import("@assistant/shared").CommentTarget) =>
        target.kind === "task" && target.taskId === task.id,
    };
    hub.register(holder);
    try {
      addTaskComment({
        taskId: task.id,
        authorKind: "user",
        authorName: "Alice",
        body: "third",
      });
      // Comment events travel their own per-target queue, not a broadcast
      // window, so wait for this one to arrive.
      await vi.waitFor(
        () => assert.ok(holderMessages.some((m) => m.type === "commentEvents")),
        { interval: 5 },
      );
      const delivered = [...holderMessages]
        .reverse()
        .find((m) => m.type === "commentEvents");
      assert.ok(delivered && delivered.type === "commentEvents");
      assert.equal(delivered.target.kind, "task");
      assert.deepEqual(
        delivered.events.map((event) =>
          event.kind === "upsert" ? event.item.root.body : "deleted",
        ),
        ["third"],
      );

      addTaskComment({
        taskId: other.id,
        authorKind: "user",
        authorName: "Alice",
        body: "elsewhere",
      });
      assert.equal(
        holderMessages.filter(
          (m) =>
            m.type === "commentEvents" &&
            m.target.kind === "task" &&
            m.target.taskId === other.id,
        ).length,
        0,
        "a Task this viewer does not hold is never pushed to it",
      );
    } finally {
      hub.unregister(holder);
    }

    /* --------------------------- validation -------------------------------- */
    assert.throws(
      () =>
        addTaskComment({
          taskId: task.id,
          authorKind: "user",
          authorName: "Alice",
          body: "   ",
        }),
      /empty/i,
    );
    assert.throws(
      () =>
        addTaskComment({
          taskId: "999999",
          authorKind: "user",
          authorName: "Alice",
          body: "x",
        }),
      /not found/i,
    );

    /* ------------------------ archive keeps comments ----------------------- */
    archiveTask(task.id);
    // first + second + the "third" the targeted-delivery check above appended.
    assert.equal(
      taskCommentStore.listForTask(Number(task.id)).length,
      3,
      "archiving keeps the trace",
    );

    /* -------------------------- delete cleans up --------------------------- */
    deleteTask(task.id);
    assert.equal(
      taskCommentStore.listForTask(Number(task.id)).length,
      0,
      "permanent delete removes the trace",
    );
    deleteTask(other.id);
  } finally {
    hub.unregister(viewer);
    closeDb();
    rmSync(tmp, { recursive: true, force: true });
  }
});
