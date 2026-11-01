/**
 * A refused command re-publishes the authoritative row before its error, at a
 * new revision, with no other write needed to make it differ
 * (`docs/session-list.md`, "Republishing a row"). An archived row and the
 * singleton travel only as a `delete`, never as a row.
 *   pnpm --filter @assistant/server test src/sessionListForcedRefresh.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import { Connection } from "./connection.ts";
import { hub } from "./hub.ts";
import { backgroundWorkStore } from "./db/backgroundWorkStore.ts";
import { permanentAssistantStore } from "./db/permanentAssistantStore.ts";
import { sessionStore } from "./db/sessionStore.ts";
import {
  sessionEventsIn,
  sessionTopicViewer,
} from "./test/sessionListClient.ts";

let serial = 0;
const plain: ServerMessage[] = [];
const plainViewer = sessionTopicViewer(plain);

beforeEach(() => {
  hub.register(plainViewer);
});

afterEach(async () => {
  hub.unregister(plainViewer);
  await hub.flushPendingBroadcastsForTests();
});

function seed(label: string): string {
  serial += 1;
  const id = `forced-${label}-${Date.now()}-${serial}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    title: `${label} ${serial}`,
    scope: "user",
    messageCount: 2,
  });
  return id;
}

/** Live background work: what blocks both settle and delete. */
function runningWork(owner: string): void {
  serial += 1;
  const item = backgroundWorkStore.reserveItem({
    ownerSessionId: owner,
    backend: "host-process",
    kind: "shell",
    label: "pnpm run build",
    sourceRequestId: `toolu_forced_${serial}`,
    lifetimeMs: 60 * 60 * 1000,
    settingsGeneration: 1,
    bootEpoch: "boot-forced",
    ownerLimit: 1_000,
  });
  backgroundWorkStore.markRunning({ itemId: item.id });
}

function fakeSocket(sent: ServerMessage[]) {
  return {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0];
}

/** A drained baseline, then the clicking tab's command. */
async function refused(command: ClientMessage): Promise<ServerMessage[]> {
  const clicked: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(clicked));
  // A connected tab without `init`'s snapshots.
  hub.register(connection);
  try {
    await connection.handle({ type: "subscribe", topics: ["sessions"] });
    await hub.flushPendingBroadcastsForTests();
    clicked.length = 0;
    plain.length = 0;
    await connection.handle(command);
    await hub.flushPendingBroadcastsForTests();
    return clicked;
  } finally {
    hub.unregister(connection);
  }
}

const eventsFor = (messages: ServerMessage[], id: string) =>
  sessionEventsIn(messages).filter((event) => event.id === id);
const rowsFor = (messages: ServerMessage[], id: string) =>
  eventsFor(messages, id).filter((event) => event.kind === "upsert");

/** The row arrived, then the error, on the clicking tab. */
function rowBeforeError(clicked: ServerMessage[], id: string): void {
  const row = clicked.findIndex(
    (message) =>
      message.type === "stateEvents" &&
      message.topic === "sessions" &&
      message.events.some(
        (event) => event.kind === "upsert" && event.id === id,
      ),
  );
  const error = clicked.findIndex((message) => message.type === "error");
  assert.ok(row >= 0, `the authoritative row for ${id} was sent`);
  assert.ok(error > row, "and the error after it");
}

describe("a refused command re-sends the unchanged row first", () => {
  test("a blocked settle", async () => {
    const id = seed("settle");
    runningWork(id);
    const clicked = await refused({
      type: "settleSession",
      id,
      settled: true,
      throughRevision: 0,
    } as ClientMessage);
    rowBeforeError(clicked, id);
    assert.equal(rowsFor(plain, id).length, 1);
  });

  test("a refused delete", async () => {
    const id = seed("delete");
    runningWork(id);
    const clicked = await refused({
      type: "deleteSession",
      id,
    } as ClientMessage);
    rowBeforeError(clicked, id);
    assert.ok(sessionStore.get(id), "not deleted");
    assert.equal(rowsFor(plain, id).length, 1);
  });

  test("a stale dismissal", async () => {
    const id = seed("dismiss");
    const failedAt = Date.now();
    sessionStore.recordRunFailure(id, "boom", failedAt);
    const clicked = await refused({
      type: "dismissSessionFailure",
      id,
      errorAt: failedAt - 1,
      outcomeRevision: 0,
    } as ClientMessage);
    rowBeforeError(clicked, id);
    assert.equal(rowsFor(plain, id).length, 1);
  });

  test("an archived row travels only as a delete", async () => {
    const id = seed("archived-delete");
    sessionStore.setArchived(id, true);
    runningWork(id);
    const clicked = await refused({
      type: "deleteSession",
      id,
    } as ClientMessage);
    assert.ok(clicked.some((message) => message.type === "error"));
    assert.equal(rowsFor(clicked, id).length, 0);
    assert.deepEqual(
      eventsFor(plain, id).map((event) => event.kind),
      ["delete"],
    );
  });

  test("the singleton's row never travels, not even republished", async () => {
    const previous = permanentAssistantStore.sessionId();
    const id = seed("singleton");
    permanentAssistantStore.setSessionId(id);
    try {
      await hub.flushPendingBroadcastsForTests();
      plain.length = 0;
      hub.republishSessionRow(id);
      assert.deepEqual(rowsFor(plain, id), []);
      assert.deepEqual(
        eventsFor(plain, id).map((event) => event.kind),
        ["delete"],
      );
    } finally {
      if (previous) permanentAssistantStore.setSessionId(previous);
      else permanentAssistantStore.clearSessionId();
    }
  });
});
