/**
 * A Task or session write reports the Initiatives that read it — holding the
 * Task as a member or below one, drawing it as an outside blocker, or listing
 * the session — in the same notification (docs/initiatives.md), including the
 * ones a delete or a move takes the Task away from, which nothing links
 * afterwards. A refused write reports nothing because it wrote nothing.
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
  archiveInitiative,
  createInitiative,
  deleteInitiative,
  initiativeRevisionIndex,
  readInitiative,
  unarchiveInitiative,
  updateInitiative,
} from "./initiatives.ts";
import {
  archiveTask,
  createTask,
  deleteTask,
  linkSessionToTask,
  readTask,
  reorderTasks,
  unarchiveTask,
  unlinkSessionEverywhere,
  updateTask,
} from "./tasks.ts";
import { deleteProject, upsertProject } from "./projectRegistry.ts";
import { initiativeStore } from "./db/initiativeStore.ts";
import { sessionStore } from "./db/sessionStore.ts";

function task(title: string, parentId?: string): string {
  return createTask({
    title,
    source: { createdBy: "user" },
    ...(parentId ? { parentId } : {}),
  }).id;
}

function initiative(title: string, taskIds: string[] = []): string {
  return String(createInitiative({ title, taskIds }).initiative.id);
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

test("Task status, archive, links, sessions and new subtasks move the holding Initiatives only", () => {
  const epic = task("Fan-out epic");
  const sub = task("Fan-out sub", epic);
  const outside = task("Fan-out outside blocker");
  const unrelated = task("Fan-out unrelated");
  const holder = initiative("Holder", [epic]);
  const bystander = initiative("Bystander", [unrelated]);
  const both = [holder, bystander];

  assert.deepEqual(
    bumped(both, () =>
      updateTask(sub, { status: "doing", actor: { kind: "user" } }),
    ),
    [holder],
    "a descendant's status moves the Initiative holding its ancestor",
  );
  assert.equal(readInitiative(holder)!.progress.doing, 1);

  assert.deepEqual(
    bumped(both, () => task("Fan-out subtask created later", epic)),
    [holder],
    "a subtask created under a member joins and reports",
  );
  assert.equal(readInitiative(holder)!.progress.total, 3);

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
    bumped(both, () => unarchiveTask(sub)),
    [holder],
  );
  assert.deepEqual(
    bumped(both, () => updateTask(task("Fan-out stranger"), { title: "x" })),
    [],
    "a Task no Initiative reads moves none",
  );
});

test("an outside blocker's project, however it changes, moves the Initiatives drawing it", () => {
  const member = task("Stub member");
  const blockerEpic = task("Stub blocker epic");
  const blocker = task("Stub blocker", blockerEpic);
  updateTask(member, { addLinks: [{ type: "blocked-by", taskId: blocker }] });
  const id = initiative("Stub projects", [member]);
  upsertProject({ id: "stub-project-a", name: "Stub A", key: "STBA" });
  upsertProject({ id: "stub-project-b", name: "Stub B", key: "STBB" });
  const stubProject = () =>
    readInitiative(id)!.externalBlockers.find((stub) => stub.id === blocker)
      ?.projectId;

  assert.deepEqual(
    bumped([id], () => updateTask(blocker, { projectId: "stub-project-a" })),
    [id],
  );
  assert.equal(stubProject(), "stub-project-a");
  assert.deepEqual(
    bumped([id], () =>
      updateTask(blockerEpic, { projectId: "stub-project-b" }),
    ),
    [id],
    "a project the blocker inherits from its parent",
  );
  assert.equal(stubProject(), "stub-project-b");
  assert.deepEqual(
    bumped([id], () => deleteProject("stub-project-b")),
    [id],
    "a deleted project clears the blocker's project",
  );
  assert.equal(stubProject(), undefined);
  deleteProject("stub-project-a");
});

test("deleting a member's project moves its holder", () => {
  const member = task("Project member");
  upsertProject({ id: "fanout-doomed", name: "Doomed", key: "FODM" });
  updateTask(member, { projectId: "fanout-doomed" });
  const id = initiative("Project holder", [member]);
  assert.deepEqual(
    bumped([id], () => deleteProject("fanout-doomed")),
    [id],
  );
  assert.equal(readInitiative(id)!.nodes[0]!.projectId, undefined);
});

test("a delete notifies the Initiatives it took the Task out of", () => {
  const epic = task("Deleted epic");
  const child = task("Orphaned child", epic);
  const leaf = task("Deleted leaf", epic);
  const id = initiative("Delete", [epic]);

  assert.deepEqual(
    bumped([id], () => deleteTask(leaf)),
    [id],
  );
  assert.deepEqual(
    bumped([id], () => deleteTask(epic)),
    [id],
    "deleting the member drops its edge, so the holder is read first",
  );
  const detail = readInitiative(id)!;
  assert.deepEqual(detail.nodes, [], "the orphaned child left with its parent");
  assert.equal(detail.progress.total, 0);
  assert.ok(readTask(child), "the child itself survives as a root");
});

test("a move notifies the Initiative it left and the one it joined", () => {
  const fromEpic = task("Move from epic");
  const toEpic = task("Move to epic");
  const moving = task("Moving", fromEpic);
  const left = initiative("Left", [fromEpic]);
  const joined = initiative("Joined", [toEpic]);

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

test("a refused reorder writes nothing: no move, no membership change, no bump", () => {
  const fromEpic = task("Refused from epic");
  const toEpic = task("Refused to epic");
  const moving = task("Refused moving", fromEpic);
  const deep = task("Refused deep", moving);
  const doomed = task("Deleted in another tab");
  const left = initiative("Refused left", [fromEpic]);
  const joined = initiative("Refused joined", [toEpic]);
  deleteTask(doomed);
  const snapshot = () => ({
    parent: readTask(moving)?.parentId,
    order: readTask(moving)?.sortOrder,
    left: readInitiative(left)!.nodes.map((node) => node.id),
    joined: readInitiative(joined)!.nodes.map((node) => node.id),
    revisions: [revisionOf(left), revisionOf(joined)],
  });
  const before = snapshot();

  // A stale tab: the first placement is a valid move, a later one names a
  // Task that no longer exists.
  assert.throws(
    () =>
      reorderTasks(
        [],
        [
          { id: moving, parentId: toEpic },
          { id: doomed, parentId: null },
        ],
        true,
      ),
    /Task not found/,
  );
  assert.deepEqual(snapshot(), before);
  assert.throws(
    () =>
      reorderTasks(
        [],
        [
          { id: moving, parentId: toEpic },
          { id: moving, parentId: toEpic },
        ],
        true,
      ),
    /Duplicate task/,
  );
  assert.deepEqual(snapshot(), before);
  // Under its own descendant: the old parent edge is dropped before the cycle
  // check, which only the transaction puts back.
  assert.throws(
    () => reorderTasks([], [{ id: moving, parentId: deep }], true),
    /cycle/,
  );
  assert.deepEqual(snapshot(), before);
});

test("a session's archive, settle and raised outcome move the Initiatives listing it", () => {
  const member = task("Session member");
  const id = initiative("Session liveness", [member]);
  sessionStore.upsert({
    id: "sess-liveness",
    scope: "user",
    harness: "pi",
    agentType: "developer",
    title: "liveness",
    messageCount: 1,
  });
  linkSessionToTask(member, { sessionId: "sess-liveness" });
  const listed = () => readInitiative(id)!.sessionIds;
  assert.deepEqual(listed(), ["sess-liveness"]);

  assert.deepEqual(
    bumped([id], () => sessionStore.setArchived("sess-liveness", true)),
    [id],
  );
  assert.deepEqual(listed(), []);
  assert.deepEqual(
    bumped([id], () => sessionStore.setArchived("sess-liveness", false)),
    [id],
  );
  assert.deepEqual(listed(), ["sess-liveness"]);
  assert.deepEqual(
    bumped([id], () => sessionStore.setSettled("sess-liveness", true)),
    [id],
  );
  assert.deepEqual(listed(), []);
  assert.deepEqual(
    bumped([id], () =>
      sessionStore.recordSessionOutcome("sess-liveness", "completed"),
    ),
    [id],
  );
  assert.deepEqual(listed(), ["sess-liveness"], "a new outcome wakes it");
  assert.deepEqual(
    bumped([id], () => sessionStore.remove("sess-liveness")),
    [id],
  );
  assert.deepEqual(listed(), []);
});

test("a session row registered after its Task link still reaches the summary", () => {
  const member = task("Late session member");
  const id = initiative("Late session", [member]);
  linkSessionToTask(member, { sessionId: "sess-late-row" });
  assert.deepEqual(readInitiative(id)!.sessionIds, []);
  assert.deepEqual(
    bumped([id], () =>
      sessionStore.upsert({
        id: "sess-late-row",
        scope: "user",
        harness: "pi",
        agentType: "developer",
        title: "late",
        messageCount: 1,
      }),
    ),
    [id],
  );
  assert.deepEqual(readInitiative(id)!.sessionIds, ["sess-late-row"]);
});

function initiativeBatches(messages: ServerMessage[]) {
  return messages.flatMap((message) =>
    message.type === "stateEvents" && message.topic === "initiatives"
      ? [message.events as StateEvent<InitiativeSummary>[]]
      : [],
  );
}

test("a Task write and its Initiative event leave in the same flush", async () => {
  const epic = task("Flush epic");
  const id = initiative("Flush", [epic]);
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
    const [events] = initiativeBatches(messages);
    assert.deepEqual(
      events?.map((event) => event.id),
      [id],
    );
    const upsert = events![0];
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

test("archive deletes, later writes repeat the delete at a newer revision, unarchive upserts", async () => {
  const member = task("Archived holder member");
  const id = initiative("Archived holder", [member]);
  await hub.flushPendingBroadcastsForTests();
  const messages: ServerMessage[] = [];
  const viewer = {
    send: (message: ServerMessage) => messages.push(message),
    wantsTopic: (topic: string) => topic === "initiatives",
  };
  hub.register(viewer);
  const last = async (write: () => void) => {
    messages.length = 0;
    write();
    await hub.flushPendingBroadcastsForTests();
    const batches = initiativeBatches(messages);
    assert.equal(batches.length, 1, "one batch per flush");
    const event = batches[0]!.find((candidate) => candidate.id === id);
    assert.ok(event, `no event for Initiative ${id}`);
    return event;
  };
  try {
    const archived = await last(() => archiveInitiative(id));
    assert.equal(archived.kind, "delete");
    const renamed = await last(() =>
      updateInitiative(id, { title: "Renamed while archived" }),
    );
    assert.equal(renamed.kind, "delete");
    assert.ok(renamed.revision > archived.revision);
    const memberChanged = await last(() =>
      updateTask(member, { status: "doing", actor: { kind: "user" } }),
    );
    assert.equal(memberChanged.kind, "delete");
    assert.ok(memberChanged.revision > renamed.revision);
    const restored = await last(() => unarchiveInitiative(id));
    assert.equal(restored.kind, "upsert");
    assert.equal(
      restored.kind === "upsert" && restored.item.title,
      "Renamed while archived",
    );
    await last(() => archiveInitiative(id));
    const deleted = await last(() => deleteInitiative(id));
    assert.equal(deleted.kind, "delete");
    assert.equal(revisionOf(id), deleted.revision);
    assert.equal(initiativeStore.get(Number(id)), undefined);
  } finally {
    hub.unregister(viewer);
  }
});
