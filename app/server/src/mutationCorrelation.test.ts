import assert from "node:assert/strict";
import { test } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import { Connection } from "./connection.ts";
import { sessionStore } from "./db/sessionStore.ts";

/** Minimal open socket: `Connection` only reads `readyState`/`OPEN` and sends. */
function fakeSocket(sent: ServerMessage[]) {
  return {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0];
}

test("a requestId-carrying mutation is answered exactly once, to its own request", async () => {
  const sent: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(sent));

  // Failure: the error names the request that failed, so an optimistic client
  // rolls back that change rather than whichever one is oldest.
  await connection.handle({
    type: "saveProject",
    id: "no-such-project",
    patch: { name: "x" },
    requestId: "req-1",
  } as ClientMessage);
  const failure = sent.find((message) => message.type === "error");
  assert.ok(
    failure && failure.type === "error",
    "expected an error for the failed mutation",
  );
  assert.equal(failure.requestId, "req-1");
  assert.equal(
    sent.some((message) => message.type === "mutationSettled"),
    false,
    "a failed mutation must not also settle",
  );

  // Success: exactly one settle, carrying the same id.
  sent.length = 0;
  await connection.handle({
    type: "updateSettings",
    patch: {},
    requestId: "req-2",
  } as ClientMessage);
  const settled = sent.filter((message) => message.type === "mutationSettled");
  assert.equal(settled.length, 1);
  const only = settled[0];
  assert.ok(only && only.type === "mutationSettled");
  assert.equal(only.requestId, "req-2");

  // A command without a requestId is not correlated at all.
  sent.length = 0;
  await connection.handle({ type: "listTasks", request: {} } as ClientMessage);
  assert.equal(
    sent.some((message) => message.type === "mutationSettled"),
    false,
  );

  connection.dispose();
});

test("overlapping mutations each get their own outcome", async () => {
  const sent: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(sent));
  const id = `overlap-${Date.now()}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    title: "Overlapping",
    scope: "user",
  });

  // The socket does not await `handle`, so correlated commands interleave: the
  // invariant is that each outcome names its OWN request whatever order their
  // handlers finish in. (Which interleavings a connection-scoped field would get
  // wrong depends on where each handler happens to await, so this pins the
  // invariant rather than one schedule.)
  const first = connection.handle({
    type: "renameSession",
    id: "no-such-session",
    title: "x",
    requestId: "req-fast",
  } as ClientMessage);
  const second = connection.handle({
    type: "renameSession",
    id,
    title: "",
    requestId: "req-slow",
  } as ClientMessage);
  await Promise.all([first, second]);

  const errors = sent.filter(
    (message): message is Extract<ServerMessage, { type: "error" }> =>
      message.type === "error",
  );
  const settles = sent.filter(
    (message): message is Extract<ServerMessage, { type: "mutationSettled" }> =>
      message.type === "mutationSettled",
  );
  assert.deepEqual(
    errors.map((message) => message.requestId).sort(),
    ["req-fast", "req-slow"],
    "each failure names its own request",
  );
  assert.deepEqual(
    settles.map((message) => message.requestId),
    [],
    "a failed mutation is never also settled",
  );

  connection.dispose();
});
