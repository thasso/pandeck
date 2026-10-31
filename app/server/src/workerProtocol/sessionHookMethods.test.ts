import assert from "node:assert/strict";
import { test } from "vitest";
import { assertArtifactSessionId } from "../documentGrantTargets.ts";
import { INVALID_PARAMS } from "./checkoutMethods.ts";
import {
  FrameDecoder,
  MessageAssembler,
  encodeMessage,
  type Payload,
} from "./codec.ts";
import { WorkerMethodError } from "./connection.ts";
import {
  SESSION_HOOK_METHODS,
  decodeAcknowledgement,
  decodeCanUseToolAnswer,
  decodeCanUseToolRequest,
  decodePersistOutputAnswer,
  decodePersistOutputRequest,
  decodePostCompactRequest,
  decodePreToolUseAnswer,
  decodePreToolUseRequest,
  decodeStopRequest,
  encodeSessionHookAnswer,
  encodeSessionHookRequest,
  isArtifactSessionId,
  type PersistOutputRequest,
  type PreToolUseRequest,
  type StopRequest,
} from "./sessionHookMethods.ts";
import { WORKER_PROTOCOL_VERSION } from "./version.ts";

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
    { method: SESSION_HOOK_METHODS.persistOutput },
    payload,
  );
}

const LONE = "a\uD800b";

function assertInvalid(run: () => unknown, message?: RegExp): void {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof WorkerMethodError &&
      error.code === INVALID_PARAMS &&
      (message === undefined || message.test(error.message)),
  );
}

test("protocol 1.7 adds the five session-hook methods", () => {
  assert.equal(WORKER_PROTOCOL_VERSION, "1.7");
  assert.deepEqual(Object.values(SESSION_HOOK_METHODS).sort(), [
    "sessionHooks.canUseTool",
    "sessionHooks.persistOutput",
    "sessionHooks.postCompact",
    "sessionHooks.preToolUse",
    "sessionHooks.stop",
  ]);
});

test("every request keeps lone surrogates through the real codec", () => {
  const sessionId = `s-${LONE}`;
  assert.deepEqual(
    decodeCanUseToolRequest(
      wire(encodeSessionHookRequest({ sessionId, toolName: `T${LONE}` })),
    ),
    { sessionId, toolName: `T${LONE}` },
  );
  const pre: PreToolUseRequest = {
    sessionId,
    epoch: `claude-${LONE}`,
    toolName: "Bash",
    toolInput: { command: LONE, nested: [{ deep: LONE }, 1, null, true] },
    toolUseId: `u-${LONE}`,
  };
  assert.deepEqual(
    decodePreToolUseRequest(wire(encodeSessionHookRequest(pre))),
    pre,
  );
  const stop: StopRequest = {
    sessionId,
    epoch: "e",
    tasks: [
      {
        id: "t1",
        type: "local_bash",
        status: "running",
        description: `watch ${LONE}`,
        command: LONE,
      },
      { id: "t2", type: "monitor", status: "done", description: "" },
    ],
  };
  assert.deepEqual(
    decodeStopRequest(wire(encodeSessionHookRequest(stop))),
    stop,
  );
  const compact = { sessionId, epoch: "e", summary: `summary ${LONE}` };
  assert.deepEqual(
    decodePostCompactRequest(wire(encodeSessionHookRequest(compact))),
    compact,
  );
  const persist: PersistOutputRequest = {
    sessionId,
    toolName: "Bash",
    raw: `out ${LONE}`,
    sourcePath: `/tmp/${LONE}.out`,
  };
  assert.deepEqual(
    decodePersistOutputRequest(wire(encodeSessionHookRequest(persist))),
    persist,
  );
});

test("every answer keeps its text through the real codec", () => {
  assert.deepEqual(
    decodeCanUseToolAnswer(
      wire(encodeSessionHookAnswer({ behavior: "deny", message: LONE })),
    ),
    { behavior: "deny", message: LONE },
  );
  assert.deepEqual(
    decodeCanUseToolAnswer(
      wire(encodeSessionHookAnswer({ behavior: "allow" })),
    ),
    { behavior: "allow" },
  );
  for (const admission of [
    { allowed: true as const },
    { allowed: true as const, context: `PA task ${LONE}` },
    { allowed: false as const, reason: `full ${LONE}` },
  ])
    assert.deepEqual(
      decodePreToolUseAnswer(wire(encodeSessionHookAnswer(admission))),
      admission,
    );
  const artifact = { path: `/data/${LONE}.log`, url: `/api/${LONE}` };
  assert.deepEqual(
    decodePersistOutputAnswer(wire(encodeSessionHookAnswer(artifact))),
    artifact,
  );
  decodeAcknowledgement(
    SESSION_HOOK_METHODS.stop,
    wire(encodeSessionHookAnswer({})),
  );
});

test("a raw output over a frame's cap spans frames and arrives whole", () => {
  const raw = `${LONE}${"y".repeat(1024 * 1024 + 3)}${LONE}`;
  const payload = encodeSessionHookRequest({
    sessionId: "s",
    toolName: "Bash",
    raw,
  });
  const frames = encodeFrames(payload);
  assert.ok(frames.length > 1);
  assert.equal(decodePersistOutputRequest(wire(payload, frames)).raw, raw);
});

// The protocol's rule and `documentGrantTargets.ts`'s, side by side: the
// Worker cannot import the server's, so the two must agree here.
const SESSION_IDS: Array<[id: string, protocol: boolean, grants: boolean]> = [
  ["../w8-escape", false, false],
  ["a/b", false, false],
  ["a\\b", false, false],
  [".", false, false],
  ["..", false, false],
  // Only the protocol refuses the empty id: it would name the artifacts root.
  ["", false, true],
  ["4c0f3f8e-9a51-4d8e-b7a0-0e1f2a3b4c5d", true, true],
  ["mode-test", true, true],
];

test("the session-id rule matches the artifact grants' rule", () => {
  for (const [id, protocol, grants] of SESSION_IDS) {
    assert.equal(isArtifactSessionId(id), protocol, JSON.stringify(id));
    let accepted = true;
    try {
      assertArtifactSessionId(id);
    } catch {
      accepted = false;
    }
    assert.equal(accepted, grants, JSON.stringify(id));
  }
});

test("every request refuses an unsafe session id as invalid params", () => {
  const decoders = [
    decodeCanUseToolRequest,
    decodePreToolUseRequest,
    decodeStopRequest,
    decodePostCompactRequest,
    decodePersistOutputRequest,
  ];
  const valid = {
    toolName: "Bash",
    epoch: "e",
    toolInput: {},
    toolUseId: "u",
    tasks: [],
    summary: "s",
    raw: "r",
  };
  for (const decode of decoders) {
    assert.doesNotThrow(() => decode({ json: { ...valid, sessionId: "ok" } }));
    for (const [id, protocol] of SESSION_IDS)
      if (!protocol)
        assertInvalid(
          () => decode({ json: { ...valid, sessionId: id } }),
          /^Invalid session id\.$/,
        );
    assertInvalid(() => decode({ json: { ...valid, sessionId: 7 } }));
    assertInvalid(() => decode({ json: null }));
  }
});

test("a malformed request body is refused as invalid params", () => {
  const sessionId = "s";
  assertInvalid(() => decodeCanUseToolRequest({ json: { sessionId } }));
  const pre = {
    sessionId,
    epoch: "e",
    toolName: "Bash",
    toolInput: {},
    toolUseId: "u",
  };
  for (const broken of [
    { ...pre, epoch: 1 },
    { ...pre, toolName: undefined },
    { ...pre, toolInput: [] },
    { ...pre, toolInput: null },
    { ...pre, toolUseId: 2 },
  ])
    assertInvalid(() => decodePreToolUseRequest({ json: broken }));
  const task = { id: "t", type: "x", status: "running", description: "d" };
  for (const broken of [
    { sessionId, epoch: "e", tasks: {} },
    { sessionId, tasks: [] },
    { sessionId, epoch: "e", tasks: [null] },
    { sessionId, epoch: "e", tasks: [{ ...task, id: 1 }] },
    { sessionId, epoch: "e", tasks: [{ ...task, command: 3 }] },
  ])
    assertInvalid(() => decodeStopRequest({ json: broken }));
  assertInvalid(() =>
    decodePostCompactRequest({ json: { sessionId, epoch: "e" } }),
  );
  for (const broken of [
    { sessionId, toolName: "Bash" },
    { sessionId, raw: "r" },
    { sessionId, toolName: "Bash", raw: "r", sourcePath: 1 },
  ])
    assertInvalid(() => decodePersistOutputRequest({ json: broken }));
});

test("an answer that is not its method's is malformed, never trusted", () => {
  for (const answer of [
    null,
    {},
    { behavior: "allow!" },
    { behavior: "deny" },
    { behavior: "deny", message: 1 },
  ])
    assert.throws(
      () => decodeCanUseToolAnswer({ json: answer }),
      /malformed sessionHooks\.canUseTool result/,
    );
  for (const answer of [
    null,
    {},
    { allowed: "yes" },
    { allowed: true, context: 1 },
    { allowed: false },
  ])
    assert.throws(
      () => decodePreToolUseAnswer({ json: answer }),
      /malformed sessionHooks\.preToolUse result/,
    );
  for (const answer of [null, {}, { path: "/p" }, { path: "/p", url: 1 }])
    assert.throws(
      () => decodePersistOutputAnswer({ json: answer }),
      /malformed sessionHooks\.persistOutput result/,
    );
  for (const answer of [null, [], "ok"])
    assert.throws(
      () =>
        decodeAcknowledgement(SESSION_HOOK_METHODS.postCompact, {
          json: answer,
        }),
      /malformed sessionHooks\.postCompact result/,
    );
});
