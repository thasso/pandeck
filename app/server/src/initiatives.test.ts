/**
 * The Initiative domain (docs/initiatives.md): membership resolved at read
 * time, the refusals that keep a Task from being stored twice, the progress
 * counts, the graph read, and notify-with-ids as the only revision bump. The
 * coverage guard at the end fails when a new exported write is not exercised.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
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
import { createTask, linkSessionToTask, updateTask } from "./tasks.ts";
import { getDb } from "./db/index.ts";

const SRC = dirname(fileURLToPath(import.meta.url));

function task(title: string, extra: { parentId?: string } = {}): string {
  return createTask({ title, source: { createdBy: "user" }, ...extra }).id;
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
  const child = task("Child", { parentId: epic });
  const initiative = createInitiative({ title: "Subtree", taskIds: [epic] });
  const id = String(initiative.id);
  const late = task("Created later", { parentId: child });

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

test("a Task inside a member, or holding one, is refused with the reason", () => {
  const epic = task("Refusal epic");
  const child = task("Refusal child", { parentId: epic });
  const grandchild = task("Refusal grandchild", { parentId: child });
  const initiative = createInitiative({ title: "Refusals", taskIds: [child] });
  const id = String(initiative.id);

  assert.throws(
    () => addInitiativeMembers(id, [grandchild]),
    new RegExp(
      `Task-${grandchild} is already a member .* ancestor Task-${child}`,
    ),
  );
  assert.throws(
    () => addInitiativeMembers(id, [epic]),
    new RegExp(
      `Task-${epic} contains Task-${child}, which is already a member`,
    ),
  );
  // Re-adding a stored member is already the end state.
  addInitiativeMembers(id, [child]);
  // All or nothing: the refused grandchild takes the valid Task with it.
  const other = task("Refusal other");
  assert.throws(() => addInitiativeMembers(id, [other, grandchild]));
  assert.deepEqual(readInitiative(id)!.rootIds, [child]);
  // A member through an ancestor cannot be removed on its own.
  assert.throws(
    () => removeInitiativeMembers(id, [grandchild]),
    new RegExp(`only through Task-${child}`),
  );
  assert.throws(() => addInitiativeMembers(id, ["999999"]), /Task not found/);
  assert.throws(
    () => createInitiative({ title: "  " }),
    /An Initiative needs a title/,
  );
});

test("milestones live on stored membership edges", () => {
  const epic = task("Milestone epic");
  const sub = task("Milestone sub", { parentId: epic });
  const release = task("First release");
  const initiative = createInitiative({
    title: "Milestones",
    taskIds: [epic, release],
  });
  const id = String(initiative.id);

  setInitiativeMilestones(id, [release], true);
  let detail = readInitiative(id)!;
  assert.deepEqual(detail.milestoneIds, [release]);
  assert.equal(
    detail.nodes.find((node) => node.id === release)?.milestone,
    true,
  );
  assert.deepEqual(detail.rootIds, [epic, release], "the mark keeps the order");

  assert.throws(() => setInitiativeMilestones(id, [sub], true), /only through/);
  assert.throws(
    () => setInitiativeMilestones(id, [task("Outsider")], true),
    /not a member .* add it first/,
  );
  setInitiativeMilestones(id, [release], false);
  detail = readInitiative(id)!;
  assert.deepEqual(detail.milestoneIds, []);
});

test("counts split todo by open blockers, and the graph draws outside blockers as stubs", () => {
  const epic = task("Count epic");
  const done = task("Done", { parentId: epic });
  const doing = task("Doing", { parentId: epic });
  const blocked = task("Blocked", { parentId: epic });
  const startable = task("Startable", { parentId: epic });
  const outside = task("Outside prerequisite");
  const closedBlocker = task("Closed prerequisite");
  updateTask(done, { status: "done", actor: { kind: "user" } });
  updateTask(doing, { status: "doing", actor: { kind: "user" } });
  updateTask(closedBlocker, { status: "done", actor: { kind: "user" } });
  updateTask(blocked, {
    addLinks: [
      { type: "blocked-by", taskId: outside },
      { type: "blocked-by", taskId: doing },
    ],
  });
  updateTask(startable, {
    addLinks: [{ type: "blocked-by", taskId: closedBlocker }],
  });
  const initiative = createInitiative({ title: "Counts", taskIds: [epic] });
  const id = String(initiative.id);

  const detail = readInitiative(id)!;
  assert.deepEqual(detail.progress, {
    total: 5,
    done: 1,
    doing: 1,
    startable: 2,
    blocked: 1,
  });
  const state = (taskId: string) =>
    detail.nodes.find((node) => node.id === taskId)?.state;
  assert.equal(state(epic), "startable");
  assert.equal(state(blocked), "blocked");
  assert.equal(state(startable), "startable");
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
    ].sort(),
  );
  assert.ok(
    !detail.nodes.some((node) => "description" in node),
    "the graph never carries a Task description",
  );
});

test("the summary names the sessions linked to unarchived member Tasks", () => {
  const epic = task("Session epic");
  const sub = task("Session sub", { parentId: epic });
  const shelved = task("Shelved", { parentId: epic });
  linkSessionToTask(sub, { sessionId: "sess-initiative-a" });
  linkSessionToTask(epic, { sessionId: "sess-initiative-b" });
  linkSessionToTask(sub, { sessionId: "sess-initiative-b" });
  linkSessionToTask(shelved, { sessionId: "sess-initiative-c" });
  updateTask(shelved, { archivedAt: Date.now() });
  const initiative = createInitiative({ title: "Sessions", taskIds: [epic] });

  const summary = initiativeSummaryFor(String(initiative.id))!;
  assert.deepEqual(summary.sessionIds, [
    "sess-initiative-a",
    "sess-initiative-b",
  ]);
  // An archived member stays a member and keeps counting.
  assert.equal(summary.progress.total, 3);
});

test("the live projection excludes archived and deleted Initiatives", () => {
  const initiative = createInitiative({ title: "Projection" });
  const id = String(initiative.id);
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
  const paused = createInitiative({
    title: "Hosted Labs rollout",
    description: "Three projects",
    state: "paused",
  });
  const active = createInitiative({ title: "Unrelated" });
  const ids = (items: { id: string }[]) => items.map((item) => item.id);
  assert.ok(
    ids(listInitiatives({ state: "paused" })).includes(String(paused.id)),
  );
  assert.ok(
    !ids(listInitiatives({ state: "paused" })).includes(String(active.id)),
  );
  assert.deepEqual(ids(listInitiatives({ query: "three PROJECTS" })), [
    String(paused.id),
  ]);
});

test("every Initiative write reports the row it touched", () => {
  const member = task("Revision member");
  const created = createInitiative({ title: "Revision subject" });
  const id = String(created.id);
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
  const kept = createInitiative({ title: "Refused write" });
  const before = revisionOf(String(kept.id));
  assert.throws(() => addInitiativeMembers(String(kept.id), ["999999"]));
  assert.equal(revisionOf(String(kept.id)), before);

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
