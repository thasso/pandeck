import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { WRONG_WORKER } from "../workerProtocol/checkoutMethods.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import {
  UNKNOWN_METHOD,
  WorkerConnection,
  WorkerMethodError,
  WorkerRequestError,
  type MethodHandler,
} from "../workerProtocol/connection.ts";
import {
  AnsweredFileFailure,
  FILE_METHODS,
  MalformedWorkerAnswerError,
} from "../workerProtocol/fileMethods.ts";
import { createInProcessTransport } from "../workerProtocol/inProcessTransport.ts";
import {
  existsOnWorker,
  inspectOnWorker,
  isWorkerFailure,
  openOnWorker,
  readdirOnWorker,
  readlinkOnWorker,
  realpathOnWorker,
  statOnWorker,
  type WorkerFileHandle,
} from "./fileClient.ts";
import { workerRegistry } from "./workerRegistry.ts";

/**
 * The client's error categories over the real codec: a test Worker, accepted
 * by the server's registry, answers each request with what the test sets.
 * Only request rejections and malformed answers are Worker failures; a
 * filesystem failure the Worker answered never is.
 */

interface TestWorker {
  id: string;
  /** The Worker's handlers, read at each request; a missing one is unknown. */
  handlers: Record<string, MethodHandler>;
  worker: WorkerConnection;
}

let dialed = 0;
const workers: TestWorker[] = [];

afterEach(() => {
  for (const { worker } of workers.splice(0)) worker.end("test done");
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++)
    await new Promise<void>((done) => setImmediate(done));
}

async function testWorker(): Promise<TestWorker> {
  const id = `file-client-${++dialed}`;
  const handlers: Record<string, MethodHandler> = {};
  const [serverEnd, workerEnd] = createInProcessTransport();
  workerRegistry.accept(serverEnd, { quiescence: () => Promise.resolve() });
  const worker = new WorkerConnection(workerEnd, {
    handshake: { role: "worker", workerId: id },
    handlers,
  });
  await settle();
  assert.ok(workerRegistry.connection(id), "the test Worker is connected");
  const dial = { id, handlers, worker };
  workers.push(dial);
  return dial;
}

const answer =
  (payload: Payload): MethodHandler =>
  async () =>
    payload;

/** A `files.inspect` answer, well-formed but for `fields`. */
const inspected = (fields: Record<string, unknown>): Payload => ({
  json: {
    inspection: {
      kind: "file",
      dev: "1",
      ino: "2",
      size: "3",
      mtimeNs: "4",
      ...fields,
    },
  },
});

/** Not a canonical decimal, signed or not. */
const NOT_DECIMAL = ["", "-", "-0", "01", "-01", "+1", "1.5", "1e3", " 1"];

/** A handler that never answers until the request is cancelled. */
const hang: MethodHandler = (_payload, signal) =>
  new Promise((_resolve, reject) =>
    signal.addEventListener("abort", () => reject(new Error("stop"))),
  );

/** Every path-level client function, by the method it sends. */
const PATH_CALLS: Record<string, (workerId: string) => Promise<unknown>> = {
  [FILE_METHODS.stat]: (workerId) => statOnWorker({ workerId, path: "/p" }),
  [FILE_METHODS.realpath]: (workerId) =>
    realpathOnWorker({ workerId, path: "/p" }),
  [FILE_METHODS.exists]: (workerId) => existsOnWorker({ workerId, path: "/p" }),
  [FILE_METHODS.inspect]: (workerId) =>
    inspectOnWorker({ workerId, path: "/p" }, false),
  [FILE_METHODS.readdir]: (workerId) =>
    readdirOnWorker({ workerId, path: "/p" }),
  [FILE_METHODS.readlink]: (workerId) =>
    readlinkOnWorker({ workerId, path: "/p" }),
  [FILE_METHODS.open]: (workerId) =>
    openOnWorker({ workerId, path: "/p" }, false),
};

/** The bound handle's functions, by the method each sends. */
const HANDLE_CALLS: Record<
  string,
  (file: WorkerFileHandle) => Promise<unknown>
> = {
  [FILE_METHODS.read]: (file) => file.read(0, 4),
  [FILE_METHODS.close]: (file) => file.close(),
};

async function openedOn(dial: TestWorker): Promise<WorkerFileHandle> {
  dial.handlers[FILE_METHODS.open] = answer({
    json: { opened: { handle: 1 } },
  });
  const outcome = await openOnWorker({ workerId: dial.id, path: "/p" }, false);
  assert.ok("file" in outcome);
  return outcome.file;
}

async function rejectsBranded(
  call: Promise<unknown>,
  check: (error: unknown) => void,
): Promise<void> {
  await assert.rejects(call, (error: unknown) => {
    assert.equal(isWorkerFailure(error), true, String(error));
    check(error);
    return true;
  });
}

const refusedWith = (code: string) => (error: unknown) => {
  assert.ok(error instanceof WorkerRequestError, String(error));
  assert.equal(error.code, code);
};

describe("Worker failures are branded", () => {
  test("a refusal of any code, wrong_worker and unknown_method alike", async () => {
    const dial = await testWorker();
    for (const [method, call] of Object.entries(PATH_CALLS)) {
      dial.handlers[method] = async () => {
        throw new WorkerMethodError(WRONG_WORKER, "Not here.");
      };
      await rejectsBranded(call(dial.id), (error) => {
        refusedWith(WRONG_WORKER)(error);
        assert.equal((error as Error).message, "Not here.");
      });
      delete dial.handlers[method];
      await rejectsBranded(call(dial.id), refusedWith(UNKNOWN_METHOD));
    }
    for (const [method, call] of Object.entries(HANDLE_CALLS)) {
      const file = await openedOn(dial);
      dial.handlers[method] = async () => {
        throw new WorkerMethodError(WRONG_WORKER, "Not here.");
      };
      await rejectsBranded(call(file), refusedWith(WRONG_WORKER));
      delete dial.handlers[method];
      await rejectsBranded(call(file), refusedWith(UNKNOWN_METHOD));
    }
  });

  test("a malformed answer", async () => {
    const dial = await testWorker();
    const malformed: [string, Payload][] = [
      [FILE_METHODS.stat, { json: { stat: { isFile: "yes" } } }],
      [FILE_METHODS.stat, { json: { error: { code: "ENOENT" } } }],
      [FILE_METHODS.realpath, { json: { path: 5 } }],
      [FILE_METHODS.exists, { json: { exists: "yes" } }],
      // `files.exists` never answers a failure.
      [
        FILE_METHODS.exists,
        { json: { error: { code: "ENOENT" } }, text: { message: "gone" } },
      ],
      [
        FILE_METHODS.inspect,
        {
          json: {
            inspection: {
              kind: "pipe",
              dev: "1",
              ino: "2",
              size: "3",
              mtimeNs: "4",
            },
          },
        },
      ],
      [FILE_METHODS.inspect, inspected({ dev: 1 })],
      ...NOT_DECIMAL.flatMap((digits) =>
        (["dev", "ino", "size", "mtimeNs"] as const).map(
          (field): [string, Payload] => [
            FILE_METHODS.inspect,
            inspected({ [field]: digits }),
          ],
        ),
      ),
      // A size is never negative.
      [FILE_METHODS.inspect, inspected({ size: "-1" })],
      [FILE_METHODS.readdir, { json: { entries: [{ name: 1 }] } }],
      [FILE_METHODS.readdir, { json: { entries: "a" } }],
      [FILE_METHODS.readlink, { json: { target: 5 } }],
      [FILE_METHODS.readlink, { json: {} }],
      [FILE_METHODS.open, { json: { opened: { handle: 0 } } }],
      [
        FILE_METHODS.open,
        { json: { error: { code: "ENOENT" } }, text: { message: "no phase" } },
      ],
    ];
    for (const [method, payload] of malformed) {
      dial.handlers[method] = answer(payload);
      await rejectsBranded(PATH_CALLS[method]!(dial.id), (error) =>
        assert.ok(error instanceof MalformedWorkerAnswerError, String(error)),
      );
    }
    for (const [method, payload] of [
      [FILE_METHODS.read, { json: {} }],
      [FILE_METHODS.close, {}],
    ] as const) {
      const file = await openedOn(dial);
      dial.handlers[method] = answer(payload);
      await rejectsBranded(HANDLE_CALLS[method]!(file), (error) =>
        assert.ok(error instanceof MalformedWorkerAnswerError, String(error)),
      );
    }
  });

  test("a negative identity or time is no malformed answer", async () => {
    // Node's `bigint` stat holds every field in 64 signed bits: a time before
    // 1970 is negative, and so is a `dev` or `ino` at or above 2^63.
    const dial = await testWorker();
    const signed = {
      kind: "file",
      dev: "-1",
      ino: "-9223372036854775808",
      size: "0",
      mtimeNs: "-315619200000000000",
    };
    dial.handlers[FILE_METHODS.inspect] = answer(inspected(signed));
    assert.deepEqual(
      await inspectOnWorker({ workerId: dial.id, path: "/p" }, true),
      signed,
    );
  });

  test("an inspection's mode is optional unless the caller requires it", async () => {
    const dial = await testWorker();
    const location = { workerId: dial.id, path: "/p" };
    const fields = {
      kind: "file",
      dev: "1",
      ino: "2",
      size: "3",
      mtimeNs: "4",
    };
    // A 1.2 Worker's answer: W3a's callers decode it as before.
    dial.handlers[FILE_METHODS.inspect] = answer(inspected({}));
    assert.deepEqual(await inspectOnWorker(location, false), fields);
    assert.deepEqual(
      await inspectOnWorker(location, false, { mode: false }),
      fields,
    );
    await rejectsBranded(
      inspectOnWorker(location, false, { mode: true }),
      (error) =>
        assert.ok(error instanceof MalformedWorkerAnswerError, String(error)),
    );

    dial.handlers[FILE_METHODS.inspect] = answer(inspected({ mode: "33188" }));
    for (const mode of [false, true])
      assert.deepEqual(await inspectOnWorker(location, false, { mode }), {
        ...fields,
        mode: "33188",
      });

    for (const bad of ["-1", "01", 5, ...NOT_DECIMAL]) {
      dial.handlers[FILE_METHODS.inspect] = answer(inspected({ mode: bad }));
      for (const mode of [false, true])
        await rejectsBranded(
          inspectOnWorker(location, false, { mode }),
          (error) =>
            assert.ok(
              error instanceof MalformedWorkerAnswerError,
              String(error),
            ),
        );
    }
  });

  test("an ended connection and an unknown Worker id", async () => {
    for (const [method, call] of Object.entries(PATH_CALLS)) {
      const dial = await testWorker();
      dial.handlers[method] = hang;
      const pending = call(dial.id);
      await settle();
      dial.worker.end("test");
      await rejectsBranded(pending, (error) =>
        assert.match(String(error), /The Worker connection ended/),
      );
      // Its id is gone with it.
      await rejectsBranded(call(dial.id), (error) =>
        assert.equal(
          (error as Error).message,
          `Worker "${dial.id}" is not connected.`,
        ),
      );
    }

    const dial = await testWorker();
    const file = await openedOn(dial);
    dial.handlers[FILE_METHODS.read] = hang;
    const reading = file.read(0, 4);
    await settle();
    dial.worker.end("test");
    await rejectsBranded(reading, (error) =>
      assert.match(String(error), /The Worker connection ended/),
    );
    await rejectsBranded(file.read(0, 4), (error) =>
      assert.match(String(error), /The Worker connection ended/),
    );
    // W2's meaning: a close on an ended connection does nothing, since the
    // Worker closed the handle at the end.
    await file.close();
  });
});

describe("answered filesystem failures are never branded", () => {
  const coded: Payload = {
    json: { error: { code: "ENOENT" } },
    text: { message: "ENOENT: no such file or directory, stat '/p'" },
  };
  const uncoded: Payload = {
    json: { error: { code: null } },
    text: { message: "Something odd." },
  };

  function answeredAs(failure: Payload) {
    return (error: unknown) => {
      assert.ok(error instanceof AnsweredFileFailure, String(error));
      assert.equal(isWorkerFailure(error), false);
      assert.equal(error.message, failure.text!.message);
      const code = (failure.json as { error: { code: string | null } }).error
        .code;
      if (code === null) assert.equal("code" in error, false);
      else assert.equal((error as NodeJS.ErrnoException).code, code);
      return true;
    };
  }

  test("ENOENT and code null keep their message and code", async () => {
    const dial = await testWorker();
    for (const failure of [coded, uncoded]) {
      for (const method of [
        FILE_METHODS.stat,
        FILE_METHODS.realpath,
        FILE_METHODS.inspect,
        FILE_METHODS.readdir,
        FILE_METHODS.readlink,
      ]) {
        dial.handlers[method] = answer(failure);
        await assert.rejects(PATH_CALLS[method]!(dial.id), answeredAs(failure));
      }
      for (const phase of ["open", "stat"] as const) {
        dial.handlers[FILE_METHODS.open] = answer({
          ...failure,
          json: {
            error: {
              ...(failure.json as { error: object }).error,
              phase,
            },
          },
        });
        const outcome = await openOnWorker(
          { workerId: dial.id, path: "/p" },
          true,
        );
        assert.ok("error" in outcome);
        assert.equal(outcome.phase, phase);
        answeredAs(failure)(outcome.error);
      }
      for (const [method, call] of Object.entries(HANDLE_CALLS)) {
        const file = await openedOn(dial);
        dial.handlers[method] = answer(failure);
        await assert.rejects(call(file), answeredAs(failure));
      }
    }
  });
});
