import assert from "node:assert/strict";
import { test } from "vitest";
import {
  BACKGROUND_WORK_METHODS,
  decodeActivity,
  decodeAdmitAnswer,
  decodeAdmitRequest,
  decodeCompletion,
  decodeLaunch,
  decodeLaunchAck,
  decodeOutput,
  decodeRateExceeded,
  decodeReportAcknowledgement,
  decodeStop,
  decodeStopAck,
  decodeStopAll,
  decodeStopAllAck,
  encodeBackgroundWork,
} from "./backgroundWorkMethods.ts";
import { INVALID_PARAMS } from "./checkoutMethods.ts";
import {
  FrameDecoder,
  MessageAssembler,
  encodeMessage,
  type Payload,
} from "./codec.ts";
import { WorkerMethodError } from "./connection.ts";
import {
  SKILL_METHODS,
  decodeSkillMaterialize,
  decodeSkillMaterialized,
  encodeSkillMaterialize,
} from "./skillMethods.ts";
import { WORKER_PROTOCOL_VERSION } from "./version.ts";

/** `payload` through the real framing, as the peer receives it. */
function wire(payload: Payload): Payload {
  const decoder = new FrameDecoder();
  const assembler = new MessageAssembler();
  let received: Payload | undefined;
  for (const frame of encodeMessage(
    "request",
    1,
    { method: BACKGROUND_WORK_METHODS.admit },
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

/** A malformed answer is the peer's fault, not the asker's parameters. */
function assertMalformed(run: () => unknown, method: string): void {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof WorkerMethodError) &&
      error.message === `The peer answered a malformed ${method} result.`,
  );
}

const roundTrip = <T>(decode: (payload: Payload) => T, value: object): T =>
  decode(wire(encodeBackgroundWork(value)));

const TARGET = {
  itemId: "bgw_1",
  ownerSessionId: "owner",
  kind: "monitor-command",
};

test("protocol 1.9 adds the eight background-work methods and skill materialization", () => {
  assert.equal(WORKER_PROTOCOL_VERSION, "1.9");
  assert.deepEqual(Object.values(BACKGROUND_WORK_METHODS).sort(), [
    "backgroundWork.activity",
    "backgroundWork.admit",
    "backgroundWork.completed",
    "backgroundWork.launch",
    "backgroundWork.output",
    "backgroundWork.rateExceeded",
    "backgroundWork.stop",
    "backgroundWork.stopAll",
  ]);
  assert.deepEqual(Object.values(SKILL_METHODS), ["skills.materialize"]);
});

test("admission, launch and Stop round-trip through the real codec", () => {
  const admission = {
    sessionId: "owner",
    launchKey: "launch-1",
    kind: "shell",
    label: LONE,
    description: "why",
    command: `printf ${LONE}`,
    sourceRequestId: "call-1",
    requestedLifetimeMs: 60_000,
  };
  assert.deepEqual(roundTrip(decodeAdmitRequest, admission), admission);
  for (const answer of [
    { admitted: false, message: LONE },
    { admitted: true, itemId: "bgw_1", state: "running", reused: false },
    {
      admitted: true,
      itemId: "bgw_1",
      state: "not-started",
      reused: true,
      intent: "service",
      outcomeSummary: "Background launch failed",
    },
  ])
    assert.deepEqual(roundTrip(decodeAdmitAnswer, answer), answer);
  const launch = {
    launchKey: "launch-1",
    request: {
      target: { ...TARGET, hostEpochKey: "epoch" },
      deadlineAt: 1_000,
      emptyHostGraceMs: 0,
    },
  };
  assert.deepEqual(roundTrip(decodeLaunch, launch), launch);
  for (const ack of [{ launched: true }, { launched: false, reason: LONE }])
    assert.deepEqual(roundTrip(decodeLaunchAck, ack), ack);
  const stop = {
    target: TARGET,
    sourceRequestId: "stop-1",
    attempt: 2,
    reason: LONE,
  };
  assert.deepEqual(roundTrip(decodeStop, stop), stop);
  for (const ack of [
    { acknowledged: true },
    { acknowledged: false, evidence: LONE },
  ])
    assert.deepEqual(roundTrip(decodeStopAck, ack), ack);
  const stopAll = {
    ownerSessionId: "owner",
    callerSessionId: "caller",
    sourceRequestId: "stop-all-1",
    attempt: 1,
    reason: "bye",
    itemIds: ["bgw_1", "bgw_2"],
    protectOrdinaryTurn: true,
  };
  assert.deepEqual(roundTrip(decodeStopAll, stopAll), stopAll);
  const stopAllAck = {
    acknowledgedItemIds: ["bgw_1"],
    unconfirmedItemIds: ["bgw_2"],
  };
  assert.deepEqual(roundTrip(decodeStopAllAck, stopAllAck), stopAllAck);
});

test("the four item reports round-trip through the real codec", () => {
  const activity = {
    itemId: "bgw_1",
    lines: [LONE, ""],
    bytes: 6,
    droppedEventCount: 2,
    eventId: "bgw_1:1",
  };
  assert.deepEqual(roundTrip(decodeActivity, activity), activity);
  const rate = {
    itemId: "bgw_1",
    eventId: "bgw_1:rate",
    notificationCount: 21,
    windowMs: 60_000,
  };
  assert.deepEqual(roundTrip(decodeRateExceeded, rate), rate);
  for (const output of [
    { itemId: "bgw_1", eventId: "o", file: `/tmp/${LONE}` },
    {
      itemId: "bgw_1",
      eventId: "o",
      file: "/tmp/out",
      originalBytes: 9,
      truncated: true,
    },
    { itemId: "bgw_1", eventId: "o", writeFailed: true },
  ])
    assert.deepEqual(roundTrip(decodeOutput, output), output);
  const completion = {
    itemId: "bgw_1",
    state: "failed",
    exitCode: -1,
    outcomeSummary: LONE,
    eventId: "bgw_1:done",
    sequence: 3,
  };
  assert.deepEqual(roundTrip(decodeCompletion, completion), completion);
  assert.equal(
    decodeReportAcknowledgement(
      BACKGROUND_WORK_METHODS.completed,
      wire(encodeBackgroundWork({})),
    ),
    undefined,
  );
});

test("a malformed request is refused as invalid parameters", () => {
  assertInvalid(
    () => decodeAdmitRequest({ json: null }),
    /^Invalid admission\.$/,
  );
  assertInvalid(
    () =>
      decodeAdmitRequest(
        encodeBackgroundWork({
          sessionId: "owner",
          launchKey: "launch-1",
          kind: "claude-task",
          label: "x",
          command: "x",
          sourceRequestId: "call-1",
        }),
      ),
    /^Invalid background work kind\.$/,
  );
  assertInvalid(
    () =>
      decodeLaunch(
        encodeBackgroundWork({
          launchKey: "",
          request: { target: TARGET, deadlineAt: 1, emptyHostGraceMs: 0 },
        }),
      ),
    /^Invalid launch key\.$/,
  );
  assertInvalid(
    () =>
      decodeStop(
        encodeBackgroundWork({
          target: TARGET,
          sourceRequestId: "stop-1",
          attempt: 3,
          reason: "x",
        }),
      ),
    /^Invalid stop attempt\.$/,
  );
  assertInvalid(
    () =>
      decodeStopAll(
        encodeBackgroundWork({
          ownerSessionId: "owner",
          sourceRequestId: "stop-all-1",
          attempt: 1,
          reason: "x",
          itemIds: [""],
          protectOrdinaryTurn: false,
        }),
      ),
    /^Invalid item ids\.$/,
  );
  assertInvalid(
    () =>
      decodeActivity(encodeBackgroundWork({ ...TARGET, lines: [1], bytes: 1 })),
    /^Invalid activity lines\.$/,
  );
  // An output report names exactly one of a file or the writer's failure.
  for (const output of [
    { itemId: "bgw_1", eventId: "o" },
    { itemId: "bgw_1", eventId: "o", file: "/tmp/out", writeFailed: true },
  ])
    assertInvalid(
      () => decodeOutput(encodeBackgroundWork(output)),
      /^Invalid output report\.$/,
    );
  assertInvalid(
    () =>
      decodeCompletion(
        encodeBackgroundWork({ itemId: "bgw_1", state: "lost" }),
      ),
    /^Invalid completion state\.$/,
  );
});

test("a malformed answer is the peer's fault", () => {
  assertMalformed(
    () => decodeAdmitAnswer(encodeBackgroundWork({ admitted: true })),
    BACKGROUND_WORK_METHODS.admit,
  );
  assertMalformed(
    () => decodeLaunchAck(encodeBackgroundWork({ launched: "yes" })),
    BACKGROUND_WORK_METHODS.launch,
  );
  assertMalformed(
    () => decodeStopAck(encodeBackgroundWork({})),
    BACKGROUND_WORK_METHODS.stop,
  );
  assertMalformed(
    () => decodeStopAllAck(encodeBackgroundWork({ acknowledgedItemIds: [] })),
    BACKGROUND_WORK_METHODS.stopAll,
  );
  assertMalformed(
    () =>
      decodeReportAcknowledgement(BACKGROUND_WORK_METHODS.output, {
        json: [],
      }),
    BACKGROUND_WORK_METHODS.output,
  );
});

test("skill materialization round-trips and refuses names that are not strings", () => {
  assert.deepEqual(
    decodeSkillMaterialize(wire(encodeSkillMaterialize({ names: [LONE] }))),
    { names: [LONE] },
  );
  for (const json of [null, {}, { names: [1] }, { names: "a" }])
    assertInvalid(
      () => decodeSkillMaterialize({ json }),
      /^Invalid skill names\.$/,
    );
  assert.equal(decodeSkillMaterialized({ json: {} }), undefined);
  assert.throws(
    () => decodeSkillMaterialized({ json: null }),
    /The server answered a malformed skills\.materialize result\./,
  );
});
