import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import {
  ENGINE_GONE,
  ENGINE_METHODS,
  EngineCommandError,
  encodeEngineEvents,
  type EngineItem,
  type HostedEngineHost,
  type HostedEngineItem,
} from "../workerProtocol/engineMethods.ts";
import {
  engineDeliveries,
  openEngineChannel,
  type EngineChannel,
} from "./engineClient.ts";
import {
  ensureInProcessWorker,
  inProcessWorkerQuiescentForTests,
  registerInProcessEngineFactory,
  writeAsInProcessWorkerForTests,
} from "./inProcessWorker.ts";

/**
 * The server's engine client over the in-process Worker, with a scripted
 * harness: answers settle only after the items before them are applied.
 */

let emit: ((item: HostedEngineItem) => void) | undefined;
let host: HostedEngineHost | undefined;
registerInProcessEngineFactory("scripted", async (_spec, engineHost) => {
  host = engineHost;
  return {
    info: { scripted: true },
    snapshot: () => ({ start: true }),
    command(name) {
      emit?.({ kind: "state", note: `${name} effect` });
      return name === "fail"
        ? Promise.reject(new Error("scripted failure"))
        : Promise.resolve(`${name} result`);
    },
    onItem(listener) {
      emit = listener;
    },
    async dispose() {},
  };
});

afterAll(async () => {
  const quiescent = inProcessWorkerQuiescentForTests();
  writeAsInProcessWorkerForTests(new Uint8Array(8));
  await quiescent;
});

interface Opened {
  channel: EngineChannel;
  applied: EngineItem[];
  /** Holds the next item's application until released. */
  hold(): () => void;
  lost: number;
}

async function openScripted(): Promise<Opened> {
  let gate: Promise<void> | undefined;
  const opened: Partial<Opened> & { applied: EngineItem[]; lost: number } = {
    applied: [],
    lost: 0,
  };
  const { info, value } = await openEngineChannel(
    ensureInProcessWorker(),
    "scripted",
    {},
    (answer, channel) => {
      assert.deepEqual(answer.snapshot, { start: true });
      return {
        value: channel,
        sink: {
          apply(item) {
            const held = gate;
            gate = undefined;
            if (held) return held.then(() => void opened.applied.push(item));
            opened.applied.push(item);
            return undefined;
          },
          onLost: () => (opened.lost += 1),
        },
      };
    },
  );
  assert.deepEqual(info, { scripted: true });
  opened.channel = value;
  opened.hold = () => {
    let release!: () => void;
    gate = new Promise((resolve) => (release = resolve));
    return release;
  };
  return opened as Opened;
}

async function settle(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

test("a result and a failure each settle only after the items emitted before them", async () => {
  const opened = await openScripted();
  const release = opened.hold();
  emit!({ kind: "event", n: 1 });
  // The last seq applied when each answer settled.
  let outcome: number | undefined;
  const result = opened.channel.command(1, "ok", []).then((value) => {
    outcome = opened.applied.at(-1)!.seq;
    return value;
  });
  let failure: number | undefined;
  const failed = opened.channel.command(2, "fail", []).catch((err: unknown) => {
    failure = opened.applied.at(-1)!.seq;
    return err;
  });
  await settle();
  assert.equal(outcome, undefined, "the answer waits for its items");
  assert.equal(failure, undefined);
  release();
  assert.equal(await result, "ok result");
  const err = await failed;
  assert.ok(err instanceof EngineCommandError);
  assert.equal((err as Error).message, "scripted failure");
  // The result answered at seq 2, the failure at seq 3.
  assert.ok(outcome! >= 2, `the result settled after seq ${outcome}`);
  assert.ok(failure! >= 3, `the failure settled after seq ${failure}`);
  assert.deepEqual(
    opened.applied.map((item) => [item.seq, item.kind]),
    [
      [1, "event"],
      [2, "state"],
      [3, "state"],
    ],
  );
});

test("an app-tool call reaches the server only after the engine's items are applied", async () => {
  const opened = await openScripted();
  const release = opened.hold();
  emit!({ kind: "event", n: 1 });
  emit!({ kind: "event", n: 2 });
  let applied: number | undefined;
  const call = host!
    .callAppTool(
      { sessionId: "nobody", tool: "x", toolCallId: "c", args: {} },
      {},
    )
    .catch(() => (applied = opened.applied.length));
  await settle();
  assert.equal(applied, undefined);
  release();
  await call;
  assert.equal(applied, 2, "both items were applied before the call went out");
});

test("a delivery for an engine this connection never opened is a typed error", async () => {
  const opened = await openScripted();
  const deliver = engineDeliveries(ensureInProcessWorker)[
    ENGINE_METHODS.events
  ]!;
  const signal = new AbortController().signal;
  await assert.rejects(
    deliver(
      encodeEngineEvents({
        engineId: opened.channel.engineId + 1000,
        items: [{ seq: 1, kind: "state" }],
      }),
      signal,
    ),
    { code: ENGINE_GONE },
  );
  // The engine it did open still takes its deliveries.
  await deliver(
    encodeEngineEvents({
      engineId: opened.channel.engineId,
      items: [{ seq: 1, kind: "state" }],
    }),
    signal,
  );
  assert.deepEqual(
    opened.applied.map((item) => item.seq),
    [1],
  );
});

test("connection end loses every engine: pending and later commands reject engine_gone", async () => {
  const opened = await openScripted();
  const release = opened.hold();
  emit!({ kind: "event", n: 1 });
  const pending = opened.channel.command(1, "ok", []);
  await settle();
  const quiescent = inProcessWorkerQuiescentForTests();
  writeAsInProcessWorkerForTests(new Uint8Array(8));
  await quiescent;
  await assert.rejects(pending, { code: ENGINE_GONE });
  release();
  await settle();
  assert.equal(opened.lost, 1);
  assert.deepEqual(
    opened.applied.map((item) => item.seq),
    [1],
    "the item mid-apply finishes; a lost engine applies nothing after it",
  );
  await assert.rejects(opened.channel.command(2, "ok", []), {
    code: ENGINE_GONE,
  });
  await opened.channel.dispose();
});
