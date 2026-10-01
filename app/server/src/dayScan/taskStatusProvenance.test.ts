import assert from "node:assert/strict";
import { test } from "vitest";
import { createTask, deleteTask, updateTask } from "../tasks.ts";
import { taskStore } from "../db/taskStore.ts";

/**
 * Task mutation provenance (plan § Self-exclusion): the collector must be able
 * to distinguish a USER status change on a scanner-created Task (genuine
 * activity) from a scanner/agent projection update (excluded).
 */
test("user vs agent vs scanner status changes on the same Task carry distinct provenance", () => {
  const task = createTask({
    title: "Provenance probe",
    description: "",
    source: { createdBy: "user" },
  });
  try {
    updateTask(task.id, { status: "doing", actor: { kind: "user" } });
    // An agent status write the USER asked for is applied, and it carries agent
    // provenance. Unasked, it would be a suggestion instead (see below).
    updateTask(task.id, {
      status: "todo",
      userRequestedStatus: true,
      actor: { kind: "agent", id: "session-123" },
    });
    updateTask(task.id, {
      status: "doing",
      actor: { kind: "system", id: "day-scan" },
    });
    // No-op status patches never record an event.
    updateTask(task.id, { status: "doing", actor: { kind: "user" } });

    const events = taskStore.statusEventsForTask(Number(task.id));
    assert.equal(events.length, 3);
    assert.deepEqual(
      events.map((e) => [e.fromStatus, e.toStatus, e.actorKind, e.actorId]),
      [
        ["todo", "doing", "user", null],
        ["doing", "todo", "agent", "session-123"],
        ["todo", "doing", "system", "day-scan"],
      ],
    );
  } finally {
    deleteTask(task.id);
  }
});

test("an agent's completion records a suggestion rather than a status event", () => {
  const task = createTask({
    title: "Claim probe",
    description: "",
    source: { createdBy: "user" },
  });
  try {
    const claimed = updateTask(task.id, {
      status: "done",
      actor: { kind: "agent", id: "session-123" },
    });
    // Nothing changed status, so the collector sees no completion — which is
    // why `collectors/pa.ts` emits its own `task-done-proposed` fact instead.
    assert.equal(claimed.status, "todo");
    assert.equal(taskStore.statusEventsForTask(Number(task.id)).length, 0);
    assert.equal(claimed.statusSuggestion?.to, "done");
  } finally {
    deleteTask(task.id);
  }
});

test("status events are queryable by time window", () => {
  const task = createTask({
    title: "Window probe",
    description: "",
    source: { createdBy: "user" },
  });
  try {
    const before = Date.now() - 1000;
    updateTask(task.id, { status: "done", actor: { kind: "user" } });
    const after = Date.now() + 1000;
    const inWindow = taskStore
      .statusEventsInWindow(before, after)
      .filter((e) => e.taskId === Number(task.id));
    assert.equal(inWindow.length, 1);
    const outside = taskStore
      .statusEventsInWindow(after, after + 1000)
      .filter((e) => e.taskId === Number(task.id));
    assert.equal(outside.length, 0);
  } finally {
    deleteTask(task.id);
  }
});
