/**
 * `settleInitiative` over the socket (docs/initiatives.md, The attention list):
 * the validator requires the observed revision, the handler writes the
 * clamped acknowledgement and answers through the `initiatives` topic as an
 * ordinary event, and a refusal names the Initiative with the request's id so
 * the browser can re-read what it settled optimistically. The summary also
 * carries the card's next open milestone, which moves with its Tasks.
 *   pnpm --filter @assistant/server test src/initiativeSettleMessage.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type {
  ClientMessage,
  InitiativeSummary,
  ServerMessage,
  StateEvent,
} from "@assistant/shared";
import { Connection } from "./connection.ts";
import { hub } from "./hub.ts";
import { validateClientMessage } from "./validateClientMessage.ts";
import {
  createInitiative,
  initiativeSummaryFor,
  setInitiativeMilestones,
  updateInitiative,
} from "./initiatives.ts";
import { archiveTask, createTask, updateTask } from "./tasks.ts";

function makeConnection() {
  const sent: ServerMessage[] = [];
  const fakeWs = {
    OPEN: 1,
    readyState: 1,
    send: (source: string) => sent.push(JSON.parse(source) as ServerMessage),
  };
  const connection = new (
    Connection as unknown as new (ws: unknown) => {
      handle(msg: ClientMessage): Promise<void>;
    }
  )(fakeWs);
  return { connection, sent };
}

function valid(message: ClientMessage): ClientMessage {
  const parsed = JSON.parse(JSON.stringify(message)) as ClientMessage;
  const verdict = validateClientMessage(parsed);
  assert.ok(verdict.ok, `rejected: ${JSON.stringify(verdict)}`);
  return parsed;
}

function initiativeEvents(messages: ServerMessage[]) {
  return messages.flatMap((message) =>
    message.type === "stateEvents" && message.topic === "initiatives"
      ? (message.events as StateEvent<InitiativeSummary>[])
      : [],
  );
}

test("settleInitiative requires the observed attention revision", () => {
  for (const throughRevision of [0, 3])
    assert.equal(
      validateClientMessage({
        type: "settleInitiative",
        id: "7",
        throughRevision,
      }).ok,
      true,
    );
  assert.equal(
    validateClientMessage({ type: "settleInitiative", id: "7" }).ok,
    false,
    "omitting it is refused rather than acknowledging whatever is stored",
  );
  for (const throughRevision of [-1, 1.5, "2", null])
    assert.equal(
      validateClientMessage({
        type: "settleInitiative",
        id: "7",
        throughRevision,
      }).ok,
      false,
      `${String(throughRevision)} is not a revision`,
    );
});

test("a Settle travels back as one initiatives event to every subscriber", async () => {
  const id = String(
    createInitiative({ title: "Socket settle", state: "done" }).initiative.id,
  );
  updateInitiative(id, { state: "paused" });
  await hub.flushPendingBroadcastsForTests();
  const laptop: ServerMessage[] = [];
  const viewer = {
    send: (message: ServerMessage) => laptop.push(message),
    wantsTopic: (topic: string) => topic === "initiatives",
  };
  hub.register(viewer);
  try {
    const phone = makeConnection();
    // The phone's card rendered revision 1; revision 2 has landed since.
    await phone.connection.handle(
      valid({
        type: "settleInitiative",
        id,
        throughRevision: 1,
        requestId: "settle-stale",
      }),
    );
    assert.ok(
      phone.sent.some(
        (message) =>
          message.type === "mutationSettled" &&
          message.requestId === "settle-stale",
      ),
    );
    await hub.flushPendingBroadcastsForTests();
    const [stale] = initiativeEvents(laptop);
    assert.ok(stale?.kind === "upsert");
    assert.deepEqual(stale.item.attention, {
      ...stale.item.attention,
      revision: 2,
      settledRevision: 1,
    });

    laptop.length = 0;
    await phone.connection.handle(
      valid({ type: "settleInitiative", id, throughRevision: 2 }),
    );
    await hub.flushPendingBroadcastsForTests();
    const [current] = initiativeEvents(laptop);
    assert.ok(current?.kind === "upsert");
    assert.equal(current.item.attention?.settledRevision, 2);
    assert.ok(current.revision > stale.revision);
  } finally {
    hub.unregister(viewer);
  }
});

test("a refused Settle names the Initiative and carries the request id", async () => {
  const { connection, sent } = makeConnection();
  await connection.handle(
    valid({
      type: "settleInitiative",
      id: "987654",
      throughRevision: 1,
      requestId: "settle-missing",
    }),
  );
  const error = sent.find((message) => message.type === "error");
  assert.ok(error?.type === "error");
  assert.deepEqual(error.target, { type: "initiative", id: "987654" });
  assert.equal(error.requestId, "settle-missing");
  assert.match(error.message, /Failed to settle Initiative: .*not found/);
  assert.ok(
    !sent.some((message) => message.type === "mutationSettled"),
    "a refused command does not settle",
  );
});

test("the next open milestone follows member order and the Tasks' own state", () => {
  const epic = createTask({
    title: "Milestone epic",
    source: { createdBy: "user" },
  });
  const first = createTask({
    title: "First hosted release",
    source: { createdBy: "user" },
    parentId: epic.id,
  });
  const second = createTask({
    title: "General availability",
    source: { createdBy: "user" },
  });
  const id = String(
    createInitiative({ title: "Milestones", taskIds: [epic.id, second.id] })
      .initiative.id,
  );
  assert.equal(initiativeSummaryFor(id)!.nextMilestone, undefined);

  // The user's member order of the marks decides: `second` keeps its edge's
  // place, and the covered `first` gets a marked edge appended after it.
  setInitiativeMilestones(id, [second.id], true);
  setInitiativeMilestones(id, [first.id], true);
  assert.deepEqual(initiativeSummaryFor(id)!.nextMilestone, {
    id: second.id,
    title: "General availability",
  });

  updateTask(second.id, { status: "done", actor: { kind: "user" } });
  assert.deepEqual(initiativeSummaryFor(id)!.nextMilestone, {
    id: first.id,
    title: "First hosted release",
  });
  updateTask(first.id, { title: "First hosted release (L7)" });
  assert.equal(
    initiativeSummaryFor(id)!.nextMilestone?.title,
    "First hosted release (L7)",
    "a title is the Task's own, not parsed",
  );
  archiveTask(first.id);
  assert.equal(
    initiativeSummaryFor(id)!.nextMilestone,
    undefined,
    "an archived open milestone is shelved, not next",
  );
});
