/**
 * Regression test for session-config refusals reaching the client.
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/connectionSessionConfig.test.ts
 *
 * `setModel` and `setReasoning` are `void | PromiseLike<void>` seams: the
 * claude-sdk adapter answers synchronously, the pi adapter through an async
 * `LiveSession`. A bare try/catch around them therefore caught only half the
 * refusals, and the half it missed was not merely lost — an unhandled rejection
 * reaches `index.ts`'s `uncaughtException` guard, which exits the process. So
 * picking a model the pi profile registry cannot resolve took every live
 * session down instead of drawing "model is not available" on one picker.
 *
 * What is pinned here: a refusal arriving in EITHER shape becomes a targeted
 * `error` for the session whose control was used, and nothing escapes.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessage, ServerMessage } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "conn-session-config-test-"));
process.env.ASSISTANT_CWD = tmp;

const { Connection } = await import("./connection.ts");

const SESSION_ID = "s-config";

/** A connection with a captured send, a viewed session id, and a fake view. */
function makeConnection(view: Record<string, unknown>) {
  const sent: ServerMessage[] = [];
  const fakeWs = {
    OPEN: 1,
    readyState: 1,
    send: (s: string) => sent.push(JSON.parse(s) as ServerMessage),
  };
  const conn = new (
    Connection as unknown as new (ws: unknown) => Record<string, unknown>
  )(fakeWs);
  conn.runtimeView = view;
  // Only `sessionId` is read, to target the refusal at the right session.
  conn.viewing = { sessionId: SESSION_ID };
  return { conn, sent };
}

function errorsIn(sent: ServerMessage[]) {
  return sent.filter((m) => m.type === "error");
}

/**
 * Every shape a refusal can arrive in. Typed `() => unknown` on purpose: the
 * seam DECLARES `void | PromiseLike<void>`, and the third shape below is what
 * arrives when something less well-behaved than that declaration does — which
 * is the case an `instanceof Promise` test would wave through.
 */
const SHAPES: Array<{
  name: string;
  make: (message: string) => () => unknown;
}> = [
  {
    name: "a rejected promise (the pi adapter's async LiveSession)",
    make: (message) => () => Promise.reject(new Error(message)),
  },
  {
    name: "a synchronous throw (the claude-sdk adapter)",
    make: (message) => () => {
      throw new Error(message);
    },
  },
  {
    // `instanceof Promise` misses this one; the seam is duck-typed for it.
    name: "a thenable that is not a native Promise",
    make: (message) => () => ({
      then: (_resolve: unknown, reject?: (reason: unknown) => void) =>
        reject?.(new Error(message)),
    }),
  },
];

for (const shape of SHAPES) {
  test(`setModel refused as ${shape.name} reaches the client`, async () => {
    const refusal = "model is not available";
    const { conn, sent } = makeConnection({
      setModel: shape.make(refusal),
      setReasoning: () => {},
    });

    await (conn.handle as (m: ClientMessage) => Promise<void>)({
      type: "setModel",
      provider: "pi",
      id: "gone",
    } as ClientMessage);
    // A rejection settles on the microtask queue, one turn after `handle`.
    await Promise.resolve();

    const errors = errorsIn(sent);
    assert.equal(errors.length, 1, "exactly one refusal is reported");
    assert.equal(
      (errors[0] as { message?: string }).message,
      refusal,
      "the adapter's own words reach the user",
    );
    assert.deepEqual(
      (errors[0] as { target?: unknown }).target,
      { type: "session", id: SESSION_ID },
      "targeted at the session whose picker was used",
    );
  });

  test(`setReasoning refused as ${shape.name} reaches the client`, async () => {
    const refusal = "thinking level is not supported";
    const { conn, sent } = makeConnection({
      setModel: () => {},
      setReasoning: shape.make(refusal),
    });

    await (conn.handle as (m: ClientMessage) => Promise<void>)({
      type: "setThinkingLevel",
      level: "high",
    } as ClientMessage);
    await Promise.resolve();

    const errors = errorsIn(sent);
    assert.equal(errors.length, 1, "exactly one refusal is reported");
    assert.equal(
      (errors[0] as { message?: string }).message,
      refusal,
      "the adapter's own words reach the user",
    );
    assert.deepEqual(
      (errors[0] as { target?: unknown }).target,
      { type: "session", id: SESSION_ID },
      "targeted at the session whose control was used",
    );
  });
}

test("a session-config change that settles reports nothing", async () => {
  const { conn, sent } = makeConnection({
    setModel: () => Promise.resolve(),
    setReasoning: () => {},
  });

  await (conn.handle as (m: ClientMessage) => Promise<void>)({
    type: "setModel",
    provider: "pi",
    id: "fine",
  } as ClientMessage);
  await Promise.resolve();

  assert.deepEqual(errorsIn(sent), [], "success is silent");
});
