import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  FrameDecoder,
  MAX_FRAME_HEADER_BYTES,
  encodeControlFrame,
  type Frame,
} from "../workerProtocol/codec.ts";
import {
  UNKNOWN_METHOD,
  WorkerConnection,
  WorkerRequestError,
  WorkerRequestNotSentError,
  type MethodHandlers,
} from "../workerProtocol/connection.ts";
import {
  createInProcessTransport,
  type ByteEndpoint,
} from "../workerProtocol/inProcessTransport.ts";
import { WORKER_PROTOCOL_VERSION } from "../workerProtocol/version.ts";
import { WorkerRegistry } from "./workerRegistry.ts";

/** Let every queued in-process delivery run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** A Worker end that speaks raw frames, so its hello can name any version. */
function rawWorker(workerEnd: ByteEndpoint, version: string, workerId = "w") {
  const received: Frame[] = [];
  const decoder = new FrameDecoder();
  workerEnd.onData((bytes) => decoder.push(bytes, (f) => received.push(f)));
  workerEnd.onClose(() => undefined);
  workerEnd.write(encodeControlFrame({ type: "hello", workerId, version }));
  return received;
}

const quiet = { quiescence: () => Promise.resolve() };

test("a Worker on another protocol major is refused and served nothing", async () => {
  const registry = new WorkerRegistry();
  const [serverEnd, workerEnd] = createInProcessTransport();
  const connection = registry.accept(serverEnd, quiet);
  // Made before the handshake: it waits for it, and dies with it.
  const early = connection.request("checkout.git.run", { json: {} });
  const received = rawWorker(workerEnd, "2.0");
  await assert.rejects(early, /The Worker connection ended: refused: /);
  assert.match(await connection.ended, /cannot talk to 1\.10/);
  assert.deepEqual(
    received.map((frame) => frame.type),
    ["refused"],
    "no request reached the Worker",
  );
  assert.equal(registry.connection("w"), undefined);
  assert.equal(registry.epoch("w"), undefined);
  await assert.rejects(connection.request("checkout.git.run", {}), /ended/);
});

test("a Worker on a higher minor is welcomed and served", async () => {
  const registry = new WorkerRegistry();
  const [serverEnd, workerEnd] = createInProcessTransport();
  const connection = registry.accept(serverEnd, quiet);
  const received = rawWorker(workerEnd, "1.11");
  void connection.request("checkout.git.run", { json: {} });
  await settle();
  assert.deepEqual(
    received.map((frame) => frame.type),
    ["welcome", "request"],
  );
  assert.equal(registry.connection("w"), connection);
  assert.equal(registry.epoch("w"), 1);
  assert.equal(connection.isEnded, false);
});

test("the server speaks 1.10 and still welcomes a 1.0, 1.8 or 1.9 Worker", async () => {
  assert.equal(WORKER_PROTOCOL_VERSION, "1.10");
  for (const version of ["1.0", "1.8", "1.9"]) {
    const registry = new WorkerRegistry();
    const [serverEnd, workerEnd] = createInProcessTransport();
    const connection = registry.accept(serverEnd, quiet);
    const received = rawWorker(workerEnd, version);
    await settle();
    assert.deepEqual(
      received.map((frame) => frame.type),
      ["welcome"],
    );
    assert.equal(connection.isEnded, false);
  }
});

test("a Worker refuses a server on another major and accepts a higher minor", async () => {
  for (const [version, open] of [
    ["1.9", true],
    ["1.11", true],
    ["2.0", false],
    ["one", false],
  ] as const) {
    const [serverEnd, workerEnd] = createInProcessTransport();
    serverEnd.onData(() => undefined);
    serverEnd.onClose(() => undefined);
    const worker = new WorkerConnection(workerEnd, {
      handshake: { role: "worker", workerId: "w" },
    });
    serverEnd.write(encodeControlFrame({ type: "welcome", version }));
    await settle();
    assert.equal(worker.isEnded, !open, version);
    if (!open)
      assert.equal(await worker.ended, `the server speaks protocol ${version}`);
  }
});

test("a second connection under a connected id is refused; a reconnect is a new epoch", async () => {
  const registry = new WorkerRegistry();
  const dial = () => {
    const [serverEnd, workerEnd] = createInProcessTransport();
    const server = registry.accept(serverEnd, quiet);
    const worker = new WorkerConnection(workerEnd, {
      handshake: { role: "worker", workerId: "w" },
    });
    return { server, worker };
  };
  const first = dial();
  await settle();
  assert.equal(registry.epoch("w"), 1);
  const second = dial();
  assert.match(await second.server.ended, /"w" is already connected/);
  assert.match(await second.worker.ended, /the server refused: /);
  assert.equal(registry.connection("w"), first.server);

  first.worker.end("test");
  await first.server.ended;
  assert.equal(registry.connection("w"), undefined);
  const third = dial();
  await settle();
  assert.equal(registry.connection("w"), third.server);
  assert.equal(registry.epoch("w"), 2, "the refused dial took no epoch");
});

/** The bytes of `header` as a frame carries it. */
const headerBytes = (header: object): number =>
  Buffer.byteLength(JSON.stringify(header));

/**
 * The longest repeat of `unit` with which `header` still fits the frame
 * header cap, so a hello carrying it is legal.
 */
function budgeted(unit: string, header: (text: string) => object): string {
  const unitBytes = headerBytes({ t: unit }) - headerBytes({ t: "" });
  const room = MAX_FRAME_HEADER_BYTES - headerBytes(header(""));
  return unit.repeat(Math.floor(room / unitBytes));
}

/** Plain ASCII, and characters JSON escapes, which quoting makes longer. */
const PEER_TEXT_UNITS = ["x", '"\\'];

/** `received` is one refusal, bounded and quoting the start of `text`. */
function boundedRefusal(received: Frame[], text: string): string {
  assert.deepEqual(
    received.map((frame) => frame.type),
    ["refused"],
  );
  const { reason } = received[0] as Extract<Frame, { type: "refused" }>;
  assert.ok(Buffer.byteLength(reason) < 1024, `${reason.length} characters`);
  assert.ok(reason.includes(JSON.stringify(text.slice(0, 64)).slice(0, -1)));
  return reason;
}

test("a refusal quotes a hello's version bounded, however long the hello", async () => {
  for (const unit of PEER_TEXT_UNITS) {
    const hello = (version: string) => ({
      type: "hello",
      workerId: "w",
      version,
    });
    const version = budgeted(unit, hello);
    assert.ok(headerBytes(hello(version)) <= MAX_FRAME_HEADER_BYTES);
    // Base's reason held the version whole, which put its refusal over the cap.
    assert.ok(
      headerBytes({
        type: "refused",
        version: WORKER_PROTOCOL_VERSION,
        reason: `Worker protocol ${version} cannot talk to ${WORKER_PROTOCOL_VERSION}.`,
      }) > MAX_FRAME_HEADER_BYTES,
    );
    const registry = new WorkerRegistry();
    const [serverEnd, workerEnd] = createInProcessTransport();
    const connection = registry.accept(serverEnd, quiet);
    const received = rawWorker(workerEnd, version);
    const ended = await connection.ended;
    await settle();
    const reason = boundedRefusal(received, version);
    assert.match(reason, /^Worker protocol ".*"… cannot talk to 1\.10\.$/s);
    assert.equal(ended, `refused: ${reason}`);
    assert.equal(registry.connection("w"), undefined);
    assert.equal(registry.epoch("w"), undefined);
  }
});

test("a refusal quotes a connected Worker id bounded, and that Worker stays served", async () => {
  for (const unit of PEER_TEXT_UNITS) {
    const hello = (workerId: string) => ({
      type: "hello",
      workerId,
      version: WORKER_PROTOCOL_VERSION,
    });
    const id = budgeted(unit, hello);
    assert.ok(headerBytes(hello(id)) <= MAX_FRAME_HEADER_BYTES);
    assert.ok(
      headerBytes({
        type: "refused",
        version: WORKER_PROTOCOL_VERSION,
        reason: `Worker "${id}" is already connected.`,
      }) > MAX_FRAME_HEADER_BYTES,
    );
    const registry = new WorkerRegistry();
    const [firstServerEnd, firstWorkerEnd] = createInProcessTransport();
    const first = registry.accept(firstServerEnd, quiet);
    const worker = new WorkerConnection(firstWorkerEnd, {
      handshake: { role: "worker", workerId: id },
      handlers: { "test.worker.echo": async (payload) => payload },
    });
    await settle();
    assert.equal(registry.connection(id), first);

    const [serverEnd, workerEnd] = createInProcessTransport();
    const second = registry.accept(serverEnd, quiet);
    const received = rawWorker(workerEnd, WORKER_PROTOCOL_VERSION, id);
    const ended = await second.ended;
    await settle();
    const reason = boundedRefusal(received, id);
    assert.match(reason, /^Worker ".*"… is already connected\.$/s);
    assert.equal(ended, `refused: ${reason}`);
    assert.equal(registry.connection(id), first);
    assert.equal(registry.epoch(id), 1);
    assert.deepEqual(
      (await first.request("test.worker.echo", { json: 1 })).json,
      1,
    );
    assert.equal(first.isEnded, false);
    worker.end("test");
  }
});

test("a local error while handling peer bytes ends only that connection, logged once", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const registry = new WorkerRegistry();
    const [healthyServerEnd, healthyWorkerEnd] = createInProcessTransport();
    const healthy = registry.accept(healthyServerEnd, quiet);
    const healthyWorker = new WorkerConnection(healthyWorkerEnd, {
      handshake: { role: "worker", workerId: "w" },
      handlers: { "test.worker.echo": async (payload) => payload },
    });

    const defect = new Error("admit broke");
    const [serverEnd, workerEnd] = createInProcessTransport();
    const broken = new WorkerConnection(serverEnd, {
      handshake: {
        role: "server",
        admit: () => {
          throw defect;
        },
      },
    });
    const worker = new WorkerConnection(workerEnd, {
      handshake: { role: "worker", workerId: "other" },
    });
    assert.equal(await broken.ended, "protocol error: admit broke");
    assert.equal(await worker.ended, "the peer closed the connection");
    await settle();
    assert.equal(errors.mock.calls.length, 1);
    assert.equal(errors.mock.calls[0]![1], defect);

    assert.deepEqual(
      (await healthy.request("test.worker.echo", { json: 1 })).json,
      1,
    );
    assert.equal(healthy.isEnded, false);
    healthyWorker.end("test");
  } finally {
    errors.mockRestore();
  }
});

test("an unknown method is a typed error both ways, and the connection stays usable", async () => {
  const registry = new WorkerRegistry();
  const [serverEnd, workerEnd] = createInProcessTransport();
  // A method only this test's server serves, for the Worker to call.
  const serverHandlers: MethodHandlers = {
    "test.server.echo": async (payload) => payload,
  };
  const server = registry.accept(serverEnd, {
    ...quiet,
    handlers: serverHandlers,
  });
  const worker = new WorkerConnection(workerEnd, {
    handshake: { role: "worker", workerId: "w" },
    handlers: { "test.worker.echo": async (payload) => payload },
  });
  for (const [from, to] of [
    [server, "test.worker.echo"],
    [worker, "test.server.echo"],
  ] as const) {
    await assert.rejects(
      from.request("test.missing", {}),
      (error: unknown) =>
        error instanceof WorkerRequestError &&
        error.code === UNKNOWN_METHOD &&
        error.message === 'Unknown method "test.missing".',
    );
    // An inherited property is not a method either.
    await assert.rejects(from.request("toString", {}), {
      code: UNKNOWN_METHOD,
    });
    const answer = await from.request(to, {
      json: { n: 1 },
      text: { t: "\uD83D" },
    });
    assert.deepEqual(answer.json, { n: 1 });
    assert.equal(answer.text!.t, "\uD83D");
  }
  assert.equal(server.isEnded, false);
  assert.equal(worker.isEnded, false);
});

test("an end rejects unsent requests at once and sent ones only after quiescence", async () => {
  const registry = new WorkerRegistry();
  const [serverEnd, workerEnd] = createInProcessTransport();
  let quiesce!: () => void;
  const server = registry.accept(serverEnd, {
    quiescence: () => new Promise<void>((resolve) => (quiesce = resolve)),
  });
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  const worker = new WorkerConnection(workerEnd, {
    handshake: { role: "worker", workerId: "w" },
    handlers: {
      "test.hang": (_payload, signal) => {
        started();
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("stop"))),
        );
      },
    },
  });
  let sentSettled = false;
  const sent = server.request("test.hang", {}).finally(() => {
    sentSettled = true;
  });
  await running;

  // A second server connection still in its handshake holds an unsent one.
  const [pendingEnd] = createInProcessTransport();
  pendingEnd.onData(() => undefined);
  const pending = registry.accept(pendingEnd, quiet);
  const unsent = pending.request("test.hang", {});
  pending.end("test");
  await assert.rejects(unsent, /The Worker connection ended: test\./);

  // Withdrawing before the send rejects as not sent.
  const [laterEnd] = createInProcessTransport();
  const later = registry.accept(laterEnd, quiet);
  const controller = new AbortController();
  const withdrawn = later.request("test.hang", {}, controller.signal);
  controller.abort();
  await assert.rejects(withdrawn, WorkerRequestNotSentError);
  later.end("test");

  worker.end("test");
  await server.ended;
  await settle();
  assert.equal(sentSettled, false, "held until the Worker is quiescent");
  quiesce();
  await assert.rejects(sent, /The Worker connection ended: the peer closed/);
});
