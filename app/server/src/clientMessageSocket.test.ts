import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { attachClientMessageSocket } from "./clientMessageSocket.ts";
import { Connection } from "./connection.ts";
import { getDb } from "./db/index.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { hub } from "./hub.ts";
import { resetSessionListAuditBaselineForTests } from "./sessionsTopic.ts";
import { takeStateTopicInvariantsForTests } from "./stateTopicKernel.ts";

/** V3: use the same handler index installs, on an actual socket frame. */
test("the socket boundary converts an audit rejection but cannot hide its ledger entry", async () => {
  const id = "socket-invariant-quiet";
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    title: "before",
    messageCount: 2,
  });
  await hub.flushPendingBroadcastsForTests();
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  let connection: Connection | undefined;
  server.on("connection", (ws) => {
    connection = new Connection(ws);
    hub.register(connection);
    attachClientMessageSocket(ws, connection);
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  try {
    await once(client, "open");
    getDb()
      .prepare("UPDATE session_index SET title = ? WHERE id = ?")
      .run("behind the reporter", id);
    const answer = once(client, "message");
    client.send(JSON.stringify({ type: "subscribe", topics: ["sessions"] }));
    const [frame] = await answer;
    const reply = JSON.parse(String(frame)) as {
      type: string;
      message: string;
    };
    assert.equal(reply.type, "error");
    assert.match(reply.message, /unreported session row change/);
    const violations = takeStateTopicInvariantsForTests();
    assert.equal(violations.length, 1);
    assert.match(violations[0]!.message, new RegExp(`${id} title`));
  } finally {
    resetSessionListAuditBaselineForTests();
    if (connection) {
      hub.unregister(connection);
      connection.dispose();
    }
    const closed = once(client, "close");
    client.close();
    await closed;
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await hub.flushPendingBroadcastsForTests();
  }
});
