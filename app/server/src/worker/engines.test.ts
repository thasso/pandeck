import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { APP_TOOL_METHODS } from "../workerProtocol/appToolMethods.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import {
  WorkerConnection,
  WorkerRequestError,
} from "../workerProtocol/connection.ts";
import {
  ENGINE_GONE,
  ENGINE_ID_TAKEN,
  ENGINE_METHODS,
  UNKNOWN_HARNESS,
  decodeEngineCommandAnswer,
  decodeEngineEvents,
  decodeEngineOpened,
  encodeEngineCommand,
  encodeEngineDispose,
  encodeEngineOpen,
  type EngineEvents,
  type HostedEngine,
  type HostedEngineFactory,
  type HostedEngineHost,
  type HostedEngineItem,
} from "../workerProtocol/engineMethods.ts";
import { createInProcessTransport } from "../workerProtocol/inProcessTransport.ts";
import { startWorker, type RunningWorker } from "./worker.ts";

/**
 * The Worker's engine table over the real codec and connection, with a fake
 * JSON factory and a bare server end: what any server gets from it.
 */

interface FakeEngine extends HostedEngine {
  host: HostedEngineHost;
  emit(item: HostedEngineItem): void;
  commands: string[];
  disposed: number;
  /** Settles a command started with the name `hold:<key>`. */
  release(key: string, value?: unknown): void;
}

function fakeEngine(host: HostedEngineHost, label: string): FakeEngine {
  let listener: ((item: HostedEngineItem) => void) | undefined;
  const held = new Map<string, (value: unknown) => void>();
  const engine: FakeEngine = {
    host,
    info: { label },
    snapshot: () => ({ label, emitted: 0 }),
    commands: [],
    disposed: 0,
    emit: (item) => listener?.(item),
    release: (key, value) => held.get(key)?.(value),
    command(name, args) {
      engine.commands.push(name);
      if (name.startsWith("hold:"))
        return new Promise((resolve) => held.set(name.slice(5), resolve));
      if (name === "fail") {
        engine.emit({ kind: "state", note: "before failure" });
        return Promise.reject(new Error("the command failed"));
      }
      if (name === "emit") engine.emit({ kind: "state", note: args });
      return Promise.resolve({ ran: name, args });
    },
    onItem(receive) {
      listener = receive;
    },
    async dispose() {
      engine.disposed += 1;
    },
  };
  return engine;
}

interface Harness {
  server: WorkerConnection;
  worker: RunningWorker;
  engines: FakeEngine[];
  deliveries: EngineEvents[];
  /** Holds the next acknowledgements until released. */
  holdAcks(): () => void;
  appToolCalls: number;
}

const harnesses: Harness[] = [];

function start(options: { factory?: HostedEngineFactory } = {}): Harness {
  const [serverEnd, workerEnd] = createInProcessTransport();
  let ackHold: Promise<void> | undefined;
  const harness: Harness = {
    server: undefined as unknown as WorkerConnection,
    worker: undefined as unknown as RunningWorker,
    engines: [],
    deliveries: [],
    appToolCalls: 0,
    holdAcks() {
      let release!: () => void;
      ackHold = new Promise((resolve) => (release = resolve));
      return () => {
        ackHold = undefined;
        release();
      };
    },
  };
  harness.server = new WorkerConnection(serverEnd, {
    handshake: { role: "server", admit: () => undefined },
    handlers: {
      [ENGINE_METHODS.events]: async (payload: Payload) => {
        harness.deliveries.push(decodeEngineEvents(payload));
        if (ackHold) await ackHold;
        return { json: {} };
      },
      [APP_TOOL_METHODS.call]: async () => {
        harness.appToolCalls += 1;
        return { json: { content: [{ type: "text", text: "ok" }] } };
      },
    },
  });
  const factory: HostedEngineFactory =
    options.factory ??
    (async (spec, host) => {
      const engine = fakeEngine(
        host,
        String((spec as { label: string }).label),
      );
      harness.engines.push(engine);
      return engine;
    });
  harness.worker = startWorker({
    workerId: "w",
    transport: workerEnd,
    childEnv: () => ({}),
    engines: (harness) => (harness === "fake" ? factory : undefined),
  });
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.server.end("test over");
    await harness.worker.quiescent;
  }
});

async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

const open = (
  server: WorkerConnection,
  engineId: number,
  harness = "fake",
  label = `e${engineId}`,
) =>
  server
    .request(
      ENGINE_METHODS.open,
      encodeEngineOpen({ engineId, harness, spec: { label } }),
    )
    .then(decodeEngineOpened);

const command = (
  server: WorkerConnection,
  engineId: number,
  commandId: number,
  name: string,
  args: unknown = [],
) =>
  server
    .request(
      ENGINE_METHODS.command,
      encodeEngineCommand({ engineId, commandId, command: name, args }),
    )
    .then(decodeEngineCommandAnswer);

const rejectsWith = (code: string) => (err: unknown) =>
  err instanceof WorkerRequestError && err.code === code;

test("an open answers the factory's info and snapshot; an unknown harness and a taken id are typed errors", async () => {
  const { server, worker } = start();
  assert.deepEqual(await open(server, 1), {
    info: { label: "e1" },
    snapshot: { label: "e1", emitted: 0 },
    seq: 0,
  });
  await assert.rejects(open(server, 2, "claude"), rejectsWith(UNKNOWN_HARNESS));
  await assert.rejects(open(server, 1), rejectsWith(ENGINE_ID_TAKEN));
  assert.equal(server.isEnded, false, "typed errors leave the connection open");
  assert.equal(worker.engines(), 1);
});

test("an id is taken while its engine opens", async () => {
  let release!: () => void;
  const opened: FakeEngine[] = [];
  const { server, worker } = start({
    factory: async (_spec, host) => {
      await new Promise<void>((resolve) => (release = resolve));
      const engine = fakeEngine(host, "slow");
      opened.push(engine);
      return engine;
    },
  });
  const first = open(server, 5);
  await settle();
  await assert.rejects(open(server, 5), rejectsWith(ENGINE_ID_TAKEN));
  release();
  assert.equal((await first).seq, 0);
  assert.equal(opened.length, 1);
  assert.equal(worker.engines(), 1);
});

test("commands start in arrival order; a command that never settles holds back none", async () => {
  const { server, engines } = start();
  await open(server, 1);
  const engine = engines[0]!;
  command(server, 1, 1, "hold:turn").catch(() => {});
  const second = command(server, 1, 2, "abort");
  assert.deepEqual(await second, {
    seq: 0,
    result: { ran: "abort", args: [] },
  });
  assert.deepEqual(engine.commands, ["hold:turn", "abort"]);
  await assert.rejects(
    command(server, 9, 1, "abort"),
    rejectsWith(ENGINE_GONE),
  );
});

test("a reply names the last item emitted before it, failures included", async () => {
  const { server, engines, deliveries } = start();
  await open(server, 1);
  assert.deepEqual(await command(server, 1, 1, "emit", "a"), {
    seq: 1,
    result: { ran: "emit", args: "a" },
  });
  assert.deepEqual(await command(server, 1, 2, "fail"), {
    seq: 2,
    error: { message: "the command failed" },
  });
  await settle();
  assert.deepEqual(
    deliveries.flatMap((delivery) => delivery.items),
    [
      { seq: 1, kind: "state", note: "a" },
      { seq: 2, kind: "state", note: "before failure" },
    ],
  );
  assert.equal(engines[0]!.commands.length, 2);
});

test("one delivery per engine is in flight; the next follows the acknowledgement, in order", async () => {
  const { server, engines, deliveries, holdAcks } = start();
  await open(server, 1);
  const engine = engines[0]!;
  const release = holdAcks();
  engine.emit({ kind: "event", n: 1 });
  engine.emit({ kind: "event", n: 2 });
  engine.emit({ kind: "event", n: 3 });
  await settle();
  assert.equal(deliveries.length, 1, "no second request before the ack");
  assert.deepEqual(deliveries[0]!.items, [{ seq: 1, kind: "event", n: 1 }]);
  release();
  await settle();
  assert.equal(deliveries.length, 2);
  assert.deepEqual(deliveries[1]!.items, [
    { seq: 2, kind: "event", n: 2 },
    { seq: 3, kind: "event", n: 3 },
  ]);
});

test("an engine's app-tool call waits until its queued items are acknowledged", async () => {
  const harness = start();
  await open(harness.server, 1);
  const engine = harness.engines[0]!;
  const release = harness.holdAcks();
  engine.emit({ kind: "event", n: 1 });
  engine.emit({ kind: "event", n: 2 });
  const call = engine.host.callAppTool(
    { sessionId: "s", tool: "t", toolCallId: "c", args: {} },
    {},
  );
  await settle();
  assert.equal(
    harness.appToolCalls,
    0,
    "the tool waits for the server's mirror",
  );
  release();
  assert.deepEqual(await call, { content: [{ type: "text", text: "ok" }] });
  assert.equal(harness.appToolCalls, 1);
  assert.equal(
    harness.deliveries.length,
    2,
    "both items were acknowledged first",
  );
});

test("dispose removes the engine; connection end disposes every engine", async () => {
  const { server, worker, engines } = start();
  await open(server, 1);
  await open(server, 2);
  assert.deepEqual(
    await server
      .request(
        ENGINE_METHODS.dispose,
        encodeEngineDispose({ engineId: 1, discard: { removeFile: {} } }),
      )
      .then((payload) => payload.json),
    {},
  );
  assert.equal(engines[0]!.disposed, 1);
  assert.equal(worker.engines(), 1);
  await assert.rejects(
    command(server, 1, 1, "abort"),
    rejectsWith(ENGINE_GONE),
  );
  server.end("test end");
  await worker.quiescent;
  assert.equal(engines[1]!.disposed, 1);
  assert.equal(engines[0]!.disposed, 1);
  assert.equal(worker.engines(), 0);
});

test("an engine whose factory returns after connection end is disposed once and never registered", async () => {
  let release!: () => void;
  const created: FakeEngine[] = [];
  const first = start({
    factory: async (_spec, host) => {
      await new Promise<void>((resolve) => (release = resolve));
      const engine = fakeEngine(host, "late");
      created.push(engine);
      return engine;
    },
  });
  const opening = open(first.server, 1);
  opening.catch(() => {});
  await settle();
  assert.equal(first.worker.engines(), 1, "reserved while opening");
  first.server.end("connection lost");
  await settle();
  release();
  await first.worker.quiescent;
  await assert.rejects(opening, /The Worker connection ended/);
  assert.equal(created.length, 1);
  assert.equal(created[0]!.disposed, 1);
  assert.equal(first.worker.engines(), 0);
  assert.deepEqual(first.deliveries, []);
  // A fresh connection (the next epoch) opens normally.
  const next = start();
  assert.equal((await open(next.server, 1)).seq, 0);
  assert.equal(next.worker.engines(), 1);
});
