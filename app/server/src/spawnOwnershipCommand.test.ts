/**
 * The explicit Take over / Hand back command through a real connection: the
 * user's decision moves ownership, reaches every tab, and a session nothing
 * spawned is refused.
 *   pnpm --filter @assistant/server test src/spawnOwnershipCommand.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type {
  ClientMessage,
  ServerMessage,
  SessionListItem,
} from "@assistant/shared";
import { Connection } from "./connection.ts";
import { hub } from "./hub.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { validateClientMessage } from "./validateClientMessage.ts";

/** Minimal open socket: `Connection` only reads `readyState`/`OPEN` and sends. */
function fakeSocket(sent: ServerMessage[]) {
  return {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0];
}

/** The newest row this listener saw for the session, from a list or a delta. */
function rowFor(
  messages: ServerMessage[],
  id: string,
): SessionListItem | undefined {
  for (const message of [...messages].reverse()) {
    if (message.type === "sessionUpdated" && message.session.id === id)
      return message.session;
    if (message.type === "sessions") {
      const row = message.sessions.find((session) => session.id === id);
      if (row) return row;
    }
  }
  return undefined;
}

test("taking over and handing back move ownership and reach every tab", async () => {
  const stamp = Date.now();
  const coordinator = `own-cmd-root-${stamp}`;
  const peer = `own-cmd-peer-${stamp}`;
  const plain = `own-cmd-plain-${stamp}`;
  for (const id of [coordinator, peer, plain])
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "assistant",
      title: id,
      messageCount: 2,
    });
  sessionStore.linkSpawned(coordinator, peer);

  const clicked: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(clicked));
  const otherTab: ServerMessage[] = [];
  const viewer = { send: (message: ServerMessage) => otherTab.push(message) };
  hub.register(viewer);
  const send = (id: string, ownership: "taken-over" | "coordinator") =>
    connection.handle({
      type: "setSpawnOwnership",
      id,
      ownership,
    } as ClientMessage);

  try {
    await send(peer, "taken-over");
    await hub.flushPendingBroadcastsForTests();
    assert.equal(rowFor(otherTab, peer)?.spawnOwnership, "taken-over");

    await send(peer, "coordinator");
    await hub.flushPendingBroadcastsForTests();
    assert.equal(rowFor(otherTab, peer)?.spawnOwnership, "coordinator");

    // Repeating the current ownership changes nothing, so it broadcasts
    // nothing.
    otherTab.length = 0;
    await send(peer, "coordinator");
    await hub.flushPendingBroadcastsForTests();
    assert.equal(rowFor(otherTab, peer), undefined);
    assert.equal(
      clicked.some((message) => message.type === "error"),
      false,
      "both decisions were accepted",
    );

    // A session nothing spawned has no owner to set, and says so.
    await send(plain, "taken-over");
    assert.ok(
      clicked.some(
        (message) =>
          message.type === "error" && /spawned/.test(message.message),
      ),
    );
  } finally {
    hub.unregister(viewer as never);
    connection.dispose();
    for (const id of [coordinator, peer, plain]) sessionStore.remove(id);
  }
});

test("the command is validated at the wire", () => {
  for (const ownership of ["taken-over", "coordinator"])
    assert.equal(
      validateClientMessage({ type: "setSpawnOwnership", id: "s", ownership })
        .ok,
      true,
    );
  for (const bad of [
    { type: "setSpawnOwnership", id: "s", ownership: "unknown" },
    { type: "setSpawnOwnership", id: "s" },
    { type: "setSpawnOwnership", id: 7, ownership: "taken-over" },
    { type: "setSpawnOwnership", ownership: "taken-over" },
  ])
    assert.equal(validateClientMessage(bad).ok, false, JSON.stringify(bad));
});

test("a session the user cannot act on is refused, and nothing is written", async () => {
  const stamp = Date.now();
  const coordinator = `own-cmd-scope-root-${stamp}`;
  const internal = `own-cmd-internal-${stamp}`;
  const deleted = `own-cmd-deleted-${stamp}`;
  sessionStore.upsert({
    id: coordinator,
    harness: "pi",
    agentType: "assistant",
    title: coordinator,
  });
  sessionStore.upsert({
    id: internal,
    harness: "pi",
    agentType: "assistant",
    title: internal,
    scope: "internal",
  });
  sessionStore.upsert({
    id: deleted,
    harness: "pi",
    agentType: "assistant",
    title: deleted,
  });
  for (const id of [internal, deleted])
    sessionStore.linkSpawned(coordinator, id);
  sessionStore.markDeleted(deleted);
  const sent: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(sent));
  try {
    for (const id of [internal, deleted]) {
      await connection.handle({
        type: "setSpawnOwnership",
        id,
        ownership: "taken-over",
        requestId: `r-${id}`,
      } as ClientMessage);
      const error = sent.find(
        (message) =>
          message.type === "error" &&
          (message as { requestId?: string }).requestId === `r-${id}`,
      );
      assert.ok(error, `${id} is refused with a correlated error`);
      assert.equal(
        sessionStore.spawnedParentsByChildIds([id]).get(id)?.ownership,
        "coordinator",
        `${id}'s edge is untouched`,
      );
    }
  } finally {
    connection.dispose();
    for (const id of [coordinator, internal, deleted]) sessionStore.remove(id);
  }
});

test("a store failure is an error the browser recovers from, not a no-op", async () => {
  const stamp = Date.now();
  const coordinator = `own-cmd-fail-root-${stamp}`;
  const peer = `own-cmd-fail-peer-${stamp}`;
  for (const id of [coordinator, peer])
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "assistant",
      title: id,
    });
  sessionStore.linkSpawned(coordinator, peer);
  const sent: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(sent));
  const original = sessionStore.setSpawnedOwnership;
  sessionStore.setSpawnedOwnership = () => {
    throw new Error("disk full");
  };
  try {
    await connection.handle({
      type: "setSpawnOwnership",
      id: peer,
      ownership: "taken-over",
      requestId: "r-fail",
    } as ClientMessage);
    const error = sent.find((message) => message.type === "error") as
      | { requestId?: string; target?: { type: string; id?: string } }
      | undefined;
    assert.equal(error?.requestId, "r-fail");
    assert.deepEqual(error?.target, { type: "session", id: peer });
    assert.equal(
      sent.some((message) => message.type === "mutationSettled"),
      false,
      "a failed command is not settled as a success",
    );
  } finally {
    sessionStore.setSpawnedOwnership = original;
    connection.dispose();
    for (const id of [coordinator, peer]) sessionStore.remove(id);
  }
});

test("a failing first read is a session-targeted error, not an escape", async () => {
  const sent: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(sent));
  const original = sessionStore.get;
  sessionStore.get = () => {
    throw new Error("read failure");
  };
  try {
    await connection.handle({
      type: "setSpawnOwnership",
      id: "own-cmd-read-fail",
      ownership: "taken-over",
      requestId: "r-read",
    } as ClientMessage);
  } finally {
    sessionStore.get = original;
    connection.dispose();
  }
  const error = sent.find((message) => message.type === "error") as
    { requestId?: string; target?: { type: string; id?: string } } | undefined;
  assert.equal(error?.requestId, "r-read");
  assert.deepEqual(error?.target, { type: "session", id: "own-cmd-read-fail" });
  assert.equal(
    sent.some((message) => message.type === "mutationSettled"),
    false,
  );
});

test("a disabled harness does not stop the user taking a peer over", async () => {
  // Ownership is metadata: it never starts the agent, so the availability
  // guard run-starting commands apply (the Claude SDK is off by default in
  // tests) must not refuse it.
  const stamp = Date.now();
  const coordinator = `own-cmd-sdk-root-${stamp}`;
  const peer = `own-cmd-sdk-peer-${stamp}`;
  for (const id of [coordinator, peer])
    sessionStore.upsert({
      id,
      harness: "claude-sdk",
      agentType: "assistant",
      title: id,
    });
  sessionStore.linkSpawned(coordinator, peer);
  const sent: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(sent));
  try {
    await connection.handle({
      type: "setSpawnOwnership",
      id: peer,
      ownership: "taken-over",
      requestId: "r-sdk",
    } as ClientMessage);
    assert.equal(
      sent.some((message) => message.type === "error"),
      false,
      JSON.stringify(sent),
    );
    assert.equal(
      sessionStore.spawnedParentsByChildIds([peer]).get(peer)?.ownership,
      "taken-over",
    );
  } finally {
    connection.dispose();
    for (const id of [coordinator, peer]) sessionStore.remove(id);
  }
});
