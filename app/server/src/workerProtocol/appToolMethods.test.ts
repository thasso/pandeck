import assert from "node:assert/strict";
import { test } from "vitest";
import {
  APP_TOOL_METHODS,
  decodeAppToolCall,
  decodeAppToolProgress,
  decodeAppToolResult,
  encodeAppToolCall,
  encodeAppToolProgress,
  encodeAppToolResult,
  type AppToolCall,
  type AppToolResult,
} from "./appToolMethods.ts";
import { INVALID_PARAMS } from "./checkoutMethods.ts";
import {
  FrameDecoder,
  MessageAssembler,
  WorkerProtocolError,
  encodeMessage,
  type Payload,
} from "./codec.ts";
import { WorkerMethodError } from "./connection.ts";

/** `payload` through the real framing, as the peer receives it. */
function wire(payload: Payload, frames = encodeFrames(payload)): Payload {
  const decoder = new FrameDecoder();
  const assembler = new MessageAssembler();
  let received: Payload | undefined;
  for (const frame of frames)
    decoder.push(frame, (decoded) => {
      if (decoded.type === "data") assembler.data(decoded);
      else if (decoded.type === "request")
        received = assembler.complete(decoded);
    });
  assert.ok(received);
  return received;
}

function encodeFrames(payload: Payload): Buffer[] {
  return encodeMessage(
    "request",
    1,
    { method: APP_TOOL_METHODS.call },
    payload,
  );
}

const LONE = "a\uD800b";

function assertInvalid(run: () => unknown): void {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof WorkerMethodError && error.code === INVALID_PARAMS,
  );
}

test("protocol 1.6 added the two app-tool methods", () => {
  assert.deepEqual(Object.values(APP_TOOL_METHODS).sort(), [
    "appTools.call",
    "appTools.progress",
  ]);
});

test("appTools.call keeps lone surrogates in its ids, name and arguments", () => {
  const call: AppToolCall = {
    callId: 3,
    sessionId: `s-${LONE}`,
    tool: `t${LONE}`,
    toolCallId: `c-${LONE}`,
    args: { value: LONE, nested: [{ deep: LONE }, 1, null, true] },
    progress: true,
  };
  assert.deepEqual(decodeAppToolCall(wire(encodeAppToolCall(call))), call);
});

test("a result and a partial keep their text, details and terminate exactly", () => {
  const result: AppToolResult = {
    content: [
      { type: "text", text: LONE },
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ],
    details: { path: LONE, counts: [1, 2] },
    terminate: true,
  };
  assert.deepEqual(
    decodeAppToolResult(wire(encodeAppToolResult(result))),
    result,
  );
  const progress = {
    callId: 9,
    partial: { content: [{ type: "text" as const, text: LONE }] },
  };
  assert.deepEqual(
    decodeAppToolProgress(wire(encodeAppToolProgress(progress))),
    progress,
  );
});

test("a result over a frame's cap spans frames and arrives whole", () => {
  const big = `${LONE}${"y".repeat(1024 * 1024 + 3)}${LONE}`;
  const payload = encodeAppToolResult({
    content: [{ type: "text", text: big }],
  });
  const frames = encodeFrames(payload);
  assert.ok(frames.length > 1);
  assert.equal(
    (decodeAppToolResult(wire(payload, frames)).content[0] as { text: string })
      .text,
    big,
  );
});

test("a body that is not JSON is a protocol error", () => {
  const frames = encodeFrames(encodeAppToolResult({ content: [] }));
  const last = Buffer.from(frames.at(-1)!);
  // The body is the frame's tail: break its closing brace.
  last[last.length - 1] = 0x21;
  assert.throws(
    () => wire({}, [...frames.slice(0, -1), last]),
    WorkerProtocolError,
  );
});

test("a call that does not decode is refused as invalid params", () => {
  const good = encodeAppToolCall({
    callId: 1,
    sessionId: "s",
    tool: "t",
    toolCallId: "c",
    args: {},
    progress: false,
  }).json as Record<string, unknown>;
  for (const broken of [
    null,
    [],
    { ...good, callId: 0 },
    { ...good, callId: 1.5 },
    { ...good, sessionId: "" },
    { ...good, tool: 1 },
    { ...good, toolCallId: undefined },
    { ...good, args: [] },
    { ...good, args: null },
    { ...good, progress: "yes" },
  ])
    assertInvalid(() => decodeAppToolCall({ json: broken }));
  assertInvalid(() => decodeAppToolProgress({ json: { callId: 1 } }));
  assertInvalid(() =>
    decodeAppToolProgress({ json: { callId: -1, partial: { content: [] } } }),
  );
});

test("an answer that is not a result is malformed, never trusted", () => {
  for (const answer of [
    null,
    {},
    { content: "text" },
    { content: [{ text: "no type" }] },
    { content: [null] },
    { content: [], terminate: "yes" },
  ])
    assert.throws(
      () => decodeAppToolResult({ json: answer }),
      /The server answered a malformed app-tool result\./,
    );
});
