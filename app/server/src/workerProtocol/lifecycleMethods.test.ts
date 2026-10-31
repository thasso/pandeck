import assert from "node:assert/strict";
import { test } from "vitest";
import { MALFORMED_ANSWERS } from "../test/workerAnswers.ts";
import { INVALID_PARAMS } from "./checkoutMethods.ts";
import { FrameDecoder, MessageAssembler, encodeMessage } from "./codec.ts";
import type { Payload } from "./codec.ts";
import { WorkerMethodError } from "./connection.ts";
import {
  AnsweredFileFailure,
  MalformedWorkerAnswerError,
  encodeFailure,
} from "./fileMethods.ts";
import {
  LIFECYCLE_METHODS,
  decodeCreateDirResult,
  decodeDiscardTreeResult,
  decodeDone,
  decodeLifecycleLocation,
  decodeProcessStop,
  decodeRemoveTree,
  decodeRemoveTreeResult,
  decodeResidueScan,
  encodeCreateDirResult,
  encodeDiscardTreeResult,
  encodeDone,
  encodeLifecycleLocation,
  encodeProcessStop,
  encodeRemoveTree,
  encodeRemoveTreeResult,
  encodeResidueScan,
  refuseFilesystemRoot,
} from "./lifecycleMethods.ts";
import { WORKER_PROTOCOL_VERSION } from "./version.ts";

/** `payload` through the real framing, as the peer receives it. */
function wire(payload: Payload): Payload {
  const decoder = new FrameDecoder();
  const assembler = new MessageAssembler();
  let received: Payload | undefined;
  for (const frame of encodeMessage(
    "request",
    1,
    { method: "lifecycle.test" },
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
const location = { workerId: "local", path: `/tmp/wt-${LONE}` };

function assertInvalid(run: () => unknown): void {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof WorkerMethodError && error.code === INVALID_PARAMS,
  );
}

function assertMalformed(run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof MalformedWorkerAnswerError, String(error));
    return true;
  });
}

test("the protocol is 1.5 with seven lifecycle methods", () => {
  assert.equal(WORKER_PROTOCOL_VERSION, "1.5");
  assert.deepEqual(Object.values(LIFECYCLE_METHODS).sort(), [
    "lifecycle.createDir",
    "lifecycle.discardTree",
    "lifecycle.mkdir",
    "lifecycle.removeAll",
    "lifecycle.removeTree",
    "lifecycle.scanResidue",
    "lifecycle.stopProcesses",
  ]);
});

test("requests round-trip, a lone surrogate in the path included", () => {
  assert.deepEqual(
    decodeLifecycleLocation(wire(encodeLifecycleLocation(location))),
    location,
  );
  for (const stage of ["initial", "afterReclaim"] as const)
    assert.deepEqual(
      decodeRemoveTree(wire(encodeRemoveTree(location, stage))),
      {
        location,
        stage,
      },
    );
  const relative = { workerId: "local", path: "a/b" };
  assert.deepEqual(
    decodeLifecycleLocation(wire(encodeLifecycleLocation(relative))),
    relative,
  );
});

test("malformed requests are invalid params", () => {
  for (const json of [
    null,
    {},
    { location: { workerId: "local" } },
    { location: { workerId: 1, path: "/tmp/x" } },
    { location: { workerId: "local", path: "" } },
    { location: { workerId: "local", path: 5 } },
  ])
    assertInvalid(() => decodeLifecycleLocation({ json }));
  assertInvalid(() =>
    decodeRemoveTree({ json: { location, stage: "afterwards" } }),
  );
  assertInvalid(() => decodeRemoveTree({ json: { location } }));
});

test("a path resolving to / is refused, any other is not", () => {
  for (const path of ["/", "//", "/tmp/..", "/./"])
    assertInvalid(() => refuseFilesystemRoot({ workerId: "local", path }));
  for (const path of ["/tmp", "a", "./a-b"])
    refuseFilesystemRoot({ workerId: "local", path });
});

test("answers round-trip", () => {
  decodeDone(wire(encodeDone()));

  for (const result of ["created", "exists"] as const)
    assert.equal(
      decodeCreateDirResult(wire(encodeCreateDirResult(result))),
      result,
    );

  const clean = { complete: true, directoriesVisited: 3 };
  assert.deepEqual(decodeResidueScan(wire(encodeResidueScan(clean))), clean);
  const foreign = {
    complete: false,
    directoriesVisited: 9,
    foreign: {
      path: `/tmp/${LONE}/store`,
      reason: "foreign-owner" as const,
      uid: 0,
    },
  };
  assert.deepEqual(
    decodeResidueScan(wire(encodeResidueScan(foreign))),
    foreign,
  );

  for (const result of [
    { removed: true as const },
    { removed: false as const },
    { removed: false as const, residue: foreign.foreign },
  ])
    assert.deepEqual(
      decodeRemoveTreeResult(wire(encodeRemoveTreeResult(result))),
      result,
    );

  assert.deepEqual(
    decodeDiscardTreeResult(wire(encodeDiscardTreeResult({}))),
    {},
  );
  const failed = { failed: `EACCES: permission denied, rmdir '${LONE}'` };
  assert.deepEqual(
    decodeDiscardTreeResult(wire(encodeDiscardTreeResult(failed))),
    failed,
  );

  const stop = { terminated: [10, 11], killed: [11] };
  assert.deepEqual(decodeProcessStop(wire(encodeProcessStop(stop))), stop);
});

test("an answered failure rebuilds with its code and exact message", () => {
  const error = Object.assign(
    new Error(`EEXIST: file already exists ${LONE}`),
    {
      code: "EEXIST",
    },
  );
  for (const decode of [
    decodeDone,
    decodeCreateDirResult,
    decodeResidueScan,
    decodeRemoveTreeResult,
    decodeDiscardTreeResult,
    decodeProcessStop,
  ])
    assert.throws(
      () => decode(wire(encodeFailure(error))),
      (thrown: unknown) =>
        thrown instanceof AnsweredFileFailure &&
        (thrown as NodeJS.ErrnoException).code === "EEXIST" &&
        thrown.message === error.message,
    );
});

test("malformed answers are malformed, per method", () => {
  const decoders: Record<string, (payload: Payload) => unknown> = {
    [LIFECYCLE_METHODS.mkdir]: decodeDone,
    [LIFECYCLE_METHODS.createDir]: decodeCreateDirResult,
    [LIFECYCLE_METHODS.scanResidue]: decodeResidueScan,
    [LIFECYCLE_METHODS.removeTree]: decodeRemoveTreeResult,
    [LIFECYCLE_METHODS.discardTree]: decodeDiscardTreeResult,
    [LIFECYCLE_METHODS.removeAll]: decodeDone,
    [LIFECYCLE_METHODS.stopProcesses]: decodeProcessStop,
  };
  for (const method of Object.values(LIFECYCLE_METHODS))
    assertMalformed(() => decoders[method]!(MALFORMED_ANSWERS[method]!));

  assertMalformed(() =>
    decodeResidueScan({
      json: {
        scan: {
          complete: true,
          directoriesVisited: 1,
          foreign: { path: "/x", reason: "stranger", uid: 1 },
        },
      },
    }),
  );
  assertMalformed(() =>
    decodeRemoveTreeResult({
      json: {
        removal: {
          removed: true,
          residue: { path: "/x", reason: "foreign-owner", uid: 1 },
        },
      },
    }),
  );
  for (const json of [{}, { dir: true }, { dir: "made" }, { created: true }])
    assertMalformed(() => decodeCreateDirResult({ json }));
  assertMalformed(() =>
    decodeProcessStop({ json: { stop: { terminated: [0], killed: [] } } }),
  );
  assertMalformed(() =>
    decodeProcessStop({ json: { stop: { terminated: [1.5], killed: [] } } }),
  );
});
