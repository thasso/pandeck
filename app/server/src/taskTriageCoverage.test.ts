import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import { Connection, tasksProcessedByUserCommand } from "./connection.ts";
import { createTask, deleteTask, readTask } from "./tasks.ts";

/**
 * The "any user decision triages" invariant is only as good as its coverage, and
 * threading an actor by hand is exactly what kept producing one-off holes. This
 * asserts that EVERY Task-related client command the dispatcher handles has a
 * deliberate answer in `tasksProcessedByUserCommand` — either the Task it
 * processes, or an explicit exclusion — so adding a new one without deciding
 * fails here rather than silently leaving arrivals stuck in the Inbox.
 */

/** Commands that deliberately process NOTHING, with the reason they do not. */
const DELIBERATE_EXCLUSIONS: Record<string, string> = {
  listTasks: "a read",
  getTask: "a read — merely opening a Task must not empty the Inbox",
  deleteTask: "the Task is gone; there is nothing to triage",
  reorderTasks:
    "handled in the domain: only a real reparent triages, not renumbered siblings",
  resolvePullRequestCardTask:
    "picks which linked Task a pull-request card's title/body draw from; it does not act ON that Task",
};

function taskCommandTypesInDispatcher(): string[] {
  const source = readFileSync(
    new URL("./connection.ts", import.meta.url),
    "utf8",
  );
  const cases = [...source.matchAll(/case "([A-Za-z]+)":/g)].map((m) => m[1]!);
  const isTaskCommand = (type: string) =>
    /task/i.test(type) && !/^harness/.test(type);
  return [...new Set(cases.filter(isTaskCommand))];
}

test("every Task command the dispatcher handles has a triage decision", () => {
  const commands = taskCommandTypesInDispatcher();
  // Guard the guard: if the scrape stops finding commands, this test is inert.
  assert.ok(
    commands.length >= 8,
    `expected to find the Task commands, found ${commands.length}: ${commands.join(", ")}`,
  );

  const undecided: string[] = [];
  for (const type of commands) {
    // A representative message; the mapper only reads the id-bearing fields.
    const msg = {
      type,
      id: "1",
      taskId: "1",
      request: { id: "1" },
      updates: [{ id: "1", projectId: null }],
    } as unknown as ClientMessage;
    const processed = tasksProcessedByUserCommand(msg);
    if (processed.length === 0 && !(type in DELIBERATE_EXCLUSIONS))
      undecided.push(type);
  }

  assert.deepEqual(
    undecided,
    [],
    `these Task commands neither triage nor are listed as deliberate exclusions: ${undecided.join(", ")}. ` +
      "Add a case to `tasksProcessedByUserCommand`, or record why it processes nothing.",
  );
});

test("the commands that DO process a Task name it", () => {
  const cases: Array<[ClientMessage, string[]]> = [
    [
      {
        type: "saveTask",
        request: { id: "7", title: "x", status: "todo" },
      } as unknown as ClientMessage,
      ["7"],
    ],
    // A create is typed straight into the Backlog and triaged at birth instead.
    [
      {
        type: "saveTask",
        request: { title: "new", status: "todo" },
      } as unknown as ClientMessage,
      [],
    ],
    // Putting a Task BACK is the one save that must not process it.
    [
      {
        type: "saveTask",
        request: { id: "7", title: "x", status: "todo", triaged: false },
      } as unknown as ClientMessage,
      [],
    ],
    [
      {
        type: "saveTask",
        request: { id: "7", title: "x", status: "todo", triaged: true },
      } as unknown as ClientMessage,
      ["7"],
    ],
    [{ type: "archiveTask", id: "8" } as unknown as ClientMessage, ["8"]],
    [
      {
        type: "assignTaskProjects",
        updates: [
          { id: "14", projectId: "p" },
          { id: "15", projectId: null },
        ],
      } as unknown as ClientMessage,
      ["14", "15"],
    ],
  ];

  for (const [msg, expected] of cases) {
    assert.deepEqual(
      tasksProcessedByUserCommand(msg),
      expected,
      `wrong triage targets for ${msg.type}`,
    );
  }
});

test("reads never process a Task", () => {
  for (const type of ["listTasks", "getTask"]) {
    const msg = {
      type,
      id: "1",
      taskId: "1",
      request: {},
    } as unknown as ClientMessage;
    assert.deepEqual(
      tasksProcessedByUserCommand(msg),
      [],
      `${type} must not triage`,
    );
  }
});

/** Minimal open socket, as in `mutationCorrelation.test.ts`. */
function fakeSocket(sent: ServerMessage[]) {
  return {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0];
}

test("Task detail reads echo correlation", async () => {
  const sent: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(sent));
  const task = createTask({
    title: "Correlated Task read",
    status: "todo",
    source: { createdBy: "user" },
  });

  try {
    await connection.handle({
      type: "getTask",
      id: task.id,
      requestId: "detail-generation-2",
    });
    const detail = sent.find((message) => message.type === "taskDetail");
    assert.ok(detail && detail.type === "taskDetail");
    assert.equal(detail.requestId, "detail-generation-2");
    assert.equal(detail.item?.id, task.id);

    await connection.handle({
      type: "getTask",
      id: "not-a-task",
      requestId: "detail-missing",
    });
    const missing = sent.find(
      (message) =>
        message.type === "taskDetail" && message.requestId === "detail-missing",
    );
    assert.ok(missing && missing.type === "taskDetail");
    assert.equal(missing.item, null);
    assert.equal(missing.error, undefined, "not-found is not a read failure");
  } finally {
    deleteTask(task.id);
    connection.dispose();
  }
});

/**
 * The mapper is only half the invariant; `handle` has to call it, and ONLY for a
 * command that succeeded. Driven through a real `Connection` rather than
 * asserted against the source, because the bug this guards was invisible to a
 * source read: most Task commands carry no `requestId`, `handle` only opened a
 * `MutationScope` for the ones that did, and a handler reports failure by
 * SENDING an error rather than throwing — so with no scope there was nothing to
 * record the refusal, and the Task was processed out of the Inbox anyway.
 */
test("an uncorrelated command that FAILS does not process the Task", async () => {
  const sent: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(sent));
  const task = createTask({
    title: "Arrival for a refused save",
    status: "todo",
    source: { createdBy: "agent" },
  });

  try {
    // No requestId, and a blank title: the handler catches and sends an error.
    await connection.handle({
      type: "saveTask",
      request: { id: task.id, title: " ", status: "todo" },
    } as ClientMessage);

    assert.ok(
      sent.some((message) => message.type === "error"),
      "expected the refused save to report an error",
    );
    assert.equal(
      readTask(task.id)?.triagedAt,
      undefined,
      "a refused command is not a decision about the Task",
    );

    // The same command, accepted, DOES process it — so the gate discriminates
    // rather than simply never triaging on this path.
    await connection.handle({
      type: "saveTask",
      request: { id: task.id, title: "Renamed", status: "todo" },
    } as ClientMessage);
    assert.ok(
      readTask(task.id)?.triagedAt,
      "a successful save must process the Task",
    );
  } finally {
    deleteTask(task.id);
    connection.dispose();
  }
});

/**
 * Restoring a Task to the Inbox is a real operation on the wire
 * (`TaskSaveRequest.triaged === false`), and the central mapper used to undo it
 * one line after the handler performed it: the save cleared `triagedAt`, then
 * `handle` processed the Task for having been edited. Driven through a real
 * `Connection`, since that interaction is invisible to either half alone —
 * the domain test and the mapper test both passed while restore was impossible.
 */
test("an explicit put-back outranks the implicit any-edit processing", async () => {
  const sent: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(sent));
  const task = createTask({
    title: "Restorable",
    status: "todo",
    source: { createdBy: "user" },
    triaged: true,
  });

  try {
    assert.ok(readTask(task.id)?.triagedAt, "a typed Task starts processed");

    const save = (patch: Record<string, unknown>) =>
      connection.handle({
        type: "saveTask",
        request: { id: task.id, title: "Restorable", status: "todo", ...patch },
      } as unknown as ClientMessage);

    // Put it back: it must still be waiting afterwards.
    await save({ triaged: false });
    assert.equal(
      readTask(task.id)?.triagedAt,
      undefined,
      "an explicit restore must survive its own save",
    );

    // An ordinary edit processes it again — the implicit rule still holds.
    await save({ title: "Renamed" });
    assert.ok(
      readTask(task.id)?.triagedAt,
      "editing a waiting Task processes it",
    );

    // And so does an explicit dismiss, from either starting state.
    await save({ triaged: false });
    assert.equal(readTask(task.id)?.triagedAt, undefined);
    await save({ triaged: true });
    assert.ok(readTask(task.id)?.triagedAt, "an explicit dismiss processes it");
  } finally {
    deleteTask(task.id);
    connection.dispose();
  }
});
