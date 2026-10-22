/**
 * The `tasks` topic broadcast: a mutation travels as a `stateEvents` batch of
 * the touched rows (docs/state-sync.md), never as a list snapshot, and only to
 * the connections showing that topic.
 */
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { ServerMessage, StateEvent, TaskSummary } from "@assistant/shared";
import { harnessRegistry } from "./harnesses/registry.ts";
import { hub } from "./hub.ts";
import {
  archiveTask,
  createTask,
  deleteTask,
  linkSessionToTask,
  readTask,
  taskRevision,
  unarchiveTask,
  unlinkSessionEverywhere,
  updateTask,
} from "./tasks.ts";

/** The `tasks` kernel coalesces its flush (`stateTopicKernel.ts`), so a test ends its window. */
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
    // A flush carries only what was written, never the whole live projection:
    // the kernel publishes the ids the write reported.
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

test("a blocker's status change re-broadcasts the Task it blocks with its new count", async () => {
  const messages: ServerMessage[] = [];
  const viewer = {
    send: (message: ServerMessage) => messages.push(message),
    wantsTopic: (topic: string) => topic === "tasks",
  };
  const blocker = createTask({
    title: "Count blocker",
    source: { createdBy: "user" },
  });
  const blocked = createTask({
    title: "Count blocked",
    source: { createdBy: "user" },
  });
  updateTask(blocked.id, {
    addLinks: [{ type: "blocked-by", taskId: blocker.id }],
  });
  await settled();
  hub.register(viewer);
  try {
    const summaryOf = (id: string): TaskSummary | undefined => {
      const event = lastBatch(messages).events.find((e) => e.id === id);
      return event?.kind === "upsert" ? event.item : undefined;
    };

    updateTask(blocker.id, { status: "done", actor: { kind: "user" } });
    await settled();
    assert.deepEqual(
      lastBatch(messages)
        .events.map((event) => event.id)
        .sort(),
      [blocker.id, blocked.id].sort(),
    );
    const unblocked = summaryOf(blocked.id);
    assert.ok(unblocked, "the blocked Task is re-sent");
    assert.equal(unblocked.openBlockerCount, undefined);

    updateTask(blocker.id, { status: "todo", actor: { kind: "user" } });
    await settled();
    assert.equal(summaryOf(blocked.id)?.openBlockerCount, 1);

    // A field no linked Task shows reaches no linked Task.
    updateTask(blocker.id, { description: "Only the body" });
    await settled();
    assert.equal(
      lastBatch(messages).events.some((event) => event.id === blocked.id),
      false,
    );

    // Archiving the blocker leaves the projection (a delete) and un-blocks.
    archiveTask(blocker.id);
    await settled();
    const archived = lastBatch(messages);
    assert.equal(
      archived.events.find((event) => event.id === blocker.id)?.kind,
      "delete",
    );
    const released = summaryOf(blocked.id);
    assert.ok(released && !("openBlockerCount" in released));
  } finally {
    hub.unregister(viewer);
    for (const task of [blocker, blocked]) {
      try {
        deleteTask(task.id);
      } catch {
        /* already gone */
      }
    }
  }
});

test("an already-archived Task hears its linked Tasks change, without rejoining the list", async () => {
  const messages: ServerMessage[] = [];
  const viewer = {
    send: (message: ServerMessage) => messages.push(message),
    wantsTopic: (topic: string) => topic === "tasks",
  };
  const shelved = createTask({
    title: "Archived and blocked",
    source: { createdBy: "user" },
  });
  const blocker = createTask({
    title: "Live blocker",
    source: { createdBy: "user" },
  });
  updateTask(shelved.id, {
    addLinks: [{ type: "blocked-by", taskId: blocker.id }],
  });
  archiveTask(shelved.id);
  await settled();
  hub.register(viewer);
  try {
    /** The archived Task's event in the last batch, after `write`. */
    const shelvedEventAfter = async (write: () => void) => {
      const before = messages.length;
      write();
      await settled();
      const batch = lastBatch(messages);
      assert.ok(messages.length > before, "the write was broadcast");
      return batch.events.find((event) => event.id === shelved.id);
    };
    const revision = () => taskRevision(shelved.id)!;

    for (const [what, write] of [
      ["rename", () => updateTask(blocker.id, { title: "Blocker renamed" })],
      [
        "completion",
        () =>
          updateTask(blocker.id, { status: "done", actor: { kind: "user" } }),
      ],
      [
        "link change",
        () =>
          updateTask(blocker.id, {
            addLinks: [{ type: "relates", taskId: shelved.id }],
          }),
      ],
      ["unlink", () => updateTask(blocker.id, { removeLinks: [shelved.id] })],
    ] as const) {
      const event = await shelvedEventAfter(write);
      assert.ok(event, `${what}: the archived Task is reported`);
      // A delete: it stays out of every list, and its revision is the one an
      // open body of it compares against.
      assert.equal(event.kind, "delete", what);
      assert.equal(event.revision, revision(), what);
    }
    assert.equal(
      messages.some(
        (m) =>
          m.type === "stateEvents" &&
          m.events.some((e) => e.id === shelved.id && e.kind === "upsert"),
      ),
      false,
      "the archived Task never comes back as a list row",
    );
    assert.equal(readTask(shelved.id)?.links, undefined);
  } finally {
    hub.unregister(viewer);
    for (const task of [shelved, blocker]) {
      try {
        deleteTask(task.id);
      } catch {
        /* already gone */
      }
    }
  }
});

test("a Task flush refreshes the state of the sessions linked to a Task, and of one just unlinked", async () => {
  await settled();
  const fake = (sessionId: string) => ({
    sessionId,
    broadcastState: vi.fn(),
  });
  const linked = fake(`refresh-linked-${Date.now()}`);
  const other = fake(`refresh-other-${Date.now()}`);
  const resident = vi
    .spyOn(harnessRegistry, "resident")
    .mockReturnValue([linked, other] as never);
  const task = createTask({
    title: "Session refresh",
    source: { createdBy: "user" },
  });
  try {
    await settled();
    linked.broadcastState.mockClear();
    other.broadcastState.mockClear();

    linkSessionToTask(task.id, { sessionId: linked.sessionId });
    assert.equal(linked.broadcastState.mock.calls.length, 0, "not before");
    assert.equal(other.broadcastState.mock.calls.length, 0, "not before");
    await settled();
    assert.equal(linked.broadcastState.mock.calls.length, 1);
    assert.equal(other.broadcastState.mock.calls.length, 0);

    // Its last link gone, the session still shows it until one more refresh.
    unlinkSessionEverywhere(linked.sessionId);
    await settled();
    assert.equal(linked.broadcastState.mock.calls.length, 2);
    assert.equal(other.broadcastState.mock.calls.length, 0);
  } finally {
    resident.mockRestore();
    deleteTask(task.id);
  }
});
