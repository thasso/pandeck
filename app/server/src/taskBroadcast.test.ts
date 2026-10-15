/**
 * The `tasks` topic broadcast: a mutation travels as a `stateEvents` batch of
 * the touched rows (docs/state-sync.md), never as a list snapshot, and only to
 * the connections showing that topic.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { ServerMessage, StateEvent, TaskSummary } from "@assistant/shared";
import { hub } from "./hub.ts";
import {
  archiveTask,
  createTask,
  deleteTask,
  unarchiveTask,
  updateTask,
} from "./tasks.ts";

/** The task broadcast is coalesced (see `hub.flushTaskBroadcast`), so a test ends its window. */
const settled = () => hub.flushPendingBroadcastsForTests();

function lastBatch(messages: ServerMessage[]): {
  seq: number;
  events: StateEvent<TaskSummary>[];
} {
  const batch = [...messages].reverse().find((m) => m.type === "stateEvents");
  assert.ok(batch && batch.type === "stateEvents", "expected a state batch");
  return { seq: batch.seq, events: batch.events as StateEvent<TaskSummary>[] };
}

test("Task mutations reach topic subscribers as state events, never as a list", async () => {
  const messages: ServerMessage[] = [];
  const viewer = {
    send: (message: ServerMessage) => messages.push(message),
    wantsTopic: (topic: string) => topic === "tasks",
  };
  // A connection that is not showing a Backlog surface subscribes to nothing,
  // and must therefore receive none of this traffic.
  const unsubscribed: ServerMessage[] = [];
  const quiet = {
    send: (message: ServerMessage) => unsubscribed.push(message),
  };
  hub.register(viewer);
  hub.register(quiet);
  try {
    const created = createTask({
      title: "Broadcast Task regression",
      status: "todo",
      source: { createdBy: "user" },
    });
    await settled();

    const create = lastBatch(messages);
    // The FIRST flush of a process carries only what was written, never the
    // whole live projection: subscribers hold a snapshot read from this same
    // database (see `seedTaskBaseline`).
    assert.deepEqual(
      create.events.map((event) => event.id),
      [created.id],
    );
    const upsert = create.events.find((event) => event.id === created.id);
    assert.ok(upsert?.kind === "upsert", "a new Task arrives as an upsert");
    assert.ok(upsert.revision > 0, "the event carries the row's revision");
    // Summaries only: bodies are fetched per Task on demand, never broadcast.
    assert.ok(!("description" in upsert.item));
    // The revision is envelope metadata; putting it on the object would make
    // every optimistic row differ from its echo.
    assert.ok(!("revision" in upsert.item));
    assert.equal(
      messages.some((message) => message.type === "taskList"),
      false,
      "a mutation never broadcasts a full list",
    );

    // Membership in the live projection is what events describe.
    archiveTask(created.id);
    await settled();
    const archived = lastBatch(messages);
    assert.equal(
      archived.events.find((event) => event.id === created.id)?.kind,
      "delete",
      "archiving leaves the live projection, so it is a delete",
    );
    assert.equal(archived.seq, create.seq + 1, "each batch advances the seq");

    unarchiveTask(created.id);
    await settled();
    assert.equal(
      lastBatch(messages).events.find((event) => event.id === created.id)?.kind,
      "upsert",
      "unarchiving re-enters the projection, so it is an upsert",
    );

    deleteTask(created.id);
    await settled();
    assert.equal(
      lastBatch(messages).events.find((event) => event.id === created.id)?.kind,
      "delete",
    );

    assert.equal(
      unsubscribed.length,
      0,
      "an unsubscribed connection receives no Task traffic at all",
    );
  } finally {
    hub.unregister(viewer);
    hub.unregister(quiet);
  }
});

test("one flush carries only the rows that changed", async () => {
  const messages: ServerMessage[] = [];
  const viewer = {
    send: (message: ServerMessage) => messages.push(message),
    wantsTopic: (topic: string) => topic === "tasks",
  };
  const untouched = createTask({
    title: "Stays put",
    source: { createdBy: "user" },
  });
  const moved = createTask({
    title: "Gets toggled",
    source: { createdBy: "user" },
  });
  await settled();
  hub.register(viewer);
  try {
    updateTask(moved.id, { status: "doing", actor: { kind: "user" } });
    await settled();
    const batch = lastBatch(messages);
    assert.deepEqual(
      batch.events.map((event) => event.id),
      [moved.id],
      "a status toggle is one row, not the whole list",
    );
    assert.ok(
      JSON.stringify(batch).length < 4_000,
      "the broadcast stays a small event batch",
    );
  } finally {
    hub.unregister(viewer);
    deleteTask(untouched.id);
    deleteTask(moved.id);
  }
});

test("a link change broadcasts both of its Tasks, and so does deleting one", async () => {
  const messages: ServerMessage[] = [];
  const viewer = {
    send: (message: ServerMessage) => messages.push(message),
    wantsTopic: (topic: string) => topic === "tasks",
  };
  const blocker = createTask({
    title: "Broadcast blocker",
    source: { createdBy: "user" },
  });
  const blocked = createTask({
    title: "Broadcast blocked",
    source: { createdBy: "user" },
  });
  const bystander = createTask({
    title: "Broadcast bystander",
    source: { createdBy: "user" },
  });
  await settled();
  hub.register(viewer);
  try {
    updateTask(blocked.id, {
      addLinks: [{ type: "blocked-by", taskId: blocker.id }],
    });
    await settled();
    const link = lastBatch(messages);
    assert.deepEqual(
      link.events.map((event) => [event.id, event.kind]).sort(),
      [
        [blocker.id, "upsert"],
        [blocked.id, "upsert"],
      ].sort(),
      "both ends of the link, and nothing else",
    );
    for (const event of link.events)
      assert.ok(
        event.kind === "upsert" && !("links" in event.item),
        "links stay detail-only; the summary does not carry them",
      );

    deleteTask(blocker.id);
    await settled();
    const removal = lastBatch(messages);
    assert.deepEqual(
      removal.events.map((event) => [event.id, event.kind]).sort(),
      [
        [blocker.id, "delete"],
        [blocked.id, "upsert"],
      ].sort(),
      "the survivor lost a link, so its viewers hear about it",
    );
    assert.equal(
      removal.events.some((event) => event.id === bystander.id),
      false,
    );
  } finally {
    hub.unregister(viewer);
    for (const task of [blocker, blocked, bystander]) {
      try {
        deleteTask(task.id);
      } catch {
        /* already gone */
      }
    }
  }
});
