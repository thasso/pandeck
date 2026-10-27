import assert from "node:assert/strict";
import { test } from "vitest";
import { INVALID_PARAMS } from "./checkoutMethods.ts";
import { FrameDecoder, MessageAssembler, encodeMessage } from "./codec.ts";
import type { Payload } from "./codec.ts";
import { WorkerMethodError } from "./connection.ts";
import { MalformedWorkerAnswerError } from "./fileMethods.ts";
import {
  AnsweredWatchFailure,
  decodeEvents,
  decodeSubscribe,
  decodeUnsubscribe,
  decodeWatchOutcome,
  encodeEvents,
  encodeSubscribe,
  encodeUnsubscribe,
  encodeWatchDone,
  encodeWatchFailure,
  type WatchDelivery,
} from "./watchMethods.ts";

/** `payload` through the real framing, as the peer receives it. */
function wire(payload: Payload): Payload {
  const decoder = new FrameDecoder();
  const assembler = new MessageAssembler();
  let received: Payload | undefined;
  for (const frame of encodeMessage(
    "request",
    1,
    { method: "watch.test" },
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

function assertInvalid(run: () => unknown): void {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof WorkerMethodError && error.code === INVALID_PARAMS,
  );
}

test("watch.subscribe keeps a lone surrogate in its path and ignore entries", () => {
  const request = {
    workerId: "local",
    id: 7,
    path: `/tmp/${LONE}`,
    ignore: [LONE, "node_modules", "\uDE00"],
  };
  assert.deepEqual(decodeSubscribe(wire(encodeSubscribe(request))), request);
});

test("an empty ignore list is an empty string, and decodes empty", () => {
  const payload = encodeSubscribe({
    workerId: "local",
    id: 1,
    path: "/x",
    ignore: [],
  });
  assert.equal(payload.text?.ignore, "");
  assert.deepEqual(decodeSubscribe(wire(payload)).ignore, []);
  // One empty entry is not an empty list on the wire.
  const one = decodeSubscribe(
    wire({
      json: { workerId: "local", id: 1 },
      text: { path: "/x", ignore: "\0" },
    }),
  );
  assert.deepEqual(one.ignore, ["", ""]);
});

test("a control request must name a Worker and a positive integer id", () => {
  for (const id of [0, -1, 1.5, "1", null, 2 ** 53])
    assertInvalid(() =>
      decodeSubscribe({
        json: { workerId: "local", id },
        text: { path: "/x", ignore: "" },
      }),
    );
  assertInvalid(() =>
    decodeSubscribe({ json: { id: 1 }, text: { path: "/x", ignore: "" } }),
  );
  assertInvalid(() =>
    decodeSubscribe({
      json: { workerId: "local", id: 1 },
      text: { ignore: "" },
    }),
  );
  assertInvalid(() =>
    decodeSubscribe({
      json: { workerId: "local", id: 1 },
      text: { path: "/x" },
    }),
  );
  assertInvalid(() =>
    decodeUnsubscribe({ json: { workerId: "local", id: 0 } }),
  );
  assert.deepEqual(
    decodeUnsubscribe(wire(encodeUnsubscribe({ workerId: "local", id: 3 }))),
    { workerId: "local", id: 3 },
  );
});

test("a control answer is {}, an answered failure, or malformed", () => {
  assert.equal(decodeWatchOutcome(wire(encodeWatchDone())), undefined);
  assert.throws(
    () => decodeWatchOutcome(wire(encodeWatchFailure(new Error(LONE)))),
    (error: unknown) =>
      error instanceof AnsweredWatchFailure && error.message === LONE,
  );
  for (const payload of [
    { json: { bogus: 1 } },
    { json: null },
    { json: [] },
    { json: { error: {} } },
    { json: { error: 1 }, text: { message: "m" } },
    { json: { error: {}, extra: true }, text: { message: "m" } },
  ] satisfies Payload[])
    assert.throws(
      () => decodeWatchOutcome(payload),
      MalformedWorkerAnswerError,
      JSON.stringify(payload),
    );
});

test("watch.events keeps batch boundaries, error batches and exact paths", () => {
  const delivery: WatchDelivery = {
    id: 4,
    batches: [
      { paths: ["/r/a", LONE] },
      { error: `boom ${LONE}` },
      { paths: [] },
      { paths: ["", "/r/\uDE00"] },
    ],
    overflow: false,
  };
  const payload = encodeEvents(delivery);
  assert.deepEqual(payload.json, {
    id: 4,
    batches: [
      { count: 2 },
      { count: 1, error: true },
      { count: 0 },
      { count: 2 },
    ],
  });
  assert.deepEqual(decodeEvents(wire(payload)), delivery);
  const overflow: WatchDelivery = { id: 4, batches: [], overflow: true };
  assert.deepEqual(decodeEvents(wire(encodeEvents(overflow))), overflow);
  assert.deepEqual(
    decodeEvents(
      wire(
        encodeEvents({ id: 5, batches: [{ paths: [""] }], overflow: false }),
      ),
    ),
    {
      id: 5,
      batches: [{ paths: [""] }],
      overflow: false,
    },
  );
});

test("a watch.events whose shape or paths do not fit is invalid", () => {
  for (const payload of [
    { json: { id: 0, batches: [] }, text: { paths: "" } },
    { json: { id: 1 }, text: { paths: "" } },
    { json: { id: 1, batches: [] } },
    { json: { id: 1, batches: [{ count: 1 }] }, text: { paths: "a\0b" } },
    { json: { id: 1, batches: [{ count: 0 }] }, text: { paths: "a" } },
    { json: { id: 1, batches: [{ count: -1 }] }, text: { paths: "" } },
    {
      json: { id: 1, batches: [{ count: 2, error: true }] },
      text: { paths: "a\0b" },
    },
    { json: { id: 1, batches: [], overflow: false }, text: { paths: "" } },
    {
      json: { id: 1, batches: [{ count: 1 }], overflow: true },
      text: { paths: "a" },
    },
  ] satisfies Payload[])
    assertInvalid(() => decodeEvents(payload));
});
