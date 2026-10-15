/**
 * The Initiative domain (docs/initiatives.md): membership resolved at read
 * time, absorption and the one refusal that keep a plain membership from being
 * stored twice, milestones on stored and covered members, the progress counts,
 * the member sessions, the graph read, and notify-with-ids as the only
 * revision bump. The coverage guard at the end fails when a new exported write
 * is not exercised.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { INITIATIVE_SUMMARY_SESSION_LIMIT } from "@assistant/shared";
import {
  addInitiativeMembers,
  archiveInitiative,
  createInitiative,
  deleteInitiative,
  initiativeRevisionDigest,
  initiativeRevisionIndex,
  initiativeSnapshot,
  initiativeStateItems,
  initiativeSummaryFor,
  listInitiatives,
  readInitiative,
  removeInitiativeMembers,
  setInitiativeMilestones,
  subscribeInitiativeChanges,
  unarchiveInitiative,
  updateInitiative,
} from "./initiatives.ts";
import {
  archiveTask,
  createTask,
  linkSessionToTask,
  reorderTasks,
  updateTask,
} from "./tasks.ts";
import { getDb } from "./db/index.ts";
import { initiativeStore } from "./db/initiativeStore.ts";
import { sessionStore } from "./db/sessionStore.ts";

const SRC = dirname(fileURLToPath(import.meta.url));

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

/** The stored edges, as `id` or `id*` for a milestone, in the user's order. */
function stored(id: string): string[] {
  return initiativeStore
    .memberEdges(Number(id))
    .sort((a, b) => a.position - b.position)
    .map((edge) => `${edge.taskId}${edge.milestone ? "*" : ""}`);
}

function memberIds(id: string): string[] {
  return readInitiative(id)!.nodes.map((node) => node.id);
}

function revisionOf(id: string): number {
  const entry = initiativeRevisionIndex().get(id);
  assert.ok(entry, `no revision row for Initiative ${id}`);
  return entry.revision;
}

/** Run `write` and assert it moved the revision AND notified `id`. */
function movesRevision(id: string, write: () => void): void {
  const before = revisionOf(id);
  const heard: string[] = [];
  const stop = subscribeInitiativeChanges((ids) => heard.push(...ids));
  try {
    write();
  } finally {
    stop();
  }
  assert.ok(revisionOf(id) > before, `Initiative ${id} kept its revision`);
  assert.ok(heard.includes(id), `Initiative ${id} was not notified`);
}

let sessionSerial = 0;
/** A session row in `scope` (user by default), linked to `taskId`. */
function session(taskId: string, scope: "user" | "internal" = "user"): string {
  sessionSerial += 1;
  const id = `sess-initiative-${sessionSerial}`;
  sessionStore.upsert({
    id,
    scope,
    harness: "pi",
    agentType: "developer",
    title: id,
    messageCount: 1,
    createdAt: 1_000 + sessionSerial,
  });
  linkSessionToTask(taskId, { sessionId: id });
  return id;
}

test("the migration's state check refuses an unknown state", () => {
  assert.throws(
    () =>
      getDb()
        .prepare(
          "INSERT INTO initiatives (id, title, state, created_at_ms, updated_at_ms) VALUES (999999, 'x', 'finished', 0, 0)",
        )
        .run(),
    /CHECK constraint failed/,
  );
});

test("adding a Task adds its subtree, including subtasks created later", () => {
  const epic = task("Epic");
  const child = task("Child", epic);
  const id = initiative("Subtree", [epic]);
  const late = task("Created later", child);

  const detail = readInitiative(id)!;
  assert.deepEqual(
    detail.nodes.map((node) => [node.id, node.parentId, node.direct]),
    [
      [epic, undefined, true],
      [child, epic, undefined],
      [late, child, undefined],
    ],
  );
  assert.deepEqual(detail.rootIds, [epic]);
  assert.equal(detail.progress.total, 3);
});

test("adding an epic absorbs its plain members and keeps their place", () => {
  const first = task("Absorb first root");
  const epic = task("Absorb epic");
  const child = task("Absorb child", epic);
  const grandchild = task("Absorb grandchild", child);
  const marked = task("Absorb milestone", epic);
  const id = initiative("Absorption", [first, child, marked]);
  setInitiativeMilestones(id, [marked], true);
  assert.deepEqual(stored(id), [first, child, `${marked}*`]);

  const write = addInitiativeMembers(id, [epic]);
  assert.deepEqual(write.absorbedTaskIds, [child]);
  assert.deepEqual(
    stored(id),
    [first, epic, `${marked}*`],
    "the epic takes the absorbed edge's place; the milestone edge stays",
  );
  assert.deepEqual(
    memberIds(id).sort(),
    [first, epic, child, grandchild, marked].sort(),
  );

  // A plain member under a member stays refused, with the reason.
  assert.throws(
    () => addInitiativeMembers(id, [grandchild]),
    new RegExp(
      `Task-${grandchild} is already a member .* through its ancestor Task-${epic}`,
    ),
  );
  // Re-adding a stored Task, marked or plain, is already the end state.
  addInitiativeMembers(id, [epic, marked]);
  assert.deepEqual(stored(id), [first, epic, `${marked}*`]);
  // All or nothing: the refused Task takes the valid one with it.
  const other = task("Absorb other");
  assert.throws(() => addInitiativeMembers(id, [other, grandchild]));
  assert.deepEqual(stored(id), [first, epic, `${marked}*`]);
  assert.throws(() => addInitiativeMembers(id, ["999999"]), /Task not found/);
  assert.throws(
    () => createInitiative({ title: "  " }),
    /An Initiative needs a title/,
  );
  // A create absorbs the same way inside its own write.
  const created = createInitiative({
    title: "Absorbing create",
    taskIds: [child, epic],
  });
  assert.deepEqual(created.absorbedTaskIds, [child]);
});

test("one member list is one request: its order never decides absorb or refuse", () => {
  const first = task("List first");
  const epic = task("List epic");
  const child = task("List child", epic);
  const grandchild = task("List grandchild", child);
  const last = task("List last");
  const orders = [
    [first, child, epic, grandchild, last],
    [first, epic, child, grandchild, last],
    [first, grandchild, child, epic, last],
  ];
  for (const order of orders) {
    const write = createInitiative({ title: "List order", taskIds: order });
    const id = String(write.initiative.id);
    assert.deepEqual(
      [...write.absorbedTaskIds].sort(),
      [child, grandchild].sort(),
      `order ${order.join(",")}`,
    );
    assert.deepEqual(stored(id), [first, epic, last], "roots keep list order");
    const added = initiative("List add");
    assert.deepEqual(
      [...addInitiativeMembers(added, order).absorbedTaskIds].sort(),
      [child, grandchild].sort(),
    );
    assert.deepEqual(stored(added), [first, epic, last]);
  }

  // A list Task a member ALREADY covers fails the whole operation.
  const id = initiative("List refusal", [epic]);
  setInitiativeMilestones(id, [child], true);
  const before = stored(id);
  const outsider = task("List outsider");
  assert.throws(
    () => addInitiativeMembers(id, [outsider, grandchild]),
    new RegExp(`Task-${grandchild} is already a member`),
  );
  assert.deepEqual(
    stored(id),
    before,
    "nothing of the refused list is written",
  );
  // A list never carries a mark, and an add over a marked edge keeps it.
  const root = task("List root above epic");
  updateTask(epic, { parentId: root });
  assert.deepEqual(stored(id), [epic, `${child}*`]);
  addInitiativeMembers(id, [root]);
  assert.deepEqual(stored(id), [root, `${child}*`]);
});

test("milestones work on covered subtasks, and a clear undoes exactly the mark", () => {
  const epic = task("Milestone epic");
  const covered = task("Covered milestone", epic);
  const sibling = task("Covered sibling", epic);
  const release = task("First release");
  const id = initiative("Milestones", [epic, release]);

  setInitiativeMilestones(id, [covered, release], true);
  const detail = readInitiative(id)!;
  assert.deepEqual(stored(id), [epic, `${release}*`, `${covered}*`]);
  assert.deepEqual(detail.milestoneIds, [release, covered]);
  assert.deepEqual(
    detail.nodes
      .filter((node) => node.milestone)
      .map((node) => [node.id, node.parentId]),
    [
      [covered, epic],
      [release, undefined],
    ],
    "a covered milestone stays under its parent on the graph",
  );
  assert.deepEqual(detail.rootIds, [epic, release]);

  // Clearing a covered mark deletes its edge; the Task stays a member.
  setInitiativeMilestones(id, [covered], false);
  assert.deepEqual(stored(id), [epic, `${release}*`]);
  assert.ok(memberIds(id).includes(covered));
  // Clearing an uncovered mark keeps the plain membership.
  setInitiativeMilestones(id, [release], false);
  assert.deepEqual(stored(id), [epic, release]);
  // A covered Task without a mark has nothing to clear.
  setInitiativeMilestones(id, [sibling], false);
  assert.deepEqual(stored(id), [epic, release]);

  assert.throws(
    () => setInitiativeMilestones(id, [task("Outsider")], true),
    /not a member .* add it first/,
  );

  // Removing the ancestor leaves a marked descendant as a member of its own.
  setInitiativeMilestones(id, [covered], true);
  const kept = removeInitiativeMembers(id, [epic]);
  assert.deepEqual(kept.stillMembers, []);
  assert.deepEqual(stored(id), [release, `${covered}*`]);
  assert.deepEqual(memberIds(id).sort(), [release, covered].sort());
});

test("removing a covered marked edge reports where the Task stays a member", () => {
  const epic = task("Remove epic");
  const covered = task("Remove covered", epic);
  const id = initiative("Remove", [epic]);
  setInitiativeMilestones(id, [covered], true);

  const write = removeInitiativeMembers(id, [covered]);
  assert.deepEqual(write.stillMembers, [{ taskId: covered, through: epic }]);
  assert.deepEqual(stored(id), [epic]);
  assert.ok(memberIds(id).includes(covered));
  // Covered and unmarked: there is no edge of its own to remove.
  assert.throws(
    () => removeInitiativeMembers(id, [covered]),
    new RegExp(`only through Task-${epic}`),
  );
  // Not a member at all: already the end state.
  removeInitiativeMembers(id, [task("Never a member")]);
});

test("a move under another member drops the plain edge it no longer needs", () => {
  const epic = task("Move epic");
  const plain = task("Moved plain root");
  const marked = task("Moved marked root");
  const dragged = task("Dragged root");
  const id = initiative("Moves", [epic, plain, marked, dragged]);
  setInitiativeMilestones(id, [marked], true);

  updateTask(plain, { parentId: epic });
  updateTask(marked, { parentId: epic });
  reorderTasks([dragged], [{ id: dragged, parentId: epic }], true);

  assert.deepEqual(
    stored(id),
    [epic, `${marked}*`],
    "plain memberships never nest; the milestone edge stays",
  );
  assert.deepEqual(memberIds(id).sort(), [epic, plain, marked, dragged].sort());
  assert.deepEqual(readInitiative(id)!.rootIds, [epic]);
});

test("counts: archived open Tasks leave the work buckets, doing and blocked overlap", () => {
  const epic = task("Count epic");
  const done = task("Done", epic);
  const archivedDone = task("Archived done", epic);
  const doing = task("Doing", epic);
  const doingBlocked = task("Doing and blocked", epic);
  const blocked = task("Blocked", epic);
  const startable = task("Startable", epic);
  const shelved = task("Shelved todo", epic);
  const shelvedDoing = task("Shelved doing", epic);
  const outside = task("Outside prerequisite");
  const closedBlocker = task("Closed prerequisite");
  for (const id of [done, archivedDone, closedBlocker])
    updateTask(id, { status: "done", actor: { kind: "user" } });
  for (const id of [doing, doingBlocked, shelvedDoing])
    updateTask(id, { status: "doing", actor: { kind: "user" } });
  updateTask(blocked, {
    addLinks: [
      { type: "blocked-by", taskId: outside },
      { type: "blocked-by", taskId: doing },
    ],
  });
  updateTask(doingBlocked, {
    addLinks: [{ type: "blocked-by", taskId: outside }],
  });
  updateTask(startable, {
    addLinks: [{ type: "blocked-by", taskId: closedBlocker }],
  });
  updateTask(done, { addLinks: [{ type: "blocked-by", taskId: outside }] });
  for (const id of [archivedDone, shelved, shelvedDoing]) archiveTask(id);
  const id = initiative("Counts", [epic]);

  const detail = readInitiative(id)!;
  assert.deepEqual(detail.progress, {
    total: 9,
    done: 2,
    doing: 2,
    startable: 2,
    blocked: 2,
  });
  const node = (taskId: string) =>
    detail.nodes.find((candidate) => candidate.id === taskId)!;
  assert.deepEqual(
    [node(doingBlocked).status, node(doingBlocked).blocked],
    ["doing", true],
  );
  assert.equal(node(blocked).blocked, true);
  assert.equal(node(done).blocked, undefined, "a done Task is never blocked");
  assert.equal(node(startable).blocked, undefined);
  assert.equal(node(shelved).archived, true);
  assert.deepEqual(
    detail.externalBlockers.map((stub) => [stub.id, stub.status]),
    [
      [outside, "todo"],
      [closedBlocker, "done"],
    ],
  );
  assert.deepEqual(
    detail.edges.map((edge) => `${edge.from}->${edge.to}`).sort(),
    [
      `${closedBlocker}->${startable}`,
      `${doing}->${blocked}`,
      `${outside}->${blocked}`,
      `${outside}->${doingBlocked}`,
      `${outside}->${done}`,
    ].sort(),
  );
  assert.ok(
    !detail.nodes.some((candidate) => "description" in candidate),
    "the graph never carries a Task description",
  );
});

test("the summary lists live user sessions on member Tasks, archived Tasks included", () => {
  const epic = task("Session epic");
  const sub = task("Session sub", epic);
  const shelved = task("Session shelved", epic);
  const id = initiative("Sessions", [epic]);
  const onSub = session(sub);
  const onShelved = session(shelved);
  const archived = session(sub);
  const settled = session(epic);
  const reopened = session(epic);
  const internal = session(epic, "internal");
  linkSessionToTask(epic, { sessionId: "sess-with-no-row" });
  archiveTask(shelved);
  sessionStore.setArchived(archived, true);
  sessionStore.setSettled(settled, true);
  sessionStore.setSettled(reopened, true);
  sessionStore.recordSessionOutcome(reopened, "completed");

  const summary = initiativeSummaryFor(id)!;
  assert.deepEqual(
    summary.sessionIds,
    [reopened, onShelved, onSub],
    "newest first; archived, settled, other-scope and unknown sessions never count",
  );
  assert.equal(summary.sessionCount, 3);
  assert.ok(!summary.sessionIds.includes(internal));
  assert.equal(summary.progress.total, 3, "an archived member still counts");
});

test("the summary carries a bounded number of session ids and the true count", () => {
  const epic = task("Many sessions");
  const id = initiative("Many sessions", [epic]);
  const extra = 3;
  for (
    let index = 0;
    index < INITIATIVE_SUMMARY_SESSION_LIMIT + extra;
    index += 1
  )
    session(epic);
  const summary = initiativeSummaryFor(id)!;
  assert.equal(summary.sessionIds.length, INITIATIVE_SUMMARY_SESSION_LIMIT);
  assert.equal(summary.sessionCount, INITIATIVE_SUMMARY_SESSION_LIMIT + extra);
});

test("the live projection excludes archived and deleted Initiatives", () => {
  const id = initiative("Projection");
  const inDigest = () =>
    initiativeRevisionDigest().some((entry) => entry.id === id);
  assert.ok(inDigest());
  assert.ok(initiativeSnapshot().items.some((item) => item.id === id));

  archiveInitiative(id);
  assert.equal(inDigest(), false);
  assert.equal(initiativeSummaryFor(id), null);
  assert.equal(initiativeStateItems([id])[0]?.kind, "delete");
  assert.ok(readInitiative(id)?.archivedAt, "an archived graph stays readable");
  assert.ok(
    listInitiatives({ includeArchived: true }).some((item) => item.id === id),
  );
  assert.ok(!listInitiatives().some((item) => item.id === id));

  unarchiveInitiative(id);
  assert.equal(initiativeStateItems([id])[0]?.kind, "upsert");

  deleteInitiative(id);
  assert.equal(readInitiative(id), null);
  assert.equal(initiativeStateItems([id])[0]?.kind, "delete");
  assert.throws(() => updateInitiative(id, { title: "x" }), /not found/);
});

test("list reads filter by state and search", () => {
  const paused = String(
    createInitiative({
      title: "Hosted Labs rollout",
      description: "Three projects",
      state: "paused",
    }).initiative.id,
  );
  const active = initiative("Unrelated");
  const ids = (items: { id: string }[]) => items.map((item) => item.id);
  assert.ok(ids(listInitiatives({ state: "paused" })).includes(paused));
  assert.ok(!ids(listInitiatives({ state: "paused" })).includes(active));
  assert.deepEqual(ids(listInitiatives({ query: "three PROJECTS" })), [paused]);
});

test("every Initiative write reports the row it touched", () => {
  const member = task("Revision member");
  const id = initiative("Revision subject");
  assert.ok(revisionOf(id) > 0, "a create stamps above the default 0");

  movesRevision(id, () => updateInitiative(id, { title: "Renamed" }));
  movesRevision(id, () => updateInitiative(id, { state: "paused" }));
  movesRevision(id, () => addInitiativeMembers(id, [member]));
  movesRevision(id, () => setInitiativeMilestones(id, [member], true));
  movesRevision(id, () => removeInitiativeMembers(id, [member]));
  movesRevision(id, () => archiveInitiative(id));
  movesRevision(id, () => unarchiveInitiative(id));
  movesRevision(id, () => deleteInitiative(id));
  assert.equal(initiativeRevisionIndex().get(id)?.live, false);

  // A refused write rolls back whole and touches nothing.
  const kept = initiative("Refused write");
  const before = revisionOf(kept);
  assert.throws(() => addInitiativeMembers(kept, ["999999"]));
  assert.equal(revisionOf(kept), before);

  // Coverage guard: every exported write of the domain is exercised above
  // (a create is checked by the stamp it starts with).
  const source = readFileSync(join(SRC, "initiatives.ts"), "utf8");
  const writes = [
    ...source.matchAll(
      /^export function ((?:update|archive|unarchive|delete|add|remove|set)\w*)/gm,
    ),
  ].map((match) => match[1]);
  assert.ok(writes.length >= 7, "the guard found the domain's writes");
  const exercised = readFileSync(fileURLToPath(import.meta.url), "utf8");
  for (const name of writes)
    assert.ok(
      new RegExp(`movesRevision\\(id, \\(\\) => ${name}\\(`).test(exercised),
      `${name} is an Initiative write this test does not exercise`,
    );
});
