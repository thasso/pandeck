import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  archiveTask,
  createTask,
  deleteTask,
  linkSessionToTask,
  listRelatedGlobalTasks,
  listSessionTasks,
  listTasks,
  markTaskProcessed,
  readTask,
  reorderTasks,
  shiftLocalDateKey,
  startTaskAutoArchiveSweep,
  stopTaskAutoArchiveSweep,
  subscribeTaskChanges,
  sweepCompletedTaskArchive,
  TASK_AUTO_ARCHIVE_AFTER_MS,
  taskIndexVersion,
  taskSummaryOf,
  unarchiveTask,
  updateTask,
} from "./tasks.ts";
import { taskStore } from "./db/taskStore.ts";

test("tasks list/save/read use the current task shape without inert compatibility fields", () => {
  const created = createTask({
    title: "Current shape task",
    description: "body",
    status: "todo",
    projectId: "proj-1",
    jiraIssueKeys: ["APP-42"],
    dueDate: "2026-07-10",
    priority: "high",
    source: { createdBy: "user" },
  });

  try {
    assert.equal(created.title, "Current shape task");
    assert.deepEqual(created.jiraIssueKeys, ["APP-42"]);
    assert.equal(created.projectId, "proj-1");
    assert.equal(created.dueDate, "2026-07-10");
    assert.equal(created.priority, "high");
    assert.equal(Object.hasOwn(created, "scope"), false);
    assert.equal(Object.hasOwn(created, "jiraIssueKey"), false);
    assert.equal(Object.hasOwn(created, "reminderAt"), false);
    assert.equal(Object.hasOwn(created, "dependsOnIds"), false);

    const listed = listTasks({ projectId: "proj-1" }).find(
      (task) => task.id === created.id,
    )!;
    assert.equal(listed.title, "Current shape task");
    assert.equal(Object.hasOwn(listed, "scope"), false);
    assert.equal(Object.hasOwn(listed, "jiraIssueKey"), false);
    assert.equal(Object.hasOwn(listed, "reminderAt"), false);
    assert.equal(Object.hasOwn(listed, "dependsOnIds"), false);

    const updated = updateTask(created.id, {
      title: "Updated shape task",
      jiraIssueKeys: ["APP-43"],
    });
    assert.equal(updated.title, "Updated shape task");
    assert.deepEqual(updated.jiraIssueKeys, ["APP-43"]);
    assert.equal(readTask(created.id)?.title, "Updated shape task");
  } finally {
    deleteTask(created.id);
  }
});

test("GitHub issue links are stored canonical, replaced on update, and searchable", () => {
  const created = createTask({
    title: "GitHub linked task",
    githubIssues: [
      "https://github.com/acme/app/issues/12",
      "acme/app#12",
      "not a ref",
      "acme/tools#3",
      "https://github.com/nodejs/.github/issues/1",
    ],
    source: { createdBy: "user" },
  });

  try {
    const refs = ["acme/app#12", "acme/tools#3", "nodejs/.github#1"];
    assert.deepEqual(created.githubIssues, refs);
    assert.deepEqual(readTask(created.id)?.githubIssues, refs);
    assert.deepEqual(taskSummaryOf(created).githubIssues, refs);
    assert.equal(
      listTasks({ query: "tools#3" }).some((task) => task.id === created.id),
      true,
    );
    const updated = updateTask(created.id, {
      githubIssues: ["https://github.com/acme/app/pull/40"],
    });
    assert.deepEqual(updated.githubIssues, ["acme/app#40"]);
    const cleared = updateTask(created.id, { githubIssues: [] });
    assert.equal(Object.hasOwn(cleared, "githubIssues"), false);
  } finally {
    deleteTask(created.id);
  }
});

test("the Task list projection is allowlisted, lean, and server-path free", () => {
  const created = createTask({
    title: "Projection census",
    description: "A body rendered only as a preview in list rows.",
    projectId: "project-1",
    jiraIssueKeys: ["APP-42"],
    externalLinks: [
      {
        url: "https://example.com/source",
        type: "source",
        source: "unknown",
      },
    ],
    dueDate: "2026-09-01",
    sessionRefs: [
      {
        sessionId: "session-1",
        origin: "task-start",
        harness: "pi",
        agentType: "developer",
        attachedAt: 123,
        sessionFile: "/tmp/example/private/native.jsonl",
      },
    ],
    source: { createdBy: "user" },
  });

  try {
    const item = updateTask(created.id, {
      commitHash: "abc123",
      committedAt: 456,
    });
    const summary = taskSummaryOf(item);
    assert.deepEqual(Object.keys(summary).sort(), [
      "commitHash",
      "createdAt",
      "descriptionPreview",
      "dueDate",
      "externalLinks",
      "id",
      "jiraIssueKeys",
      "projectId",
      "sessionRefs",
      // Every Task is created with a manual position, so the Backlog never has
      // to fall back to a mutable field to place a row.
      "sortOrder",
      "source",
      "status",
      "title",
      "updatedAt",
    ]);
    assert.deepEqual(summary.sessionRefs, [
      { sessionId: "session-1", origin: "task-start" },
    ]);
    assert.equal(JSON.stringify(summary).includes("/home/user"), false);
    assert.ok(
      Buffer.byteLength(JSON.stringify(summary)) < 1_000,
      "representative Task summary exceeded its per-item wire budget",
    );
  } finally {
    deleteTask(created.id);
  }
});

test("done Task retention archives old roots but guards children of active parents", () => {
  const root = createTask({
    title: "Old root",
    status: "done",
    source: { createdBy: "user" },
  });
  const activeParent = createTask({
    title: "Active parent",
    status: "todo",
    source: { createdBy: "user" },
  });
  const guardedChild = createTask({
    title: "Old child kept in its tree",
    status: "done",
    parentId: activeParent.id,
    source: { createdBy: "user" },
  });
  const archivedParent = createTask({
    title: "Archived parent",
    status: "todo",
    source: { createdBy: "user" },
  });
  const releasedChild = createTask({
    title: "Old child whose parent is archived",
    status: "done",
    parentId: archivedParent.id,
    source: { createdBy: "user" },
  });

  try {
    archiveTask(archivedParent.id);
    const future = Date.now() + TASK_AUTO_ARCHIVE_AFTER_MS + 1;
    const first = sweepCompletedTaskArchive(future);
    assert.ok(first.includes(root.id));
    assert.ok(first.includes(releasedChild.id));
    assert.equal(readTask(root.id)?.archivedAt !== undefined, true);
    assert.equal(readTask(releasedChild.id)?.archivedAt !== undefined, true);
    assert.equal(readTask(guardedChild.id)?.archivedAt, undefined);

    const clock = vi.spyOn(Date, "now").mockReturnValue(future);
    try {
      updateTask(activeParent.id, {
        status: "done",
        actor: { kind: "user" },
      });
    } finally {
      clock.mockRestore();
    }
    assert.equal(
      readTask(guardedChild.id)?.archivedAt !== undefined,
      true,
      "completing the parent runs retention on the common write seam",
    );
    assert.equal(readTask(activeParent.id)?.archivedAt, undefined);

    const second = sweepCompletedTaskArchive(
      future + TASK_AUTO_ARCHIVE_AFTER_MS + 1,
    );
    assert.ok(second.includes(activeParent.id));
  } finally {
    for (const task of [
      guardedChild,
      activeParent,
      releasedChild,
      archivedParent,
      root,
    ])
      deleteTask(task.id);
  }
});

test("a failed post-write retention sweep cannot fail or hide the originating write", () => {
  const beforeVersion = taskIndexVersion();
  let notifications = 0;
  let createdId: string | undefined;
  const off = subscribeTaskChanges(() => {
    notifications += 1;
  });
  const list = vi.spyOn(taskStore, "list").mockImplementationOnce(() => {
    throw new Error("injected retention read failure");
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  try {
    assert.doesNotThrow(() => {
      createdId = createTask({
        title: "Write survives retention failure",
        source: { createdBy: "user" },
      }).id;
    });
    assert.ok(createdId && readTask(createdId));
    assert.equal(taskIndexVersion(), beforeVersion + 1);
    assert.equal(
      notifications,
      1,
      "the durable write still notified listeners",
    );
    assert.match(String(warn.mock.calls[0]?.[0]), /post-write auto-archive/);
  } finally {
    off();
    list.mockRestore();
    warn.mockRestore();
    if (createdId) deleteTask(createdId);
  }
});

test("boot and hourly retention failures are logged and retried", () => {
  vi.useFakeTimers();
  stopTaskAutoArchiveSweep();
  const list = vi.spyOn(taskStore, "list");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  list.mockImplementationOnce(() => {
    throw new Error("injected boot failure");
  });

  try {
    assert.doesNotThrow(() => startTaskAutoArchiveSweep());
    list.mockImplementationOnce(() => {
      throw new Error("injected hourly failure");
    });
    assert.doesNotThrow(() => vi.advanceTimersByTime(60 * 60 * 1000));
    assert.doesNotThrow(() => vi.advanceTimersByTime(60 * 60 * 1000));
    assert.equal(list.mock.calls.length, 3, "the next hourly sweep retried");
    assert.match(String(warn.mock.calls[0]?.[0]), /boot auto-archive/);
    assert.match(String(warn.mock.calls[1]?.[0]), /hourly auto-archive/);
  } finally {
    stopTaskAutoArchiveSweep();
    list.mockRestore();
    warn.mockRestore();
    vi.useRealTimers();
  }
});

/** Today/tomorrow/yesterday as YYYY-MM-DD in the server's local zone, matching
 *  how `tasks.ts` buckets a date-only field. */
function localDay(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

test("scheduledFor round-trips independently of dueDate and is cleared by null", () => {
  const created = createTask({
    title: "Planned task",
    dueDate: "2026-07-10",
    scheduledFor: "2026-07-03",
    source: { createdBy: "user" },
  });

  try {
    // The plan and the deadline are separate facts; setting one must not move
    // the other.
    assert.equal(created.dueDate, "2026-07-10");
    assert.equal(created.scheduledFor, "2026-07-03");

    const moved = updateTask(created.id, { scheduledFor: "2026-07-04" });
    assert.equal(moved.scheduledFor, "2026-07-04");
    assert.equal(moved.dueDate, "2026-07-10");

    const unplanned = updateTask(created.id, { scheduledFor: null });
    assert.equal(unplanned.scheduledFor, undefined);
    assert.equal(unplanned.dueDate, "2026-07-10");

    // A malformed date is dropped rather than persisted as junk.
    const garbage = updateTask(created.id, { scheduledFor: "not-a-date" });
    assert.equal(garbage.scheduledFor, undefined);

    assert.equal(readTask(created.id)?.dueDate, "2026-07-10");
  } finally {
    deleteTask(created.id);
  }
});

test("the scheduled filter buckets by the planned day, not the deadline", () => {
  const today = createTask({
    title: "Planned today",
    scheduledFor: localDay(0),
    source: { createdBy: "user" },
  });
  const tomorrow = createTask({
    title: "Planned tomorrow",
    scheduledFor: localDay(1),
    source: { createdBy: "user" },
  });
  // Planned for a day that has gone: still unfinished work, which is the whole
  // reason the field is a date rather than a "today" flag.
  const past = createTask({
    title: "Planned yesterday",
    scheduledFor: localDay(-1),
    source: { createdBy: "user" },
  });
  // Due today but never planned: it must NOT answer a scheduled filter.
  const dueOnly = createTask({
    title: "Due today",
    dueDate: localDay(0),
    source: { createdBy: "user" },
  });
  const ids = new Set([today.id, tomorrow.id, past.id, dueOnly.id]);
  const mine = (filter: Parameters<typeof listTasks>[0]) =>
    listTasks(filter)
      .filter((t) => ids.has(t.id))
      .map((t) => t.id);

  try {
    assert.deepEqual(mine({ scheduled: "today" }), [today.id]);
    assert.deepEqual(mine({ scheduled: "tomorrow" }), [tomorrow.id]);
    assert.deepEqual(mine({ scheduled: "past" }), [past.id]);
    assert.deepEqual(
      mine({ scheduled: "unplanned" }).sort(),
      [dueOnly.id].sort(),
    );

    // A done Task is off every planning list, however it was scheduled.
    updateTask(today.id, { status: "done" });
    assert.deepEqual(mine({ scheduled: "today" }), []);
  } finally {
    for (const id of ids) deleteTask(id);
  }
});

test("an agent's done suggests completion and takes the Task out of doing", () => {
  const created = createTask({
    title: "Agent work",
    status: "doing",
    source: { createdBy: "user" },
  });

  try {
    const suggested = updateTask(created.id, {
      status: "done",
      statusReason: "tests pass",
      actor: { kind: "agent", id: "sess-1" },
    });
    // The claim is recorded; the Task is emphatically NOT done. It leaves
    // `doing` in the same write, so no corrective second mutation is needed.
    assert.equal(suggested.status, "todo");
    assert.equal(suggested.statusSuggestion?.to, "done");
    assert.equal(suggested.statusSuggestion?.sessionId, "sess-1");
    assert.equal(suggested.statusSuggestion?.reason, "tests pass");
    assert.ok((suggested.statusSuggestion?.at ?? 0) > 0);

    // It also must not vanish from the open list, which was the actual bug.
    assert.ok(listTasks({ status: "todo" }).some((t) => t.id === created.id));
  } finally {
    deleteTask(created.id);
  }
});

test("an agent handing work back suggests todo and leaves the status alone", () => {
  const created = createTask({
    title: "Handed back",
    status: "doing",
    source: { createdBy: "user" },
  });

  try {
    const suggested = updateTask(created.id, {
      status: "todo",
      statusReason: "blocked on the API key",
      actor: { kind: "agent", id: "sess-1" },
    });
    // Unlike a `done` suggestion, this one moves nothing: until the user
    // answers, the honest state of paused work is still `doing`.
    assert.equal(suggested.status, "doing");
    assert.equal(suggested.statusSuggestion?.to, "todo");
    assert.equal(suggested.statusSuggestion?.reason, "blocked on the API key");
  } finally {
    deleteTask(created.id);
  }
});

test("repeating a suggestion keeps its timestamp; changing it replaces it", () => {
  const created = createTask({
    title: "Re-claimed",
    status: "doing",
    source: { createdBy: "user" },
  });

  try {
    const first = updateTask(created.id, {
      status: "todo",
      actor: { kind: "agent", id: "sess-1" },
    });
    const again = updateTask(created.id, {
      status: "todo",
      actor: { kind: "agent", id: "sess-2" },
    });
    // How long something has sat unanswered is the useful fact; a retrying
    // agent must not reset it.
    assert.equal(again.statusSuggestion?.at, first.statusSuggestion?.at);
    assert.equal(again.statusSuggestion?.sessionId, "sess-1");

    // Changing its mind is a new statement, so it replaces the old one.
    const changed = updateTask(created.id, {
      status: "done",
      actor: { kind: "agent", id: "sess-2" },
    });
    assert.equal(changed.statusSuggestion?.to, "done");
    assert.equal(changed.statusSuggestion?.sessionId, "sess-2");
    assert.equal(changed.status, "todo");
  } finally {
    deleteTask(created.id);
  }
});

test("only a real user decision clears a status suggestion", () => {
  const created = createTask({
    title: "Claimed",
    status: "doing",
    source: { createdBy: "user" },
  });

  try {
    updateTask(created.id, {
      status: "done",
      actor: { kind: "agent", id: "sess-1" },
    });

    // An ordinary save that leaves the status alone must NOT discard the claim
    // — editing a description should not silently throw it away.
    const edited = updateTask(created.id, {
      description: "notes",
      status: "todo",
      actor: { kind: "user" },
    });
    assert.ok(
      edited.statusSuggestion,
      "an unrelated edit dropped the pending suggestion",
    );

    // Dismissing it outright is its own flag, since rejecting changes nothing else.
    const rejected = updateTask(created.id, {
      status: "todo",
      clearStatusSuggestion: true,
      actor: { kind: "user" },
    });
    assert.equal(rejected.statusSuggestion, undefined);
    assert.equal(rejected.status, "todo");
  } finally {
    deleteTask(created.id);
  }
});

test("the user confirming completes the task and clears the suggestion", () => {
  const created = createTask({
    title: "Confirmed",
    status: "doing",
    source: { createdBy: "user" },
  });

  try {
    updateTask(created.id, {
      status: "done",
      actor: { kind: "agent", id: "sess-1" },
    });
    const confirmed = updateTask(created.id, {
      status: "done",
      actor: { kind: "user" },
    });
    assert.equal(confirmed.status, "done");
    assert.equal(confirmed.statusSuggestion, undefined);
  } finally {
    deleteTask(created.id);
  }
});

test("moving a claimed task to another status is also a decision", () => {
  const created = createTask({
    title: "Reopened",
    status: "doing",
    source: { createdBy: "user" },
  });

  try {
    updateTask(created.id, {
      status: "done",
      actor: { kind: "agent", id: "sess-1" },
    });
    const moved = updateTask(created.id, {
      status: "doing",
      actor: { kind: "user" },
    });
    assert.equal(moved.status, "doing");
    assert.equal(moved.statusSuggestion, undefined);
  } finally {
    deleteTask(created.id);
  }
});

test("the user's explicit request lets an agent complete the Task", () => {
  const created = createTask({
    title: "Completed at the user's request",
    status: "doing",
    source: { createdBy: "user" },
  });

  try {
    const done = updateTask(created.id, {
      status: "done",
      userRequestedStatus: true,
      statusReason: "you asked me to close it",
      actor: { kind: "agent", id: "sess-1" },
    });
    // The status IS applied, and the claim is still recorded with agent
    // provenance so it reads as "done at your request" and stays reversible.
    assert.equal(done.status, "done");
    assert.equal(done.statusSuggestion?.to, "done");
    assert.equal(done.statusSuggestion?.sessionId, "sess-1");
  } finally {
    deleteTask(created.id);
  }
});

test("a system actor still completes directly", () => {
  const created = createTask({
    title: "Completed by a system actor",
    status: "doing",
    source: { createdBy: "user" },
  });

  try {
    // A `system` actor's completion is not a report to be answered, so it must
    // not be downgraded to a suggestion.
    const done = updateTask(created.id, { status: "done" });
    assert.equal(done.status, "done");
    assert.equal(done.statusSuggestion, undefined);
  } finally {
    deleteTask(created.id);
  }
});

test("triage is decided by the caller, not inferred from who created the Task", () => {
  // Typed straight into the Backlog: nothing to decide.
  const typed = createTask({
    title: "I typed this",
    triaged: true,
    source: { createdBy: "user" },
  });
  // An agent noticing work.
  const fromAgent = createTask({
    title: "Agent found this",
    source: { createdBy: "agent", sessionId: "s1" },
  });
  // Slack shortcut intake: honestly created BY the user (they asked for it) and
  // still an arrival they have not processed. Inferring triage from `createdBy`
  // is what used to keep every Slack Task out of the Inbox it is advertised for.
  const fromSlack = createTask({
    title: "Slack sent this",
    source: { createdBy: "user" },
  });

  try {
    assert.ok(typed.triagedAt, "a typed Task should need no triage");
    assert.equal(fromAgent.triagedAt, undefined);
    assert.equal(
      fromSlack.triagedAt,
      undefined,
      "a Slack import must still be waiting",
    );

    const inbox = listTasks({ untriaged: true }).map((t) => t.id);
    assert.ok(inbox.includes(fromAgent.id));
    assert.ok(inbox.includes(fromSlack.id));
    assert.ok(!inbox.includes(typed.id));
  } finally {
    for (const t of [typed, fromAgent, fromSlack]) deleteTask(t.id);
  }
});

test("agent provenance survives the round trip, so an arrival can say where it came from", () => {
  const created = createTask({
    title: "From a coding session",
    source: { createdBy: "agent", agentType: "developer", sessionId: "sess-9" },
  });

  try {
    // `toSummary` used to rebuild `source` as `{ createdBy }` alone, so every
    // arrival read as a generic "from an agent" however it was made.
    assert.equal(created.source.agentType, "developer");
    assert.equal(created.source.sessionId, "sess-9");

    const listed = listTasks({}).find((t) => t.id === created.id)!;
    assert.equal(listed.source.agentType, "developer");
    assert.equal(listed.source.sessionId, "sess-9");
    assert.equal(readTask(created.id)?.source.agentType, "developer");
  } finally {
    deleteTask(created.id);
  }
});

test("any user edit triages implicitly, and an agent edit never does", () => {
  const task = createTask({
    title: "Arrived",
    source: { createdBy: "agent", sessionId: "s1" },
  });

  try {
    // An agent touching it again leaves it waiting: only the USER can process.
    const byAgent = updateTask(task.id, {
      priority: "high",
      actor: { kind: "agent", id: "s1" },
    });
    assert.equal(byAgent.triagedAt, undefined);

    // Changing anything about it means it has been seen.
    const byUser = updateTask(task.id, {
      priority: "urgent",
      actor: { kind: "user" },
    });
    assert.ok(byUser.triagedAt);

    // A later edit must not keep moving the timestamp — when it was processed
    // is a fact about the first decision.
    const again = updateTask(task.id, {
      title: "Renamed",
      actor: { kind: "user" },
    });
    assert.equal(again.triagedAt, byUser.triagedAt);
  } finally {
    deleteTask(task.id);
  }
});

test("triage is explicit for the act that changes nothing else, and reversible", () => {
  const task = createTask({
    title: "Nothing to do here",
    source: { createdBy: "agent", sessionId: "s1" },
  });

  try {
    const dismissed = updateTask(task.id, {
      triaged: true,
      actor: { kind: "user" },
    });
    assert.ok(dismissed.triagedAt);
    assert.ok(!listTasks({ untriaged: true }).some((t) => t.id === task.id));

    // Back into the Inbox: a decision can be taken back.
    const restored = updateTask(task.id, {
      triaged: false,
      actor: { kind: "user" },
    });
    assert.equal(restored.triagedAt, undefined);
    assert.ok(listTasks({ untriaged: true }).some((t) => t.id === task.id));
  } finally {
    deleteTask(task.id);
  }
});

test("reading a Task does not triage it", () => {
  const task = createTask({
    title: "Only looked at",
    source: { createdBy: "agent", sessionId: "s1" },
  });

  try {
    // An inbox that empties itself when you glance at a row cannot be used to
    // track what you still owe an answer to.
    assert.equal(readTask(task.id)?.triagedAt, undefined);
    assert.equal(
      listTasks({}).find((t) => t.id === task.id)?.triagedAt,
      undefined,
    );
  } finally {
    deleteTask(task.id);
  }
});

test("the specialized user paths triage too, and agent/system ones never do", () => {
  const assigned = createTask({
    title: "Arrived A",
    source: { createdBy: "agent" },
  });
  const archived = createTask({
    title: "Arrived B",
    source: { createdBy: "agent" },
  });
  const byAgent = createTask({
    title: "Arrived C",
    source: { createdBy: "agent" },
  });
  const bySystem = createTask({
    title: "Arrived D",
    source: { createdBy: "agent" },
  });

  try {
    // `connection.ts`'s assign-projects command: a real user decision that used
    // to slip past triage because it carried no actor.
    assert.ok(
      updateTask(assigned.id, { projectId: "proj-x", actor: { kind: "user" } })
        .triagedAt,
    );

    // Archiving from the browser, which routes through `archiveTask`.
    assert.ok(archiveTask(archived.id, { kind: "user" }).triagedAt);
    // ...and unarchiving must not put it back untriaged.
    assert.ok(unarchiveTask(archived.id, { kind: "user" }).triagedAt);

    // The same edits from an agent or the system leave it waiting.
    assert.equal(
      updateTask(byAgent.id, {
        projectId: "proj-x",
        actor: { kind: "agent", id: "s1" },
      }).triagedAt,
      undefined,
    );
    assert.equal(archiveTask(bySystem.id).triagedAt, undefined);
  } finally {
    for (const t of [assigned, archived, byAgent, bySystem]) deleteTask(t.id);
  }
});

test("a user drag triages a REPARENT but not plain reordering", () => {
  const parent = createTask({
    title: "Parent",
    triaged: true,
    source: { createdBy: "user" },
  });
  const moved = createTask({
    title: "Dragged under the parent",
    source: { createdBy: "agent" },
  });
  const bystander = createTask({
    title: "Renumbered sibling",
    source: { createdBy: "agent" },
  });

  try {
    reorderTasks(
      [],
      [
        { id: moved.id, parentId: parent.id },
        { id: bystander.id, parentId: null },
      ],
      true,
    );

    // The Task whose parent changed was decided about.
    assert.ok(
      readTask(moved.id)?.triagedAt,
      "a reparent is an unambiguous decision",
    );
    // A drop renumbers every sibling; triaging those would silently process a
    // dozen arrivals because one of them was dragged past.
    assert.equal(readTask(bystander.id)?.triagedAt, undefined);
  } finally {
    for (const t of [parent, moved, bystander]) deleteTask(t.id);
  }
});

test("every Task JOINS its sibling group at a free position", () => {
  // The Backlog places a row by `sortOrder` alone. A Task without one had to be
  // placed by recency, so working on it moved it; two Tasks sharing one had to
  // be separated the same way. Nothing may arrive without a place of its own.
  const first = createTask({ title: "First", source: { createdBy: "user" } });
  const second = createTask({ title: "Second", source: { createdBy: "user" } });
  const epic = createTask({ title: "Epic", source: { createdBy: "user" } });
  const stepOne = createTask({
    title: "Step one",
    parentId: epic.id,
    source: { createdBy: "agent" },
  });
  const stepTwo = createTask({
    title: "Step two",
    parentId: epic.id,
    source: { createdBy: "agent" },
  });

  try {
    // A root arrival goes ABOVE what is already there — it has to be seen.
    assert.ok(
      second.sortOrder! < first.sortOrder!,
      "a new root Task sorts above the previous one",
    );
    // A parent's children are its plan, and a plan reads top-down.
    assert.ok(
      stepOne.sortOrder! < stepTwo.sortOrder!,
      "subtasks keep the order they were written in",
    );

    // A reparent nobody dragged: the moved Task must not keep the index it held
    // among its OLD siblings and land on a real sibling here.
    updateTask(second.id, { parentId: epic.id });
    const siblings = [stepOne.id, stepTwo.id, second.id].map(
      (id) => readTask(id)!.sortOrder,
    );
    assert.equal(
      new Set(siblings).size,
      siblings.length,
      `reparent collided: ${siblings.join(",")}`,
    );

    // And so does a Task coming back from the archive, which left holding an
    // index the Backlog has since given away.
    archiveTask(first.id);
    reorderTasks([], [{ id: epic.id, parentId: null }], true);
    unarchiveTask(first.id);
    assert.notEqual(
      readTask(first.id)!.sortOrder,
      readTask(epic.id)!.sortOrder,
      "an unarchived Task rejoins at a free position",
    );
  } finally {
    for (const t of [stepOne, stepTwo, second, epic, first]) deleteTask(t.id);
  }
});

test("unarchiving a Task that is already live moves nothing", () => {
  // `unarchiveTask` does not reject a live Task, so the Undo action and
  // `task_manage` can both repeat it. Rejoining a group is for a Task that
  // actually LEFT one; a redundant call may not move a row the user placed.
  const task = createTask({ title: "Live", source: { createdBy: "user" } });
  try {
    reorderTasks([], [{ id: task.id, parentId: null }], true);
    const placed = readTask(task.id)!.sortOrder;
    unarchiveTask(task.id);
    assert.equal(readTask(task.id)?.sortOrder, placed);
  } finally {
    deleteTask(task.id);
  }
});

test("an explicit sortOrder is still the caller's to state", () => {
  // The drag is the one writer that states positions, and `task_manage` may too.
  const task = createTask({
    title: "Positioned by its creator",
    sortOrder: 7,
    source: { createdBy: "agent" },
  });
  try {
    assert.equal(task.sortOrder, 7);
    updateTask(task.id, { sortOrder: 3 });
    assert.equal(readTask(task.id)?.sortOrder, 3);
  } finally {
    deleteTask(task.id);
  }
});

test("a reorder never detaches a child from an ARCHIVED parent", () => {
  // The Backlog cannot see an archived epic, so it draws the child at the root
  // and sends it back as a root placement. Honouring that would destroy the edge
  // the epic needs to come back with its subtasks — permanently, on the next
  // drag anywhere in the list.
  const epic = createTask({
    title: "Archived epic",
    source: { createdBy: "user" },
  });
  const child = createTask({
    title: "Its subtask",
    parentId: epic.id,
    source: { createdBy: "user" },
  });
  const other = createTask({
    title: "Another epic",
    source: { createdBy: "user" },
  });

  try {
    archiveTask(epic.id);
    reorderTasks([], [{ id: child.id, parentId: null }], true);
    assert.equal(readTask(child.id)?.parentId, epic.id, "edge kept");
    // And the epic comes back with its subtask under it.
    unarchiveTask(epic.id);
    assert.equal(readTask(child.id)?.parentId, epic.id);

    // A placement that NAMES a parent is a real decision and still moves it.
    reorderTasks([], [{ id: child.id, parentId: other.id }], true);
    assert.equal(readTask(child.id)?.parentId, other.id, "named parent moves");

    // With the parent visible, a root placement detaches as it always did.
    reorderTasks([], [{ id: child.id, parentId: null }], true);
    assert.equal(readTask(child.id)?.parentId, undefined, "visible parent");
  } finally {
    for (const t of [child, epic, other]) deleteTask(t.id);
  }
});

test("date shifting is DST-safe: tomorrow is never today", () => {
  // Instants around both European transitions, plus every hour of the 25-hour
  // autumn fallback day, which is where adding 86_400_000 ms silently failed.
  const instants: Date[] = [];
  for (let hour = 0; hour < 26; hour += 1) {
    instants.push(new Date(Date.UTC(2026, 9, 24, hour))); // around 25 Oct fallback
    instants.push(new Date(Date.UTC(2026, 2, 28, hour))); // around 29 Mar spring forward
  }

  for (const base of instants) {
    const today = shiftLocalDateKey(base, 0, "Europe/Berlin");
    const tomorrow = shiftLocalDateKey(base, 1, "Europe/Berlin");
    assert.notEqual(
      tomorrow,
      today,
      `tomorrow collapsed onto today at ${base.toISOString()}`,
    );
    // And it is exactly one calendar day, not two.
    assert.equal(
      shiftLocalDateKey(new Date(`${tomorrow}T12:00:00Z`), 0, "Europe/Berlin"),
      tomorrow,
    );
  }
});

test("markTaskProcessed is idempotent and never moves the first decision", () => {
  const arrived = createTask({
    title: "Arrived",
    source: { createdBy: "agent" },
  });
  const alreadyTriaged = createTask({
    title: "Typed",
    triaged: true,
    source: { createdBy: "user" },
  });
  const firstDecision = alreadyTriaged.triagedAt;

  try {
    assert.equal(readTask(arrived.id)?.triagedAt, undefined);
    markTaskProcessed(arrived.id);
    const at = readTask(arrived.id)?.triagedAt;
    assert.ok(at, "processing an arrival should triage it");

    // Re-processing must not move the timestamp: WHEN it was processed is a
    // fact about the first decision, not the most recent touch.
    markTaskProcessed(arrived.id);
    assert.equal(readTask(arrived.id)?.triagedAt, at);
    markTaskProcessed(alreadyTriaged.id);
    assert.equal(readTask(alreadyTriaged.id)?.triagedAt, firstDecision);

    // An unknown id is a no-op rather than a throw: triage is bookkeeping about
    // a command that already succeeded.
    markTaskProcessed("does-not-exist");
    markTaskProcessed("999999");
  } finally {
    deleteTask(arrived.id);
    deleteTask(alreadyTriaged.id);
  }
});

test("a subtask's project follows its parent on every write path", () => {
  const user = { createdBy: "user" as const };
  const agent = { createdBy: "agent" as const };
  const epic = createTask({ title: "Epic", projectId: "proj-a", source: user });
  const other = createTask({
    title: "Other epic",
    projectId: "proj-b",
    source: user,
  });

  // 1. Create: an agent filing a subtask states no project and still lands in
  // the parent's one.
  const child = createTask({
    title: "Subtask",
    parentId: epic.id,
    source: agent,
  });
  const grandchild = createTask({
    title: "Leaf",
    parentId: child.id,
    source: agent,
  });

  try {
    assert.equal(readTask(child.id)?.projectId, "proj-a", "create inherits");
    assert.equal(readTask(grandchild.id)?.projectId, "proj-a");

    // A project stated in the same write still wins over the parent's.
    const stated = createTask({
      title: "Stated",
      parentId: epic.id,
      projectId: "proj-b",
      source: agent,
    });
    assert.equal(readTask(stated.id)?.projectId, "proj-b", "explicit wins");
    deleteTask(stated.id);

    // 2. A drag in the Backlog reparents without touching `applyRelations`, and
    // moves the whole subtree.
    reorderTasks([], [{ id: child.id, parentId: other.id }], true);
    assert.equal(
      readTask(child.id)?.projectId,
      "proj-b",
      "drag moves the node",
    );
    assert.equal(readTask(grandchild.id)?.projectId, "proj-b", "and its tree");

    // 3. Fixing the epic fixes its tree — the operation done 8x by hand.
    reorderTasks([], [{ id: child.id, parentId: epic.id }], true);
    updateTask(epic.id, { projectId: "proj-c" });
    assert.equal(readTask(child.id)?.projectId, "proj-c");
    assert.equal(readTask(grandchild.id)?.projectId, "proj-c");
    // No upward cascade: a subtask's project says nothing about its epic.
    updateTask(grandchild.id, { projectId: "proj-b" });
    assert.equal(readTask(epic.id)?.projectId, "proj-c");
    assert.equal(readTask(child.id)?.projectId, "proj-c");

    // 4. The escape hatch stays explicit, and a clear does not wipe the subtree.
    updateTask(child.id, { projectId: null });
    assert.equal(readTask(child.id)?.projectId, undefined, "explicit clear");
    assert.equal(
      readTask(grandchild.id)?.projectId,
      "proj-b",
      "clear is local",
    );
    // An ordinary save that re-states the same parent is not a move, so the
    // deliberate unset survives it.
    updateTask(child.id, { title: "Subtask", parentId: epic.id });
    assert.equal(readTask(child.id)?.projectId, undefined);

    // Reparenting to the root, or under a parent with no project, leaves the
    // project alone rather than destroying it.
    updateTask(grandchild.id, { parentId: null });
    assert.equal(readTask(grandchild.id)?.projectId, "proj-b");
    updateTask(grandchild.id, { parentId: child.id });
    assert.equal(readTask(grandchild.id)?.projectId, "proj-b");
  } finally {
    for (const t of [grandchild, child, other, epic]) deleteTask(t.id);
  }
});

test("a session's Tasks are resolved from its own links, not by listing every Task", () => {
  const SESSION = "sess-task-links";
  const started = createTask({
    title: "Started from this session",
    source: { createdBy: "user" },
  });
  const referenced = createTask({
    title: "Merely referenced here",
    source: { createdBy: "user" },
  });
  const archived = createTask({
    title: "Linked but archived",
    source: { createdBy: "user" },
  });
  const unrelated = createTask({
    title: "Nothing to do with the session",
    source: { createdBy: "user" },
  });
  try {
    linkSessionToTask(started.id, {
      sessionId: SESSION,
      origin: "task-start",
    });
    linkSessionToTask(referenced.id, {
      sessionId: SESSION,
      origin: "reference",
    });
    linkSessionToTask(archived.id, { sessionId: SESSION });
    archiveTask(archived.id);

    const ids = listSessionTasks("assistant", SESSION).map((t) => t.id);
    assert.deepEqual(
      [...ids].sort(),
      [started.id, referenced.id].sort(),
      "exactly the linked, live Tasks — an archived link is not a linked Task",
    );
    assert.equal(
      ids.includes(unrelated.id),
      false,
      "and nothing that merely exists",
    );
    // The related list is the same set minus the one this session was started
    // for: that one is the origin back-link, not a reference.
    assert.deepEqual(
      listRelatedGlobalTasks("assistant", SESSION).map((t) => t.id),
      [referenced.id],
    );
    // It agrees with the whole-table list it replaced.
    assert.deepEqual(
      [...ids].sort(),
      listTasks()
        .filter((task) =>
          (task.sessionRefs ?? []).some((ref) => ref.sessionId === SESSION),
        )
        .map((task) => task.id)
        .sort(),
    );
    // A session with no links answers without touching the Task table at all.
    assert.deepEqual(listSessionTasks("assistant", "sess-with-no-tasks"), []);
  } finally {
    for (const t of [started, referenced, archived, unrelated])
      deleteTask(t.id);
  }
});
