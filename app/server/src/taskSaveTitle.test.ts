import assert from "node:assert/strict";
import { test } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import { Connection } from "./connection.ts";
import { createTask, deleteTask, readTask, updateTask } from "./tasks.ts";
import { validateClientMessage } from "./validateClientMessage.ts";

/**
 * `TaskSaveRequest.title` is REQUIRED on a create and optional on an update.
 * The reason is a real bug rather than tidiness: a surface answering an agent's
 * status suggestion may be a recorded transcript card whose title is frozen at
 * mutation time, so echoing a title back would rename a Task that has since been
 * renamed — and nobody pressing "Confirm done" means to rename anything.
 */

/** Minimal open socket, as in `taskTriageCoverage.test.ts`. */
function fakeSocket(sent: ServerMessage[]) {
  return {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0];
}

test("a save with no title leaves the stored title alone", async () => {
  const sent: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(sent));
  const task = createTask({
    title: "Original title",
    status: "doing",
    source: { createdBy: "user" },
  });

  try {
    // An agent suggests done, then the Task is renamed — the state a stale card
    // in the transcript cannot see.
    updateTask(task.id, {
      status: "done",
      actor: { kind: "agent", id: "sess-1" },
    });
    updateTask(task.id, { title: "Renamed by the user" });

    // Exactly what `acceptStatusSuggestionSave` puts on the wire.
    await connection.handle({
      type: "saveTask",
      request: { id: task.id, status: "done", clearStatusSuggestion: true },
    } as ClientMessage);

    assert.ok(
      !sent.some((message) => message.type === "error"),
      `a titleless update must be accepted: ${JSON.stringify(sent.filter((m) => m.type === "error"))}`,
    );
    const saved = readTask(task.id);
    assert.equal(saved?.title, "Renamed by the user");
    assert.equal(saved?.status, "done");
    assert.equal(saved?.statusSuggestion, undefined);
  } finally {
    deleteTask(task.id);
    connection.dispose();
  }
});

test("a save that carries a blank title is refused instead of blanking it", async () => {
  const sent: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(sent));
  const task = createTask({
    title: "Keeps its name",
    status: "todo",
    source: { createdBy: "user" },
  });

  try {
    await connection.handle({
      type: "saveTask",
      request: { id: task.id, title: "   " },
    } as ClientMessage);

    assert.ok(
      sent.some((message) => message.type === "error"),
      "an empty title must report an error",
    );
    assert.equal(readTask(task.id)?.title, "Keeps its name");
  } finally {
    deleteTask(task.id);
    connection.dispose();
  }
});

test("validation requires a title only when creating", () => {
  assert.equal(
    validateClientMessage({
      type: "saveTask",
      request: { id: "7", status: "done" },
    }).ok,
    true,
  );
  assert.equal(
    validateClientMessage({ type: "saveTask", request: { status: "todo" } }).ok,
    false,
  );
  assert.equal(
    validateClientMessage({
      type: "saveTask",
      request: { id: "7", title: 7 },
    }).ok,
    false,
  );
});
