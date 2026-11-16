import assert from "node:assert/strict";
import { test } from "vitest";
import type { ServerMessage } from "@assistant/shared";
const { Connection } = await import("./connection.ts");
const { hub } = await import("./hub.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { validateClientMessage } = await import("./validateClientMessage.ts");
const { sessionRowIn, sessionTopicViewer } =
  await import("./test/sessionListClient.ts");

test("inspector command makes a session enterprise-only and refuses deleted and internal sessions", async () => {
  const id = "requires-enterprise-command";
  const internal = "requires-enterprise-internal";
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    messageCount: 2,
  });
  sessionStore.upsert({
    id: internal,
    harness: "pi",
    agentType: "assistant",
    scope: "internal",
  });
  const sent: ServerMessage[] = [];
  const other: ServerMessage[] = [];
  const connection = new Connection({
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw)),
  } as never);
  const viewer = sessionTopicViewer(other);
  hub.register(viewer);
  try {
    await connection.handle({
      type: "setSessionRequiresEnterprise",
      sessionId: id,
    });
    assert.equal(sessionStore.get(id)?.requiresEnterprise, true);
    assert.equal(sessionRowIn(other, id)?.requiresEnterprise, true);
    // Repeating it is harmless.
    await connection.handle({
      type: "setSessionRequiresEnterprise",
      sessionId: id,
    });
    assert.equal(sent.filter((msg) => msg.type === "error").length, 0);

    await connection.handle({
      type: "setSessionRequiresEnterprise",
      sessionId: internal,
    });
    assert.equal(sessionStore.get(internal)?.requiresEnterprise, undefined);
    assert.ok(
      sent.some(
        (msg) =>
          msg.type === "error" && /Only a user session/.test(msg.message),
      ),
    );

    const deleted = "requires-enterprise-deleted";
    sessionStore.upsert({ id: deleted, harness: "pi", agentType: "assistant" });
    sessionStore.markDeleted(deleted);
    await connection.handle({
      type: "setSessionRequiresEnterprise",
      sessionId: deleted,
    });
    assert.ok(
      sent.some(
        (msg) =>
          msg.type === "error" &&
          /deleted/.test(msg.message) &&
          msg.target?.type === "session" &&
          msg.target.id === deleted,
      ),
    );
    sessionStore.remove(deleted);
  } finally {
    hub.unregister(viewer as never);
    connection.dispose();
    sessionStore.remove(id);
    sessionStore.remove(internal);
  }
});

test("wire validation accepts only a session id", () => {
  assert.equal(
    validateClientMessage({
      type: "setSessionRequiresEnterprise",
      sessionId: "id",
    }).ok,
    true,
  );
  for (const bad of [
    { type: "setSessionRequiresEnterprise" },
    { type: "setSessionRequiresEnterprise", sessionId: 3 },
  ])
    assert.equal(validateClientMessage(bad).ok, false, JSON.stringify(bad));
});
