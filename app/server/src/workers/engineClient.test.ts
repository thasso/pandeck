import assert from "node:assert/strict";
import net from "node:net";
import { afterAll, afterEach, test } from "vitest";
import { DEFAULT_OPENAI_PROFILE_ID } from "../credentialProfiles.ts";
import type { LeaseRecord } from "../gateway/leases.ts";
import {
  GATEWAY_UNAVAILABLE_TEXT,
  installedGatewayLink,
  startGatewayLink,
  type GatewayLink,
} from "../gatewayLink.ts";
import {
  startGatewayLinkForTests,
  type TestGatewayLink,
} from "../test/gatewayLink.ts";
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
  type EngineLeaseContext,
} from "./engineClient.ts";
import {
  ensureInProcessWorker,
  inProcessWorkerQuiescentForTests,
  inProcessWorkerServedMethodForTests,
  registerInProcessEngineFactory,
  writeAsInProcessWorkerForTests,
} from "./inProcessWorker.ts";

/**
 * The server's engine client over the in-process Worker, with a scripted
 * harness: answers settle only after the items before them are applied.
 */

let emit: ((item: HostedEngineItem) => void) | undefined;
let host: HostedEngineHost | undefined;
/** Runs as the factory receives `engine.open`, in the Worker. */
let atOpen: (() => void) | undefined;
registerInProcessEngineFactory("scripted", async (_spec, engineHost) => {
  atOpen?.();
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

async function openScripted(lease?: EngineLeaseContext): Promise<Opened> {
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
    lease,
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

test("a session-hook call reaches the server only after the engine's items are applied", async () => {
  const calls = {
    canUseTool: () =>
      host!.sessionHooks.canUseTool({ sessionId: "nobody", toolName: "Read" }),
    preToolUse: () =>
      host!.sessionHooks.preToolUse({
        sessionId: "nobody",
        epoch: "e",
        toolName: "Read",
        toolInput: {},
        toolUseId: "t",
      }),
    stop: () =>
      host!.sessionHooks.stop({ sessionId: "nobody", epoch: "e", tasks: [] }),
    postCompact: () =>
      host!.sessionHooks.postCompact({
        sessionId: "nobody",
        epoch: "e",
        summary: "s",
      }),
  };
  for (const [name, call] of Object.entries(calls)) {
    const opened = await openScripted();
    const release = opened.hold();
    emit!({ kind: "event", n: 1 });
    emit!({ kind: "event", n: 2 });
    let applied: number | undefined;
    const record = () => (applied = opened.applied.length);
    const settled = call().then(record, record);
    await settle();
    assert.equal(applied, undefined, `${name} waits for the items`);
    release();
    await settled;
    assert.equal(applied, 2, `${name}: both items were applied first`);
  }
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

registerInProcessEngineFactory("scripted-throws", async () => {
  atOpen?.();
  throw new Error("scripted open failure");
});

let gateway: TestGatewayLink | undefined;
const failedLinks: GatewayLink[] = [];
afterEach(async () => {
  atOpen = undefined;
  await gateway?.close();
  gateway = undefined;
  while (failedLinks.length) await failedLinks.pop()!.close();
});

const live = (records: LeaseRecord[]) =>
  records.filter((record) => record.revoked === undefined);

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition was not reached");
}

/** How many times the gateway revoked `leaseId` on request. */
const revokes = (leaseId: string) =>
  gateway!.lines.filter((line) =>
    line.startsWith(`control leases.revoke (lease ${leaseId})`),
  ).length;

test("with a link, a profiled open holds one engine lease from before engine.open to its end", async () => {
  gateway = await startGatewayLinkForTests();
  const lease = { profileId: DEFAULT_OPENAI_PROFILE_ID, sessionId: "s1" };
  let atFactory: LeaseRecord[] | undefined;
  atOpen = () => (atFactory = live(gateway!.engineLeases()));

  const disposed = await openScripted(lease);
  assert.equal(atFactory?.length, 1);
  const [held] = atFactory!;
  assert.deepEqual(held!.owner, { workerId: "local", sessionId: "s1" });
  assert.equal(held!.profileId, DEFAULT_OPENAI_PROFILE_ID);
  await disposed.channel.dispose();
  const ended = () =>
    gateway!.engineLeases().find((r) => r.leaseId === held!.leaseId);
  assert.equal(ended()?.revoked, "session-ended");

  // Connection end revokes; a later dispose revokes nothing again.
  const lost = await openScripted(lease);
  const lostLease = live(gateway.engineLeases())[0]!.leaseId;
  const quiescent = inProcessWorkerQuiescentForTests();
  writeAsInProcessWorkerForTests(new Uint8Array(8));
  await quiescent;
  await until(() => revokes(lostLease) === 1);
  await lost.channel.dispose();
  assert.equal(revokes(lostLease), 1);
  assert.equal(revokes(held!.leaseId), 1);
  assert.equal(
    gateway.engineLeases().find((r) => r.leaseId === lostLease)?.revoked,
    "session-ended",
  );

  // A factory that throws: the open rejects and its lease is revoked.
  const before = gateway.engineLeases().length;
  await assert.rejects(
    openEngineChannel(
      ensureInProcessWorker(),
      "scripted-throws",
      {},
      () => assert.fail("no answer to attach"),
      lease,
    ),
  );
  const thrown = gateway.engineLeases().slice(before);
  assert.equal(thrown.length, 1);
  assert.equal(thrown[0]!.revoked, "session-ended");
  assert.equal(revokes(thrown[0]!.leaseId), 1);

  // An open without a lease context grants nothing.
  const count = gateway.engineLeases().length;
  const plain = await openScripted();
  assert.equal(gateway.engineLeases().length, count);
  await plain.channel.dispose();
});

test("an open whose spec does not name its session completes the owner from the answer, before attach", async () => {
  gateway = await startGatewayLinkForTests();
  let atFactory: LeaseRecord[] | undefined;
  atOpen = () => (atFactory = live(gateway!.engineLeases()));
  let atAttach: LeaseRecord | undefined;
  const { value } = await openEngineChannel(
    ensureInProcessWorker(),
    "scripted",
    {},
    (_answer, channel) => {
      atAttach = live(gateway!.engineLeases())[0];
      return { value: channel, sink: { apply() {}, onLost() {} } };
    },
    {
      profileId: DEFAULT_OPENAI_PROFILE_ID,
      sessionIdOf: (info) =>
        (info as { scripted?: boolean }).scripted ? "minted-1" : undefined,
    },
  );
  assert.deepEqual(atFactory?.[0]?.owner, { workerId: "local" });
  assert.deepEqual(atAttach?.owner, {
    workerId: "local",
    sessionId: "minted-1",
  });
  await value.dispose();
});

test("without a link, a profiled open sends no control request and opens as before", async () => {
  assert.equal(installedGatewayLink(), undefined);
  const opened = await openScripted({
    profileId: DEFAULT_OPENAI_PROFILE_ID,
    sessionId: "s-none",
  });
  assert.deepEqual(await opened.channel.command(1, "ok", []), "ok result");
  await opened.channel.dispose();
});

test("a failed grant fails the open with U7's text before the Worker sees engine.open", async () => {
  const lease = { profileId: DEFAULT_OPENAI_PROFILE_ID, sessionId: "s2" };
  const opens = () => inProcessWorkerServedMethodForTests("engine.open");
  let factoryRuns = 0;
  atOpen = () => (factoryRuns += 1);

  // The gateway failed to start: its port is taken.
  const taken = net.createServer();
  await new Promise<void>((resolve) =>
    taken.listen(0, "127.0.0.1", () => resolve()),
  );
  const failed = startGatewayLink({
    stateDir: `${process.env.DATA_DIR}/gateway-failed`,
    port: (taken.address() as net.AddressInfo).port,
    log: () => {},
  });
  failedLinks.push(failed);
  assert.equal(await failed.ready, false);
  const before = opens();
  await assert.rejects(openScripted(lease), {
    message: GATEWAY_UNAVAILABLE_TEXT,
  });
  assert.equal(opens(), before);
  await failedLinks.pop()!.close();
  await new Promise<void>((resolve) => taken.close(() => resolve()));

  // The control connection ended.
  gateway = await startGatewayLinkForTests();
  await gateway.link.gateway!.close();
  await assert.rejects(openScripted(lease), {
    message: GATEWAY_UNAVAILABLE_TEXT,
  });
  assert.equal(opens(), before);
  assert.equal(factoryRuns, 0);
});
