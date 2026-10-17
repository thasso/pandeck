/**
 * A Task knows the Initiatives holding it (docs/tasks.md, docs/initiatives.md):
 * a single-Task read carries them as `initiatives`, directly or through the
 * nearest member ancestor, without archived or deleted ones, and never on a
 * summary. Every write that changes such a list reports the Tasks it changed,
 * member subtrees whole, through the Task seam, which IS their revision bump.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { TaskInitiativeRef } from "@assistant/shared";
import {
  addInitiativeMembers,
  archiveInitiative,
  createInitiative,
  deleteInitiative,
  initiativeRevisionIndex,
  removeInitiativeMembers,
  setInitiativeMilestones,
  unarchiveInitiative,
  updateInitiative,
} from "./initiatives.ts";
import {
  createTask,
  deleteTask,
  readTask,
  reorderTasks,
  taskRevision,
  taskStateItems,
  taskSummaryFor,
  updateTask,
} from "./tasks.ts";
import { initiativeStore } from "./db/initiativeStore.ts";
import type { ToolCallContext, ToolResult } from "./mcp/tool.ts";
import { taskToolsForKind } from "./tools/tasks/taskTools.ts";

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

function initiativesOf(id: string): TaskInitiativeRef[] | undefined {
  return readTask(id)!.initiatives;
}

/** The Tasks among `ids` whose revision `write` moved. */
function bumped(ids: string[], write: () => void): string[] {
  const before = ids.map((id) => taskRevision(id) ?? -1);
  write();
  return ids.filter((id, index) => (taskRevision(id) ?? -1) > before[index]!);
}

test("a direct member, a descendant of a member epic and a non-member read their Initiatives", () => {
  const epic = task("Membership epic");
  const sub = task("Membership sub", epic);
  const leaf = task("Membership leaf", sub);
  const loner = task("Membership loner");
  const id = initiative("Membership", [epic]);
  const other = initiative("Membership other", [leaf]);
  const ref = { id, title: "Membership", state: "active" as const };

  assert.deepEqual(initiativesOf(epic), [ref]);
  assert.deepEqual(initiativesOf(sub), [
    { ...ref, through: { id: epic, title: "Membership epic" } },
  ]);
  // Held twice: directly by one Initiative, through an ancestor by another.
  assert.deepEqual(initiativesOf(leaf), [
    { ...ref, through: { id: epic, title: "Membership epic" } },
    { id: other, title: "Membership other", state: "active" },
  ]);
  assert.equal(initiativesOf(loner), undefined, "absent when there are none");

  // A milestone's own edge under the member epic is the nearest path.
  setInitiativeMilestones(id, [sub], true);
  assert.deepEqual(initiativesOf(sub), [ref]);
  assert.deepEqual(initiativesOf(leaf)?.[0], {
    ...ref,
    through: { id: sub, title: "Membership sub" },
  });

  updateInitiative(id, { state: "paused" });
  assert.equal(initiativesOf(epic)?.[0]?.state, "paused");
});

test("archived and deleted Initiatives are left out, and an unarchived one returns", () => {
  const member = task("Shelved member");
  const archived = initiative("Shelved", [member]);
  const deleted = initiative("Deleted", [member]);
  archiveInitiative(archived);
  deleteInitiative(deleted);
  assert.equal(initiativesOf(member), undefined);
  unarchiveInitiative(archived);
  assert.deepEqual(
    initiativesOf(member)?.map((entry) => entry.id),
    [archived],
  );
});

test("membership is not holdersOf: a blocker of a member is read by the Initiative but held by none", () => {
  const member = task("Held member");
  const blocker = task("Outside blocker");
  updateTask(member, { addLinks: [{ type: "blocked-by", taskId: blocker }] });
  const id = initiative("Holders apart", [member]);
  assert.ok(initiativeStore.holdersOf([Number(blocker)]).includes(Number(id)));
  assert.equal(initiativesOf(blocker), undefined);
});

test("only a single-Task read carries them: never a summary or a state event", () => {
  const member = task("Summary member");
  initiative("Summary", [member]);
  assert.ok(readTask(member)!.initiatives?.length);
  assert.equal("initiatives" in taskSummaryFor(member)!, false);
  const [event] = taskStateItems([member]);
  assert.equal(event?.kind, "upsert");
  assert.equal(event?.kind === "upsert" && "initiatives" in event.item, false);
});

test("membership writes bump the affected Tasks, member subtrees included", () => {
  const epic = task("Bump epic");
  const sub = task("Bump sub", epic);
  const leaf = task("Bump leaf", sub);
  const plain = task("Bump plain");
  const bystander = task("Bump bystander");
  const all = [epic, sub, leaf, plain, bystander];

  let id = "";
  assert.deepEqual(
    bumped(all, () => {
      id = initiative("Bump", [sub]);
    }),
    [sub, leaf],
    "a create with members reports their subtrees",
  );
  assert.deepEqual(
    bumped(all, () => addInitiativeMembers(id, [plain])),
    [plain],
  );
  // Adding the epic absorbs the sub's edge: the whole epic subtree changed.
  assert.deepEqual(
    bumped(all, () => addInitiativeMembers(id, [epic])),
    [epic, sub, leaf],
  );
  assert.deepEqual(
    bumped(all, () => addInitiativeMembers(id, [epic])),
    [],
  );
  // A milestone's own edge under the epic changes the path below it.
  assert.deepEqual(
    bumped(all, () => setInitiativeMilestones(id, [sub], true)),
    [sub, leaf],
  );
  assert.deepEqual(
    bumped(all, () => setInitiativeMilestones(id, [sub], false)),
    [sub, leaf],
  );
  assert.deepEqual(
    bumped(all, () => setInitiativeMilestones(id, [plain], true)),
    [],
    "a mark rewritten in place changes no Task's list",
  );
  assert.deepEqual(
    bumped(all, () => removeInitiativeMembers(id, [epic])),
    [epic, sub, leaf],
  );
  assert.equal(initiativesOf(leaf), undefined);
  assert.deepEqual(
    bumped(all, () => removeInitiativeMembers(id, [plain])),
    [plain],
  );
});

test("title, state, archive and delete bump every held Task; a description does not", () => {
  const epic = task("Row epic");
  const sub = task("Row sub", epic);
  const loner = task("Row loner");
  const id = initiative("Row", [epic]);
  // Another Initiative holding the same Tasks is no part of this write.
  const sibling = initiative("Row sibling", [epic]);
  const all = [epic, sub, loner];
  const siblingRevision = () =>
    initiativeRevisionIndex().get(sibling)?.revision;

  const before = siblingRevision();
  assert.deepEqual(
    bumped(all, () => updateInitiative(id, { title: "Row renamed" })),
    [epic, sub],
  );
  assert.equal(siblingRevision(), before, "the Task fan-out bumps no holder");
  assert.equal(initiativesOf(sub)?.[0]?.title, "Row renamed");
  assert.deepEqual(
    bumped(all, () => updateInitiative(id, { state: "done" })),
    [epic, sub],
  );
  assert.deepEqual(
    bumped(all, () => updateInitiative(id, { state: "done" })),
    [],
  );
  assert.deepEqual(
    bumped(all, () => updateInitiative(id, { description: "Longer" })),
    [],
  );
  assert.deepEqual(
    bumped(all, () => archiveInitiative(id)),
    [epic, sub],
  );
  assert.deepEqual(
    bumped(all, () => addInitiativeMembers(id, [loner])),
    [],
    "an archived Initiative's writes change no Task's list",
  );
  assert.deepEqual(
    bumped(all, () => unarchiveInitiative(id)),
    [epic, sub, loner],
  );
  assert.deepEqual(
    bumped(all, () => deleteInitiative(id)),
    [epic, sub, loner],
  );
  assert.deepEqual(
    initiativesOf(sub)?.map((entry) => entry.id),
    [sibling],
  );
});

test("a reparent that changes inherited membership bumps the moved subtree", () => {
  const epic = task("Move epic");
  const other = task("Move other");
  const moved = task("Move moved");
  const child = task("Move child", moved);
  const bystander = task("Move bystander", other);
  const id = initiative("Move", [epic]);
  const watched = [child, bystander];

  assert.deepEqual(
    bumped(watched, () => updateTask(moved, { parentId: epic })),
    [child],
  );
  assert.equal(initiativesOf(child)?.[0]?.through?.id, epic);
  assert.deepEqual(
    bumped(watched, () =>
      reorderTasks([], [{ id: moved, parentId: other }], true),
    ),
    [child],
  );
  assert.equal(initiativesOf(child), undefined);
  // A move that keeps the membership the same reports only the moved Task.
  addInitiativeMembers(id, [moved]);
  assert.deepEqual(
    bumped(watched, () => updateTask(moved, { parentId: null })),
    [],
  );
  assert.equal(initiativesOf(child)?.[0]?.through?.id, moved);

  // Deleting a held parent takes the membership from the children it orphans.
  const head = task("Delete head");
  const orphan = task("Delete orphan", head);
  const grandchild = task("Delete grandchild", orphan);
  addInitiativeMembers(id, [head]);
  assert.deepEqual(
    bumped([orphan, grandchild], () => deleteTask(head)),
    [orphan, grandchild],
  );
  assert.equal(initiativesOf(grandchild), undefined);
});

const ctx: ToolCallContext = {
  toolCallId: "task-initiatives-test",
  session: {
    sessionId: "task-initiatives-session",
    harness: "pi",
    agentType: "assistant",
  },
};

type ReadItem = { id: string; initiatives?: TaskInitiativeRef[] };

async function taskRead(params: Record<string, unknown>): Promise<ReadItem[]> {
  const read = taskToolsForKind("assistant").find(
    (tool) => tool.name === "task_read",
  )!;
  const result: ToolResult = await read.execute(params, ctx);
  return (result.details as { items: ReadItem[] }).items;
}

test("task_read by id lists the Initiatives; a list read does not", async () => {
  const epic = task("Tool read epic");
  const sub = task("Tool read sub", epic);
  const loner = task("Tool read loner");
  const id = initiative("Tool read", [epic]);

  assert.deepEqual((await taskRead({ id: sub }))[0]?.initiatives, [
    {
      id,
      title: "Tool read",
      state: "active",
      through: { id: epic, title: "Tool read epic" },
    },
  ]);
  assert.equal((await taskRead({ id: loner }))[0]?.initiatives, undefined);
  const listed = (await taskRead({ query: "Tool read" })).find(
    (item) => item.id === sub,
  );
  assert.ok(listed);
  assert.equal(listed.initiatives, undefined);
  // With subtasks, only the Task read by id carries them.
  const tree = await taskRead({ id: epic, includeSubtasks: true });
  assert.ok(tree.find((item) => item.id === epic)?.initiatives);
  assert.equal(tree.find((item) => item.id === sub)?.initiatives, undefined);
});
