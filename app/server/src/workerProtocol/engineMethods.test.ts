import assert from "node:assert/strict";
import { test } from "vitest";
import { INVALID_PARAMS } from "./checkoutMethods.ts";
import {
  FrameDecoder,
  MessageAssembler,
  encodeMessage,
  type Payload,
} from "./codec.ts";
import { WorkerMethodError } from "./connection.ts";
import {
  ENGINE_METHODS,
  decodeEngineCommand,
  decodeEngineCommandAnswer,
  decodeEngineDispose,
  decodeEngineEvents,
  decodeEngineOpen,
  decodeEngineOpened,
  encodeEngineCommand,
  encodeEngineCommandAnswer,
  encodeEngineDispose,
  encodeEngineEvents,
  encodeEngineOpen,
  encodeEngineOpened,
} from "./engineMethods.ts";
import { WORKER_PROTOCOL_VERSION } from "./version.ts";

/** `payload` through the real framing, as the peer receives it. */
function wire(payload: Payload): Payload {
  const decoder = new FrameDecoder();
  const assembler = new MessageAssembler();
  let received: Payload | undefined;
  for (const frame of encodeMessage(
    "request",
    1,
    { method: ENGINE_METHODS.command },
    payload,
  ))
    decoder.push(frame, (decoded) => {
      if (decoded.type === "data") assembler.data(decoded);
      else if (decoded.type === "request")
        received = assembler.complete(decoded);
    });
  assert.ok(received);
  return received;
}

const LONE = "a\uD800b";

function assertInvalid(run: () => unknown, message: RegExp): void {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof WorkerMethodError &&
      error.code === INVALID_PARAMS &&
      message.test(error.message),
  );
}

test("protocol 1.8 adds the four engine methods", () => {
  assert.equal(WORKER_PROTOCOL_VERSION, "1.8");
  assert.deepEqual(Object.values(ENGINE_METHODS).sort(), [
    "engine.command",
    "engine.dispose",
    "engine.events",
    "engine.open",
  ]);
});

test("open, command, dispose and events round-trip through the real codec", () => {
  const spec = { kind: "assistant", text: LONE, nested: { list: [1, null] } };
  assert.deepEqual(
    decodeEngineOpen(
      wire(encodeEngineOpen({ engineId: 7, harness: "pi", spec })),
    ),
    { engineId: 7, harness: "pi", spec },
  );
  assert.deepEqual(
    decodeEngineOpened(
      wire(encodeEngineOpened({ info: { id: LONE }, snapshot: [1], seq: 0 })),
    ),
    { info: { id: LONE }, snapshot: [1], seq: 0 },
  );
  const command = {
    engineId: 7,
    commandId: 3,
    command: "submit",
    args: [LONE, [], { steer: true }],
  };
  assert.deepEqual(
    decodeEngineCommand(wire(encodeEngineCommand(command))),
    command,
  );
  assert.deepEqual(
    decodeEngineDispose(
      wire(
        encodeEngineDispose({
          engineId: 7,
          discard: { removeFile: { except: LONE } },
        }),
      ),
    ),
    { engineId: 7, discard: { removeFile: { except: LONE } } },
  );
  assert.deepEqual(
    decodeEngineDispose(wire(encodeEngineDispose({ engineId: 7 }))),
    {
      engineId: 7,
    },
  );
  const items = [
    { seq: 4, kind: "event", event: { type: "agent_start" } },
    { seq: 5, kind: "disposition", commandId: 3, disposition: "started" },
  ];
  assert.deepEqual(
    decodeEngineEvents(wire(encodeEngineEvents({ engineId: 7, items }))),
    { engineId: 7, items },
  );
});

test("a command answer names its seq on success and on failure", () => {
  assert.deepEqual(
    decodeEngineCommandAnswer(
      wire(encodeEngineCommandAnswer({ seq: 9, result: { ok: LONE } })),
    ),
    { seq: 9, result: { ok: LONE } },
  );
  const failed = wire(
    encodeEngineCommandAnswer({
      seq: 10,
      error: { code: "steer_not_taken", message: `refused ${LONE}` },
    }),
  );
  // The message travels as text, exact to the code unit.
  assert.equal(failed.text?.message, `refused ${LONE}`);
  assert.deepEqual(decodeEngineCommandAnswer(failed), {
    seq: 10,
    error: { code: "steer_not_taken", message: `refused ${LONE}` },
  });
  assert.deepEqual(
    decodeEngineCommandAnswer(
      wire(encodeEngineCommandAnswer({ seq: 0, error: { message: "plain" } })),
    ),
    { seq: 0, error: { message: "plain" } },
  );
});

test("malformed requests are typed errors and malformed answers are not trusted", () => {
  assertInvalid(
    () => decodeEngineOpen({ json: { engineId: 0, harness: "pi" } }),
    /engine id/,
  );
  assertInvalid(
    () => decodeEngineOpen({ json: { engineId: 1, harness: "" } }),
    /harness/,
  );
  assertInvalid(
    () =>
      decodeEngineCommand({
        json: { engineId: 1, commandId: 1.5, command: "x" },
      }),
    /command id/,
  );
  assertInvalid(
    () => decodeEngineCommand({ json: { engineId: 1, commandId: 1 } }),
    /command/,
  );
  assertInvalid(
    () =>
      decodeEngineDispose({
        json: { engineId: 1, discard: { removeFile: { except: 3 } } },
      }),
    /discard/,
  );
  assertInvalid(
    () => decodeEngineEvents({ json: { engineId: 1, items: [] } }),
    /items/,
  );
  assertInvalid(
    () =>
      decodeEngineEvents({
        json: {
          engineId: 1,
          items: [
            { seq: 2, kind: "state" },
            { seq: 2, kind: "state" },
          ],
        },
      }),
    /item seq/,
  );
  assertInvalid(
    () =>
      decodeEngineEvents({
        json: { engineId: 1, items: [{ seq: 1, kind: 4 }] },
      }),
    /item kind/,
  );
  assert.throws(
    () => decodeEngineOpened({ json: { info: {} } }),
    /malformed engine open answer/,
  );
  assert.throws(
    () => decodeEngineCommandAnswer({ json: { seq: 1, failed: true } }),
    /malformed engine command failure/,
  );
  assert.throws(
    () => decodeEngineCommandAnswer({ json: { seq: -1, result: 1 } }),
    /malformed engine command answer/,
  );
});
