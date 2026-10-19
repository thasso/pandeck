/**
 * An Initiative's attention cursor and its Settle (docs/initiatives.md, The
 * attention list): every new Initiative arrives raised, its own edits and state
 * changes, member Task changes and linked session activity raise it again, and
 * a mechanical write (a deleted session's unlink, a pure sibling renumber, the
 * completed-work retention sweep, a project deletion's cascade) only refreshes
 * it. Only the user's Settle — through the revision the clicked card rendered,
 * clamped and forward-only — acknowledges it. An agent's state change never
 * does.
 *   pnpm --filter @assistant/server test src/initiativeAttention.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { InitiativeSummary } from "@assistant/shared";
import {
  archiveInitiative,
  createInitiative,
  deleteInitiative,
  initiativeRevisionIndex,
  initiativeStateItems,
  initiativeSummaryFor,
  readInitiative,
  settleInitiative,
  subscribeInitiativeChanges,
  unarchiveInitiative,
  updateInitiative,
} from "./initiatives.ts";
import {
  createTask,
  linkSessionToTask,
  markTaskProcessed,
  readTask,
  reorderTasks,
  sweepCompletedTaskArchive,
  TASK_AUTO_ARCHIVE_AFTER_MS,
  unlinkSessionEverywhere,
  updateTask,
} from "./tasks.ts";
import { deleteProject, upsertProject } from "./projectRegistry.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { initiativeTools } from "./tools/initiatives/initiativeTools.ts";
import type { ToolCallContext } from "./mcp/tool.ts";

function initiative(state?: "active" | "paused" | "done"): string {
  return String(
    createInitiative({ title: "Attention", ...(state ? { state } : {}) })
      .initiative.id,
  );
}

function summary(id: string): InitiativeSummary {
  const item = initiativeSummaryFor(id);
  assert.ok(item, `Initiative ${id} is not in the live projection`);
  return item;
}

/** Revision and acknowledgement, or `none` before anything was raised. */
function cursor(id: string): string {
  const attention = readInitiative(id)!.attention;
  return attention
    ? `${attention.kind}@${attention.revision}/${attention.settledRevision}`
    : "none";
}

function task(
  title: string,
  options: { parentId?: string; createdBy?: "user" | "agent" } = {},
): string {
  return createTask({
    title,
    source: { createdBy: options.createdBy ?? "user" },
    ...(options.parentId ? { parentId: options.parentId } : {}),
  }).id;
}

function revisionOf(id: string): number {
  return initiativeRevisionIndex().get(id)?.revision ?? -1;
}

/** Settle exactly what is raised now, as a click on the current card does. */
function settleNow(id: string): void {
  settleInitiative(id, readInitiative(id)!.attention!.revision);
  assert.equal(
    summary(id).attention!.revision,
    summary(id).attention!.settledRevision,
  );
}

/**
 * What `write` did to `id`: `raised` when attention moved, `refreshed` when
 * only the state-event revision moved and `id` was notified, `untouched`
 * otherwise. A refresh that is not notified fails.
 */
function effectOn(id: string, write: () => void): string {
  const before = { attention: cursor(id), revision: revisionOf(id) };
  const heard = new Set<string>();
  const stop = subscribeInitiativeChanges((ids) => {
    for (const each of ids) heard.add(each);
  });
  try {
    write();
  } finally {
    stop();
  }
  const moved = revisionOf(id) > before.revision;
  assert.equal(
    heard.has(id),
    moved,
    "notified exactly when the revision moved",
  );
  if (cursor(id) !== before.attention) {
    assert.ok(moved, "attention never moves without a revision");
    return "raised";
  }
  return moved ? "refreshed" : "untouched";
}

test("every new Initiative arrives raised; an active one as activity", () => {
  assert.equal(cursor(initiative()), "activity@1/0");
  assert.equal(cursor(initiative("active")), "activity@1/0");
  assert.equal(cursor(initiative("paused")), "paused@1/0");
  assert.equal(cursor(initiative("done")), "done@1/0");
});

test("edits and state changes raise in the write itself; repeating them does not", () => {
  const id = initiative();
  updateInitiative(id, { title: "Renamed", description: "No state" });
  assert.equal(cursor(id), "activity@2/0", "an edit is activity");
  const raisedAt = summary(id).attention!.at;
  updateInitiative(id, { title: "Renamed", description: "No state" });
  updateInitiative(id, { state: "active" });
  assert.equal(
    cursor(id),
    "activity@2/0",
    "repeating unchanged fields raises nothing",
  );
  assert.equal(summary(id).attention!.at, raisedAt);

  updateInitiative(id, { state: "paused" });
  assert.equal(cursor(id), "paused@3/0");
  updateInitiative(id, { state: "paused" });
  assert.equal(cursor(id), "paused@3/0", "re-stating paused raises nothing");
  updateInitiative(id, { state: "done" });
  assert.equal(cursor(id), "done@4/0", "paused to done is a new outcome");
  updateInitiative(id, { state: "active" });
  assert.equal(cursor(id), "activity@5/0", "becoming active is activity too");
  assert.equal(summary(id).state, "active");
});

test("Settle acknowledges exactly what the card rendered, clamped and forward-only", () => {
  const id = initiative();
  updateInitiative(id, { state: "paused" });
  updateInitiative(id, { state: "done" });
  assert.equal(cursor(id), "done@3/0");

  // A card rendered at revision 2 is clicked after revision 3 landed: the
  // newer outcome stays unacknowledged.
  settleInitiative(id, 2);
  assert.equal(cursor(id), "done@3/2");

  // A click cannot acknowledge the future.
  settleInitiative(id, 99);
  assert.equal(cursor(id), "done@3/3");

  // An older click arriving late never takes the acknowledgement back.
  settleInitiative(id, 1);
  settleInitiative(id, 0);
  assert.equal(cursor(id), "done@3/3");

  // A newer outcome raised after the Settle stands on its own.
  updateInitiative(id, { state: "paused" });
  assert.equal(cursor(id), "paused@4/3");
});

test("a stale Settle leaves newer member activity raised, and settling raises nothing", () => {
  const member = task("Stale member");
  const id = String(
    createInitiative({ title: "Stale", taskIds: [member] }).initiative.id,
  );
  const rendered = summary(id).attention!.revision;
  updateTask(member, { status: "doing" });
  const raised = summary(id).attention!.revision;
  assert.ok(raised > rendered, "the member's status change is activity");

  assert.equal(
    effectOn(id, () => settleInitiative(id, rendered)),
    "raised",
  );
  assert.equal(cursor(id), `activity@${raised}/${rendered}`, "still unsettled");
  settleNow(id);
  assert.equal(cursor(id), `activity@${raised}/${raised}`);
  assert.equal(
    effectOn(id, () => settleInitiative(id, raised)),
    "refreshed",
    "a repeated Settle is a write of its own and raises nothing",
  );
});

test("member Task content, status and hierarchy changes wake a settled Initiative", () => {
  const epic = task("Woken epic");
  const child = task("Woken child", { parentId: epic });
  const outside = task("Woken outsider");
  const id = String(
    createInitiative({ title: "Woken", taskIds: [epic] }).initiative.id,
  );
  const wakes = (label: string, write: () => void) => {
    settleNow(id);
    assert.equal(effectOn(id, write), "raised", label);
  };
  wakes("a title edit", () => updateTask(child, { title: "Renamed child" }));
  wakes("a status change", () => updateTask(child, { status: "doing" }));
  wakes("a reorder that reparents a Task in", () =>
    reorderTasks(
      [],
      [
        { id: child, parentId: epic },
        { id: outside, parentId: epic },
      ],
      true,
    ),
  );
  assert.equal(readTask(outside)?.parentId, epic);
  wakes("a reorder that reparents a Task out", () =>
    reorderTasks([], [{ id: outside }], true),
  );
  assert.equal(readTask(outside)?.parentId, undefined);
  wakes("a reparent through a Task update", () =>
    updateTask(outside, { parentId: epic }),
  );
  wakes("a new session started from a member Task", () => {
    sessionStore.upsert({
      id: "woken-session",
      harness: "pi",
      agentType: "developer",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    linkSessionToTask(child, {
      sessionId: "woken-session",
      origin: "task-start",
    });
  });
});

/** A settled Initiative holding an epic with two subtasks. */
function heldEpic(title: string) {
  const epic = task(`${title} epic`);
  const first = task(`${title} first`, { parentId: epic });
  const second = task(`${title} second`, { parentId: epic });
  const id = String(createInitiative({ title, taskIds: [epic] }).initiative.id);
  return { epic, first, second, id };
}

/** `write` refreshes the settled Initiative `id` and leaves it settled. */
function refreshesOnly(id: string, write: () => void): void {
  settleNow(id);
  assert.equal(effectOn(id, write), "refreshed");
  assert.equal(
    summary(id).attention!.revision,
    summary(id).attention!.settledRevision,
  );
}

test("deleting a session started from a member Task does not wake its Initiative", () => {
  const { first, id } = heldEpic("Deleted session");
  sessionStore.upsert({
    id: "deleted-member-session",
    harness: "pi",
    agentType: "developer",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  linkSessionToTask(first, {
    sessionId: "deleted-member-session",
    origin: "task-start",
  });
  // The delete handler's order: tombstone, then drop every Task reference.
  refreshesOnly(id, () => {
    sessionStore.markDeleted("deleted-member-session");
    assert.deepEqual(unlinkSessionEverywhere("deleted-member-session"), [
      first,
    ]);
  });
  assert.deepEqual(readTask(first)?.sessionRefs ?? [], []);
});

test("a pure sibling renumber does not wake the Initiatives holding the siblings", () => {
  const { epic, first, second, id } = heldEpic("Renumber");
  refreshesOnly(id, () =>
    reorderTasks(
      [],
      [
        { id: second, parentId: epic },
        { id: first, parentId: epic },
      ],
      true,
    ),
  );
  refreshesOnly(id, () => updateTask(first, { sortOrder: 7 }));
  // A root-level drop renumbering the held epic among unrelated roots.
  const loose = task("Renumber loose root");
  refreshesOnly(id, () =>
    reorderTasks([], [{ id: loose }, { id: epic }], true),
  );
});

test("completed-work retention does not wake the Initiatives holding it", () => {
  const { epic, first, second, id } = heldEpic("Retention");
  for (const each of [first, second, epic])
    updateTask(each, { status: "done" });
  refreshesOnly(id, () => {
    const archived = sweepCompletedTaskArchive(
      Date.now() + TASK_AUTO_ARCHIVE_AFTER_MS + 60_000,
    );
    assert.ok(archived.includes(first) && archived.includes(epic));
  });
  assert.ok(readTask(epic)?.archivedAt !== undefined);
});

test("bookkeeping cascades refresh without waking: a processed mark, a deleted project", () => {
  const { epic, second, id } = heldEpic("Bookkeeping");
  const arrival = task("Bookkeeping arrival", {
    parentId: epic,
    createdBy: "agent",
  });
  assert.equal(readTask(arrival)?.triagedAt, undefined);
  refreshesOnly(id, () => markTaskProcessed(arrival));

  upsertProject({ id: "attention-doomed", name: "Doomed", key: "ATDM" });
  updateTask(second, { projectId: "attention-doomed" });
  refreshesOnly(id, () => deleteProject("attention-doomed"));
  assert.equal(readTask(second)?.projectId, undefined);
});

test("Settle is a write of its own: one event, a new revision, no edit time", () => {
  const id = initiative("done");
  const before = readInitiative(id)!;
  const heard: string[] = [];
  const stop = subscribeInitiativeChanges((ids) => heard.push(...ids));
  try {
    settleInitiative(id, 1);
  } finally {
    stop();
  }
  assert.deepEqual(heard, [id]);
  const [event] = initiativeStateItems([id]);
  assert.equal(event?.kind, "upsert");
  assert.ok(event!.revision > 0);
  assert.equal(
    event?.kind === "upsert" && event.item.attention?.settledRevision,
    1,
  );
  assert.equal(summary(id).updatedAt, before.updatedAt);
});

test("Settle names what it cannot find, and an archived Initiative leaves the live list", () => {
  assert.throws(() => settleInitiative("999999", 1), /Initiative not found/);
  assert.throws(() => settleInitiative("not-an-id", 1), /Initiative not found/);

  const archived = initiative("paused");
  archiveInitiative(archived);
  assert.equal(initiativeSummaryFor(archived), null);
  assert.equal(initiativeStateItems([archived])[0]?.kind, "delete");
  assert.equal(
    readInitiative(archived)?.attention?.revision,
    1,
    "archiving raises nothing",
  );
  unarchiveInitiative(archived);
  assert.equal(cursor(archived), "paused@2/0", "coming back is activity");

  const deleted = initiative("done");
  deleteInitiative(deleted);
  assert.equal(initiativeStateItems([deleted])[0]?.kind, "delete");
  assert.throws(() => settleInitiative(deleted, 1), /Initiative not found/);
});

test("agents change the state but never settle it", async () => {
  const manage = initiativeTools().find(
    (tool) => tool.name === "initiative_manage",
  )!;
  const operationEnum = JSON.stringify(manage.parameters);
  assert.doesNotMatch(operationEnum, /settle/i, "no agent operation settles");

  const ctx: ToolCallContext = {
    toolCallId: "initiative-attention-test",
    session: {
      sessionId: "initiative-attention-session",
      harness: "pi",
      agentType: "developer",
    },
  };
  const id = initiative();
  await manage.execute(
    { operations: [{ operation: "update", id, state: "done" }] },
    ctx,
  );
  assert.equal(cursor(id), "done@2/0", "an agent's done raises for the user");
  await manage.execute(
    { operations: [{ operation: "update", id, state: "done" }] },
    ctx,
  );
  assert.equal(cursor(id), "done@2/0", "and re-stating it does not");
});
