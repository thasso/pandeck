/**
 * Task-to-Task links: `blocks` (directional, `blocked-by` is its reverse view)
 * and `relates` (symmetric), stored as edges in the generic links graph.
 *
 * The rules are the domain's, so they are tested here through the service the
 * tool and the socket both call: one link per unordered pair, no self-links,
 * no `blocks` cycles, no deleted endpoints, and every operation whole or not
 * at all.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { ClientMessage, ServerMessage, TaskItem } from "@assistant/shared";
import { Connection } from "./connection.ts";
import { incoming, outgoing } from "./db/links.ts";
import {
  archiveTask,
  createTask,
  deleteTask,
  listTasks,
  openTaskBlockerCounts,
  readTask,
  updateTask,
} from "./tasks.ts";

function make(title: string): TaskItem {
  return createTask({ title, source: { createdBy: "user" } });
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

/** Every stored task-link edge touching `id`, as `from relation to`. */
function edgesOf(id: string): string[] {
  const node = { type: "task" as const, id };
  return [...outgoing(node), ...incoming(node)]
    .filter((edge) => edge.relation === "blocks" || edge.relation === "relates")
    .map((edge) => `${edge.fromId} ${edge.relation} ${edge.toId}`)
    .sort();
}

function linkIds(task: TaskItem | null) {
  const links = task?.links;
  return {
    blocks: links?.blocks.map((t) => t.id) ?? [],
    blockedBy: links?.blockedBy.map((t) => t.id) ?? [],
    relates: links?.relates.map((t) => t.id) ?? [],
  };
}

test("blocks reads from both ends, and blocked-by is stored as the reverse blocks", () => {
  const a = make("Link A");
  const b = make("Link B");
  const c = make("Link C");
  try {
    updateTask(a.id, { addLinks: [{ type: "blocks", taskId: b.id }] });
    updateTask(c.id, { addLinks: [{ type: "blocked-by", taskId: a.id }] });

    assert.deepEqual(edgesOf(a.id), [
      `${a.id} blocks ${b.id}`,
      `${a.id} blocks ${c.id}`,
    ]);
    assert.deepEqual(linkIds(readTask(a.id)), {
      blocks: [b.id, c.id],
      blockedBy: [],
      relates: [],
    });
    assert.deepEqual(linkIds(readTask(c.id)).blockedBy, [a.id]);
    const blocker = readTask(b.id)?.links?.blockedBy[0];
    assert.deepEqual(blocker, {
      id: a.id,
      title: "Link A",
      status: "todo",
      archived: false,
    });
  } finally {
    discard(a.id, b.id, c.id);
  }
});

test("relates is symmetric and stored once, from the lower id", () => {
  const a = make("Relates low");
  const b = make("Relates high");
  try {
    updateTask(b.id, { addLinks: [{ type: "relates", taskId: a.id }] });
    assert.deepEqual(edgesOf(a.id), [`${a.id} relates ${b.id}`]);
    // Writing it again from the other end is the same link, not a second one.
    updateTask(a.id, { addLinks: [{ type: "relates", taskId: b.id }] });
    assert.deepEqual(edgesOf(a.id), [`${a.id} relates ${b.id}`]);
    assert.deepEqual(linkIds(readTask(a.id)).relates, [b.id]);
    assert.deepEqual(linkIds(readTask(b.id)).relates, [a.id]);
  } finally {
    discard(a.id, b.id);
  }
});

test("a pair holds one link: a reverse or different type replaces it", () => {
  const a = make("Pair A");
  const b = make("Pair B");
  try {
    updateTask(a.id, { addLinks: [{ type: "blocks", taskId: b.id }] });
    // The reverse direction replaces instead of making a two-edge cycle.
    updateTask(b.id, { addLinks: [{ type: "blocks", taskId: a.id }] });
    assert.deepEqual(edgesOf(a.id), [`${b.id} blocks ${a.id}`]);
    // A different type replaces too.
    updateTask(a.id, { addLinks: [{ type: "relates", taskId: b.id }] });
    assert.deepEqual(edgesOf(a.id), [`${a.id} relates ${b.id}`]);
    updateTask(b.id, { addLinks: [{ type: "blocked-by", taskId: a.id }] });
    assert.deepEqual(edgesOf(b.id), [`${a.id} blocks ${b.id}`]);
    // removeLinks drops whatever link the pair has, from either end.
    updateTask(b.id, { removeLinks: [a.id] });
    assert.deepEqual(edgesOf(a.id), []);
    assert.equal(readTask(a.id)?.links, undefined);
  } finally {
    discard(a.id, b.id);
  }
});

test("links refuse self, missing and deleted Tasks, and allow archived ones", () => {
  const a = make("Rule subject");
  const gone = make("Deleted target");
  const shelved = make("Archived target");
  try {
    deleteTask(gone.id);
    archiveTask(shelved.id);
    assert.throws(
      () => updateTask(a.id, { addLinks: [{ type: "relates", taskId: a.id }] }),
      new RegExp(`Task-${a.id} cannot be linked to itself`),
    );
    assert.throws(
      () =>
        updateTask(a.id, { addLinks: [{ type: "blocks", taskId: gone.id }] }),
      new RegExp(`Task-${gone.id} does not exist or was deleted`),
    );
    assert.throws(
      () =>
        updateTask(a.id, { addLinks: [{ type: "blocks", taskId: "999999" }] }),
      /Task-999999 does not exist or was deleted/,
    );
    assert.throws(
      () => updateTask(a.id, { addLinks: [{ type: "blocks", taskId: "x" }] }),
      /Not a Task id to link/,
    );
    updateTask(a.id, {
      addLinks: [{ type: "blocked-by", taskId: shelved.id }],
    });
    const blocker = readTask(a.id)?.links?.blockedBy[0];
    assert.equal(blocker?.id, shelved.id);
    assert.equal(blocker?.archived, true);
  } finally {
    discard(a.id, shelved.id);
  }
});

test("blocks stays acyclic across longer chains", () => {
  const [a, b, c, d] = ["A", "B", "C", "D"].map((n) => make(`Chain ${n}`));
  try {
    updateTask(a!.id, { addLinks: [{ type: "blocks", taskId: b!.id }] });
    updateTask(b!.id, { addLinks: [{ type: "blocks", taskId: c!.id }] });
    updateTask(c!.id, { addLinks: [{ type: "blocks", taskId: d!.id }] });
    assert.throws(
      () =>
        updateTask(d!.id, { addLinks: [{ type: "blocks", taskId: a!.id }] }),
      new RegExp(
        `Task-${d!.id} cannot block Task-${a!.id}: Task-${a!.id} already blocks Task-${d!.id}.*cycle`,
      ),
    );
    assert.throws(
      () =>
        updateTask(a!.id, {
          addLinks: [{ type: "blocked-by", taskId: c!.id }],
        }),
      /cycle/,
    );
    // relates is not part of the blocking order, so it closes no cycle.
    updateTask(d!.id, { addLinks: [{ type: "relates", taskId: a!.id }] });
    // Shortcuts that agree with the order are fine.
    updateTask(a!.id, { addLinks: [{ type: "blocks", taskId: c!.id }] });
    assert.deepEqual(linkIds(readTask(a!.id)).blocks, [b!.id, c!.id]);
  } finally {
    discard(a!.id, b!.id, c!.id, d!.id);
  }
});

test("an update with one bad link writes none of the update", () => {
  const a = make("Atomic subject");
  const b = make("Atomic B");
  const c = make("Atomic C");
  try {
    updateTask(a.id, { addLinks: [{ type: "relates", taskId: c.id }] });
    assert.throws(() =>
      updateTask(a.id, {
        title: "Must not land",
        status: "doing",
        actor: { kind: "user" },
        removeLinks: [c.id],
        addLinks: [
          { type: "blocks", taskId: b.id },
          { type: "blocks", taskId: a.id },
        ],
      }),
    );
    const after = readTask(a.id)!;
    assert.equal(after.title, "Atomic subject");
    assert.equal(after.status, "todo");
    assert.deepEqual(edgesOf(a.id), [`${a.id} relates ${c.id}`]);

    assert.throws(
      () =>
        updateTask(a.id, {
          addLinks: [{ type: "relates", taskId: b.id }],
          removeLinks: [b.id],
        }),
      new RegExp(`Task-${b.id} is named more than once`),
    );
  } finally {
    discard(a.id, b.id, c.id);
  }
});

test("a create with a bad link leaves no Task behind", () => {
  const target = make("Create target");
  const title = "Create that must roll back";
  try {
    assert.throws(() =>
      createTask({
        title,
        addLinks: [
          { type: "blocks", taskId: target.id },
          { type: "relates", taskId: "999999" },
        ],
        source: { createdBy: "agent" },
      }),
    );
    assert.equal(
      listTasks({ includeArchived: true }).some((t) => t.title === title),
      false,
    );
    assert.deepEqual(edgesOf(target.id), []);

    const created = createTask({
      title: "Create with links",
      addLinks: [{ type: "blocked-by", taskId: target.id }],
      source: { createdBy: "agent" },
    });
    assert.deepEqual(linkIds(created).blockedBy, [target.id]);
    assert.equal(created.blocked, true);
    discard(created.id);
  } finally {
    discard(target.id);
  }
});

test("blocked counts only blockers that are neither done nor archived", () => {
  const task = make("Blocked subject");
  const open = make("Open blocker");
  const done = make("Done blocker");
  const shelved = make("Archived blocker");
  try {
    updateTask(task.id, {
      addLinks: [
        { type: "blocked-by", taskId: open.id },
        { type: "blocked-by", taskId: done.id },
        { type: "blocked-by", taskId: shelved.id },
      ],
    });
    updateTask(done.id, { status: "done", actor: { kind: "user" } });
    archiveTask(shelved.id);
    assert.equal(readTask(task.id)?.blocked, true);
    assert.equal(openTaskBlockerCounts().get(task.id), 1);
    // Done and archived blockers are still listed, just not counted.
    assert.equal(readTask(task.id)?.links?.blockedBy.length, 3);

    // Being blocked never prevents a status change.
    updateTask(task.id, { status: "doing", actor: { kind: "user" } });
    assert.equal(readTask(task.id)?.status, "doing");

    updateTask(open.id, { status: "done", actor: { kind: "user" } });
    assert.equal(readTask(task.id)?.blocked, undefined);
    assert.equal(openTaskBlockerCounts().has(task.id), false);
    // Summaries stay lean: links are detail-only.
    const summary = listTasks().find((t) => t.id === task.id);
    assert.ok(summary && !("links" in summary) && !("blocked" in summary));
  } finally {
    discard(task.id, open.id, done.id, shelved.id);
  }
});

test("deleting a Task drops its links and leaves the linked Tasks intact", () => {
  const doomed = make("Doomed linked Task");
  const blocked = make("Survivor blocked");
  const related = make("Survivor related");
  const blocker = make("Survivor blocker");
  try {
    updateTask(doomed.id, {
      addLinks: [
        { type: "blocks", taskId: blocked.id },
        { type: "relates", taskId: related.id },
        { type: "blocked-by", taskId: blocker.id },
      ],
    });
    deleteTask(doomed.id);
    for (const survivor of [blocked, related, blocker]) {
      const item = readTask(survivor.id);
      assert.ok(item, "the linked Task survives");
      assert.equal(item.links, undefined);
      assert.deepEqual(edgesOf(survivor.id), []);
    }
    assert.deepEqual(edgesOf(doomed.id), []);
  } finally {
    discard(doomed.id, blocked.id, related.id, blocker.id);
  }
});

test("the socket deleteTask clears links, and getTask returns them", async () => {
  const doomed = make("Socket doomed");
  const survivor = make("Socket survivor");
  const sent: ServerMessage[] = [];
  const connection = new Connection({
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0]);
  try {
    updateTask(survivor.id, {
      addLinks: [{ type: "blocked-by", taskId: doomed.id }],
    });
    await connection.handle({
      type: "getTask",
      id: survivor.id,
      requestId: "links-before",
    } as ClientMessage);
    const before = sent.find(
      (m) => m.type === "taskDetail" && m.requestId === "links-before",
    );
    assert.ok(before?.type === "taskDetail");
    assert.deepEqual(
      before.item?.links?.blockedBy.map((t) => t.id),
      [doomed.id],
    );
    assert.equal(before.item?.blocked, true);

    await connection.handle({
      type: "deleteTask",
      id: doomed.id,
    } as ClientMessage);
    assert.equal(readTask(doomed.id), null);
    assert.ok(readTask(survivor.id));
    assert.deepEqual(edgesOf(survivor.id), []);

    await connection.handle({
      type: "getTask",
      id: survivor.id,
      requestId: "links-after",
    } as ClientMessage);
    const after = sent.find(
      (m) => m.type === "taskDetail" && m.requestId === "links-after",
    );
    assert.ok(after?.type === "taskDetail");
    assert.equal(after.item?.links, undefined);
    assert.equal(after.item?.blocked, undefined);
  } finally {
    connection.dispose();
    discard(doomed.id, survivor.id);
  }
});
