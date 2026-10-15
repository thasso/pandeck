/**
 * A Task write reports the Initiatives holding the Task — as a member or below
 * one — in the same notification (docs/initiatives.md), including the ones a
 * delete or a move takes it away from, which nothing links afterwards.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type {
  InitiativeSummary,
  ServerMessage,
  StateEvent,
} from "@assistant/shared";
import { hub } from "./hub.ts";
import {
  createInitiative,
  initiativeRevisionIndex,
  readInitiative,
} from "./initiatives.ts";
import {
  archiveTask,
  createTask,
  deleteTask,
  linkSessionToTask,
  reorderTasks,
  unlinkSessionEverywhere,
  updateTask,
} from "./tasks.ts";

function task(title: string, parentId?: string): string {
  return createTask({
    title,
    source: { createdBy: "user" },
    ...(parentId ? { parentId } : {}),
  }).id;
}

function revisionOf(id: string): number {
  return initiativeRevisionIndex().get(id)?.revision ?? -1;
}

/** The Initiatives whose revision `write` moved, among `ids`. */
function bumped(ids: string[], write: () => void): string[] {
  const before = ids.map(revisionOf);
  write();
  return ids.filter((id, index) => revisionOf(id) > before[index]!);
}

test("Task status, archive, links and sessions move the holding Initiatives only", () => {
  const epic = task("Fan-out epic");
  const sub = task("Fan-out sub", epic);
  const outside = task("Fan-out outside blocker");
  const unrelated = task("Fan-out unrelated");
  const holder = String(
    createInitiative({ title: "Holder", taskIds: [epic] }).id,
  );
  const bystander = String(
    createInitiative({ title: "Bystander", taskIds: [unrelated] }).id,
  );
  const both = [holder, bystander];

  assert.deepEqual(
    bumped(both, () =>
      updateTask(sub, { status: "doing", actor: { kind: "user" } }),
    ),
    [holder],
    "a descendant's status moves the Initiative holding its ancestor",
  );
  assert.equal(readInitiative(holder)!.progress.doing, 1);

  // A link from outside reports both ends; the blocked member's holder moves.
  assert.deepEqual(
    bumped(both, () =>
      updateTask(epic, { addLinks: [{ type: "blocked-by", taskId: outside }] }),
    ),
    [holder],
  );
  assert.equal(readInitiative(holder)!.progress.blocked, 1);
  // The outside blocker finishing unblocks the member: its holder moves too.
  assert.deepEqual(
    bumped(both, () =>
      updateTask(outside, { status: "done", actor: { kind: "user" } }),
    ),
    [holder],
  );
  assert.equal(readInitiative(holder)!.progress.blocked, 0);

  assert.deepEqual(
    bumped(both, () => linkSessionToTask(sub, { sessionId: "sess-fanout" })),
    [holder],
  );
  assert.deepEqual(
    bumped(both, () => unlinkSessionEverywhere("sess-fanout")),
    [holder],
  );
  assert.deepEqual(
    bumped(both, () => archiveTask(sub)),
    [holder],
  );
  assert.deepEqual(
    bumped(both, () => updateTask(task("Fan-out stranger"), { title: "x" })),
    [],
    "a Task no Initiative holds moves none",
  );
});

test("a delete notifies the Initiatives it took the Task out of", () => {
  const epic = task("Deleted epic");
  const child = task("Orphaned child", epic);
  const leaf = task("Deleted leaf", epic);
  const initiative = String(
    createInitiative({ title: "Delete", taskIds: [epic] }).id,
  );

  assert.deepEqual(
    bumped([initiative], () => deleteTask(leaf)),
    [initiative],
  );
  assert.deepEqual(
    bumped([initiative], () => deleteTask(epic)),
    [initiative],
    "deleting the member drops its edge, so the holder is read first",
  );
  const detail = readInitiative(initiative)!;
  assert.deepEqual(detail.nodes, [], "the orphaned child left with its parent");
  assert.equal(detail.progress.total, 0);
  assert.ok(child);
});

test("a move notifies the Initiative it left and the one it joined", () => {
  const fromEpic = task("Move from epic");
  const toEpic = task("Move to epic");
  const moving = task("Moving", fromEpic);
  const left = String(
    createInitiative({ title: "Left", taskIds: [fromEpic] }).id,
  );
  const joined = String(
    createInitiative({ title: "Joined", taskIds: [toEpic] }).id,
  );

  assert.deepEqual(
    bumped([left, joined], () =>
      updateTask(moving, { parentId: toEpic }),
    ).sort(),
    [left, joined].sort(),
  );
  assert.equal(readInitiative(left)!.progress.total, 1);
  assert.equal(readInitiative(joined)!.progress.total, 2);

  // The Backlog drag reparents without `updateTask`.
  assert.deepEqual(
    bumped([left, joined], () =>
      reorderTasks([moving], [{ id: moving, parentId: null }], true),
    ),
    [joined],
  );
  assert.equal(readInitiative(joined)!.progress.total, 1);
});

test("a Task write and its Initiative event leave in the same flush", async () => {
  const epic = task("Flush epic");
  const initiative = String(
    createInitiative({ title: "Flush", taskIds: [epic] }).id,
  );
  await hub.flushPendingBroadcastsForTests();
  const messages: ServerMessage[] = [];
  const viewer = {
    send: (message: ServerMessage) => messages.push(message),
    wantsTopic: (topic: string) => topic === "initiatives" || topic === "tasks",
  };
  hub.register(viewer);
  try {
    updateTask(epic, { status: "done", actor: { kind: "user" } });
    await hub.flushPendingBroadcastsForTests();
    const batch = messages.find(
      (message) =>
        message.type === "stateEvents" && message.topic === "initiatives",
    );
    assert.ok(batch?.type === "stateEvents" && batch.topic === "initiatives");
    const events = batch.events as StateEvent<InitiativeSummary>[];
    assert.deepEqual(
      events.map((event) => event.id),
      [initiative],
    );
    const upsert = events[0];
    assert.ok(upsert?.kind === "upsert");
    assert.deepEqual(upsert.item.progress, {
      total: 1,
      done: 1,
      doing: 0,
      startable: 0,
      blocked: 0,
    });
    assert.ok(
      messages.some(
        (message) =>
          message.type === "stateEvents" && message.topic === "tasks",
      ),
    );
    assert.ok(
      !messages.some((message) => message.type === "initiativeList"),
      "a mutation never travels as a list",
    );
  } finally {
    hub.unregister(viewer);
  }
});
