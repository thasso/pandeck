import assert from "node:assert/strict";
import { test } from "vitest";
import type { BackgroundWorkLaunchRequest } from "../backgroundWork/backends.ts";
import {
  BACKGROUND_WORK_METHODS,
  decodeAdmitRequest,
  decodeLaunchAck,
  decodeStopAck,
  decodeStopAllAck,
  encodeBackgroundWork,
  type BackgroundWorkReporter,
  type BackgroundWorkRunner,
} from "../workerProtocol/backgroundWorkMethods.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import {
  WorkerConnection,
  type MethodHandlers,
} from "../workerProtocol/connection.ts";
import { createInProcessTransport } from "../workerProtocol/inProcessTransport.ts";
import { backgroundWorkTable } from "./backgroundWork.ts";

/**
 * The Worker's background-work table over the real codec: a fake server on
 * one end, the table's handlers and admitter on the other, fake runners.
 */

const RESERVATION_GONE = "the pi launch reservation is no longer available";
const UNAVAILABLE = "the owned process group or socket is unavailable";

/** Let in-process deliveries run. */
async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

function launchRequest(
  itemId: string,
  ownerSessionId: string,
): BackgroundWorkLaunchRequest {
  return {
    target: { itemId, ownerSessionId, kind: "monitor-command" },
    deadlineAt: Date.now() + 60_000,
    emptyHostGraceMs: 0,
  };
}

/** A runner whose work runs until stopped or finished. */
function fakeRunner(ownerSessionId: string) {
  let reporter: BackgroundWorkReporter | undefined;
  let finish!: () => void;
  let stops = 0;
  let launches = 0;
  const runner: BackgroundWorkRunner = {
    ownerSessionId,
    kind: "monitor-command",
    launch(_request, reports) {
      launches += 1;
      reporter = reports;
      const done = new Promise<void>((resolve) => (finish = resolve));
      return Promise.resolve({
        launched: true,
        run: {
          done,
          stop: () => {
            stops += 1;
            finish();
            return Promise.resolve();
          },
        },
      });
    },
  };
  return {
    runner,
    reporter: () => reporter!,
    finish: () => finish(),
    stops: () => stops,
    launches: () => launches,
  };
}

/**
 * A connected pair. `admit` is the fake server's admission: it may launch on
 * the server connection under the request's key before answering.
 */
async function pair(
  serverHandlers: (server: () => WorkerConnection) => MethodHandlers,
) {
  const [serverEnd, workerEnd] = createInProcessTransport();
  let worker!: WorkerConnection;
  const table = backgroundWorkTable((method, payload, signal) =>
    worker.request(method, payload, signal),
  );
  const server: WorkerConnection = new WorkerConnection(serverEnd, {
    handshake: { role: "server", admit: () => undefined },
    handlers: serverHandlers(() => server),
  });
  worker = new WorkerConnection(workerEnd, {
    handshake: { role: "worker", workerId: "table-test" },
    handlers: table.handlers,
    onEnd: () => table.end(),
  });
  await settle();
  return { server, worker, table, close: () => serverEnd.close() };
}

const ACK = encodeBackgroundWork({});

/** A fake server admission that launches each item under its request's key. */
function launchingAdmit(server: () => WorkerConnection, itemIds: string[]) {
  return async (payload: Payload) => {
    const request = decodeAdmitRequest(payload);
    const itemId = itemIds.shift()!;
    const ack = decodeLaunchAck(
      await server().request(
        BACKGROUND_WORK_METHODS.launch,
        encodeBackgroundWork({
          launchKey: request.launchKey,
          request: launchRequest(itemId, request.sessionId),
        }),
      ),
    );
    return encodeBackgroundWork(
      ack.launched
        ? { admitted: true, itemId, state: "running", reused: false }
        : { admitted: false, message: ack.reason ?? "" },
    );
  };
}

const ADMISSION = {
  kind: "monitor-command" as const,
  label: "probe",
  command: "probe",
};

function admission(sessionId: string, serial: number) {
  return { ...ADMISSION, sessionId, sourceRequestId: `request-${serial}` };
}

function stopPayload(itemId: string, ownerSessionId: string): Payload {
  return encodeBackgroundWork({
    target: { itemId, ownerSessionId, kind: "monitor-command" },
    sourceRequestId: `stop-${itemId}`,
    attempt: 1,
    reason: "test Stop",
  });
}

test("a launch whose key names no live reservation is refused", async () => {
  let launchKey = "";
  const { server, table } = await pair(() => ({
    [BACKGROUND_WORK_METHODS.admit]: async (payload) => {
      launchKey = decodeAdmitRequest(payload).launchKey;
      return encodeBackgroundWork({ admitted: false, message: "denied" });
    },
  }));
  const unknown = decodeLaunchAck(
    await server.request(
      BACKGROUND_WORK_METHODS.launch,
      encodeBackgroundWork({
        launchKey: "launch-unknown",
        request: launchRequest("bgw_unknown", "owner-a"),
      }),
    ),
  );
  assert.deepEqual(unknown, { launched: false, reason: RESERVATION_GONE });
  // Once its admission was answered, the key is gone too.
  const { runner } = fakeRunner("owner-a");
  assert.deepEqual(
    await table.admitter.admit(admission("owner-a", 1), runner),
    {
      admitted: false,
      message: "denied",
    },
  );
  const late = decodeLaunchAck(
    await server.request(
      BACKGROUND_WORK_METHODS.launch,
      encodeBackgroundWork({
        launchKey,
        request: launchRequest("bgw_late", "owner-a"),
      }),
    ),
  );
  assert.deepEqual(late, { launched: false, reason: RESERVATION_GONE });
});

test("a launch for another owner than the reservation's is refused", async () => {
  const { table } = await pair((server) => ({
    [BACKGROUND_WORK_METHODS.admit]: async (payload) => {
      const request = decodeAdmitRequest(payload);
      const ack = decodeLaunchAck(
        await server().request(
          BACKGROUND_WORK_METHODS.launch,
          encodeBackgroundWork({
            launchKey: request.launchKey,
            request: launchRequest("bgw_other", "owner-b"),
          }),
        ),
      );
      return encodeBackgroundWork({
        admitted: false,
        message: ack.reason ?? "",
      });
    },
  }));
  const fake = fakeRunner("owner-a");
  assert.deepEqual(
    await table.admitter.admit(admission("owner-a", 1), fake.runner),
    { admitted: false, message: RESERVATION_GONE },
  );
  assert.equal(fake.launches(), 0);
});

test("a Stop for an item another owner holds is unavailable and stops nothing", async () => {
  const { server, table } = await pair((connection) => ({
    [BACKGROUND_WORK_METHODS.admit]: launchingAdmit(connection, ["bgw_a"]),
  }));
  const fake = fakeRunner("owner-a");
  await table.admitter.admit(admission("owner-a", 1), fake.runner);
  const ack = decodeStopAck(
    await server.request(
      BACKGROUND_WORK_METHODS.stop,
      stopPayload("bgw_a", "owner-b"),
    ),
  );
  assert.deepEqual(ack, { acknowledged: false, evidence: UNAVAILABLE });
  assert.equal(fake.stops(), 0);
  assert.deepEqual(
    decodeStopAck(
      await server.request(
        BACKGROUND_WORK_METHODS.stop,
        stopPayload("bgw_a", "owner-a"),
      ),
    ),
    { acknowledged: true },
  );
  assert.equal(fake.stops(), 1);
});

test("Stop-all stops only the owner's reserved items", async () => {
  const { server, table } = await pair((connection) => ({
    [BACKGROUND_WORK_METHODS.admit]: launchingAdmit(connection, [
      "bgw_1",
      "bgw_2",
      "bgw_3",
    ]),
  }));
  const reserved = fakeRunner("owner-a");
  const unreserved = fakeRunner("owner-a");
  const other = fakeRunner("owner-b");
  await table.admitter.admit(admission("owner-a", 1), reserved.runner);
  await table.admitter.admit(admission("owner-a", 2), unreserved.runner);
  await table.admitter.admit(admission("owner-b", 3), other.runner);
  const ack = decodeStopAllAck(
    await server.request(
      BACKGROUND_WORK_METHODS.stopAll,
      encodeBackgroundWork({
        ownerSessionId: "owner-a",
        sourceRequestId: "stop-all",
        attempt: 1,
        reason: "test Stop-all",
        itemIds: ["bgw_1", "bgw_3"],
        protectOrdinaryTurn: false,
      }),
    ),
  );
  assert.deepEqual(ack, {
    acknowledgedItemIds: ["bgw_1"],
    unconfirmedItemIds: [],
  });
  assert.deepEqual(
    [reserved.stops(), unreserved.stops(), other.stops()],
    [1, 0, 0],
  );
});

test("an item's reports follow its admission's answer, one at a time, in order", async () => {
  const arrived: string[] = [];
  let releaseAdmit!: () => void;
  const admitHeld = new Promise<void>((resolve) => (releaseAdmit = resolve));
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
  const fake = fakeRunner("owner-a");
  const record =
    (name: string) =>
    async (payload: Payload): Promise<Payload> => {
      const { eventId } = payload.json as { eventId?: string };
      arrived.push(eventId ? `${name}:${eventId}` : name);
      if (eventId === "a1") await firstHeld;
      return ACK;
    };
  const { server, table } = await pair((connection) => ({
    [BACKGROUND_WORK_METHODS.admit]: async (payload) => {
      const answer = launchingAdmit(connection, ["bgw_order"])(payload);
      const answered = await answer;
      // Reports made before the admission is answered wait for it.
      fake.reporter().activity({
        itemId: "bgw_order",
        lines: ["one"],
        bytes: 4,
        droppedEventCount: 0,
        eventId: "a1",
      });
      await admitHeld;
      return answered;
    },
    [BACKGROUND_WORK_METHODS.activity]: record("activity"),
    [BACKGROUND_WORK_METHODS.output]: record("output"),
    [BACKGROUND_WORK_METHODS.completed]: record("completed"),
  }));
  const admitted = table.admitter.admit(admission("owner-a", 1), fake.runner);
  await settle();
  assert.deepEqual(arrived, []);
  releaseAdmit();
  await admitted;
  await settle();
  assert.deepEqual(arrived, ["activity:a1"]);
  // The first report's answer is slow: nothing overtakes it.
  fake.reporter().activity({
    itemId: "bgw_order",
    lines: ["two"],
    bytes: 4,
    droppedEventCount: 0,
    eventId: "a2",
  });
  const output = fake
    .reporter()
    .output({ itemId: "bgw_order", eventId: "o1", writeFailed: true });
  fake.reporter().completed({ itemId: "bgw_order", state: "completed" });
  fake.finish();
  let stopAnswered = false;
  const stopping = server
    .request(BACKGROUND_WORK_METHODS.stop, stopPayload("bgw_order", "owner-a"))
    .finally(() => (stopAnswered = true));
  await settle();
  assert.deepEqual(arrived, ["activity:a1"]);
  // A Stop is answered only once every report the item made has settled.
  assert.equal(stopAnswered, false);
  releaseFirst();
  await output;
  assert.deepEqual(decodeStopAck(await stopping), { acknowledged: true });
  assert.deepEqual(arrived, [
    "activity:a1",
    "activity:a2",
    "output:o1",
    "completed",
  ]);
});

test("a report the server refuses is dropped and the next one still goes out", async () => {
  const arrived: string[] = [];
  const fake = fakeRunner("owner-a");
  const { table } = await pair((connection) => ({
    [BACKGROUND_WORK_METHODS.admit]: launchingAdmit(connection, ["bgw_drop"]),
    [BACKGROUND_WORK_METHODS.output]: () =>
      Promise.reject(new Error("refused")),
    [BACKGROUND_WORK_METHODS.completed]: async () => {
      arrived.push("completed");
      return ACK;
    },
  }));
  await table.admitter.admit(admission("owner-a", 1), fake.runner);
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => warnings.push(message);
  try {
    await fake
      .reporter()
      .output({ itemId: "bgw_drop", eventId: "o1", writeFailed: true });
    fake.reporter().completed({ itemId: "bgw_drop", state: "completed" });
    await settle();
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(arrived, ["completed"]);
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0]!,
    /^\[background\] backgroundWork\.output report failed for bgw_drop: /,
  );
});

test("the connection's end stops every held item and refuses new admissions", async () => {
  const fake = fakeRunner("owner-a");
  const { table, close, worker } = await pair((connection) => ({
    [BACKGROUND_WORK_METHODS.admit]: launchingAdmit(connection, ["bgw_end"]),
  }));
  await table.admitter.admit(admission("owner-a", 1), fake.runner);
  assert.equal(fake.stops(), 0);
  close();
  await worker.ended;
  assert.equal(fake.stops(), 1);
  await assert.rejects(
    table.admitter.admit(admission("owner-a", 2), fakeRunner("owner-a").runner),
    /The Worker connection ended\./,
  );
});
