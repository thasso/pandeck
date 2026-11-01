import assert from "node:assert/strict";
import { test } from "vitest";
import {
  FrameDecoder,
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
function rawWorker(workerEnd: ByteEndpoint, version: string) {
  const received: Frame[] = [];
  const decoder = new FrameDecoder();
  workerEnd.onData((bytes) => decoder.push(bytes, (f) => received.push(f)));
  workerEnd.onClose(() => undefined);
  workerEnd.write(
    encodeControlFrame({ type: "hello", workerId: "w", version }),
  );
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
  assert.match(await connection.ended, /cannot talk to 1\.9/);
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
  const received = rawWorker(workerEnd, "1.10");
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

test("the server speaks 1.9 and still welcomes a 1.0 or 1.8 Worker", async () => {
  assert.equal(WORKER_PROTOCOL_VERSION, "1.9");
  for (const version of ["1.0", "1.8"]) {
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
