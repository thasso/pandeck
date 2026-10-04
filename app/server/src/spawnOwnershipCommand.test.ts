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
  hub.register({ send: (message: ServerMessage) => otherTab.push(message) });
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
    connection.dispose();
    for (const id of [coordinator, peer, plain]) sessionStore.remove(id);
  }
});
