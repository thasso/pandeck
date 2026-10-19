import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { ServerMessage, SessionListItem } from "@assistant/shared";
const { Connection } = await import("./connection.ts");
const { hub } = await import("./hub.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { validateClientMessage } = await import("./validateClientMessage.ts");

test("inspector command persists, broadcasts explicit and reset caps, and refuses deleted sessions", async () => {
  const id = "cap-command";
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    messageCount: 2,
  });
  const sent: ServerMessage[] = [];
  const other: ServerMessage[] = [];
  const connection = new Connection({
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw)),
  } as never);
  const viewer = { send: (msg: ServerMessage) => other.push(msg) };
  hub.register(viewer);
  const seen = (): SessionListItem | undefined => {
    for (const msg of [...other].reverse()) {
      if (msg.type === "sessionUpdated" && msg.session.id === id)
        return msg.session;
      if (msg.type === "sessions")
        return msg.sessions.find((row) => row.id === id);
    }
    return undefined;
  };
  try {
    for (const cap of [8, null]) {
      await connection.handle({
        type: "setSessionPeerTurnCap",
        sessionId: id,
        cap,
      });
      assert.equal(sessionStore.get(id)?.peerTurnCap, cap ?? undefined);
      await vi.waitFor(async () => {
        await hub.flushPendingBroadcastsForTests();
        assert.ok(seen());
        assert.equal(seen()?.peerTurnCap, cap ?? undefined);
      });
    }
    assert.ok(seen(), "session update reached the other tab");
    sessionStore.markDeleted(id);
    await connection.handle({
      type: "setSessionPeerTurnCap",
      sessionId: id,
      cap: 8,
    });
    assert.ok(
      sent.some((msg) => msg.type === "error" && /deleted/.test(msg.message)),
    );
  } finally {
    hub.unregister(viewer as never);
    connection.dispose();
    sessionStore.remove(id);
  }
});

test("no agent tool exposes an existing-session cap setter", async () => {
  const { agentToolsFor } = await import("./tools/catalog.ts");
  for (const persona of [
    "assistant",
    "developer",
    "personal-assistant",
    "workshop",
  ] as const) {
    assert.equal(
      agentToolsFor(persona).some((tool) =>
        /set.*peer.*cap|peer.*cap.*set/i.test(tool.name),
      ),
      false,
    );
  }
});

test("wire cap validation is strict", () => {
  for (const cap of [1, 16, null])
    assert.equal(
      validateClientMessage({
        type: "setSessionPeerTurnCap",
        sessionId: "id",
        cap,
      }).ok,
      true,
    );
  for (const cap of [undefined, 0, 17, 1.5, "4", NaN])
    assert.equal(
      validateClientMessage({
        type: "setSessionPeerTurnCap",
        sessionId: "id",
        cap,
      }).ok,
      false,
    );
  assert.equal(
    validateClientMessage({ type: "setSessionPeerTurnCap", cap: 8 }).ok,
    false,
  );
});
