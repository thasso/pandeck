/**
 * Background work end to end ([Task-486](pa://task/486)): validated
 * `ClientMessage`s driven through the real `Connection.handle`, against the
 * SINGLETON supervisor, the real store, the real settings file and the real hub.
 * Nothing here is faked except the provider backend port, which is what a
 * provider package registers in production.
 *
 * `backgroundWorkHumanStop.test.ts` beside this file injects fakes to pin the
 * Stop module's own decisions. That is not enough on its own: the dispatch, the
 * validator, the singleton wiring and the event that carries the result are the
 * route the feature actually travels, and all four can regress with every unit
 * test still green. The Settings card is here for the same reason — a control
 * can render its range correctly and still write a value the server rejects.
 *   pnpm --filter @assistant/server test src/backgroundWorkWiring.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import { Connection } from "./connection.ts";
import { validateClientMessage } from "./validateClientMessage.ts";
import { backgroundWorkStore } from "./db/backgroundWorkStore.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { hub } from "./hub.ts";
import { backgroundWorkSupervisor } from "./backgroundWork/supervisor.ts";
import { backgroundCompletionTurns } from "./backgroundWork/completionDelivery.ts";
import type {
  BackgroundWorkBackendPort,
  BackgroundWorkStopAllRequest,
} from "./backgroundWork/backends.ts";

/** Minimal open socket: `Connection` only reads `readyState`/`OPEN` and sends. */
function fakeSocket(sent: ServerMessage[]) {
  return {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0];
}

let serial = 0;

function makeOwner(): string {
  serial += 1;
  const id = `bg-wiring-${Date.now()}-${serial}`;
  sessionStore.upsert({
    id,
    scope: "user",
    harness: "pi",
    agentType: "developer",
    title: "owner",
    messageCount: 2,
  });
  return id;
}

/**
 * A reserved, executing item — what Stop actually targets. A `host-process`
 * item has no retained host epoch, so there is nothing to bind: its Stop state
 * reserves as `requested` rather than `awaiting-binding`.
 */
function runningItem(owner: string): string {
  serial += 1;
  const item = backgroundWorkStore.reserveItem({
    ownerSessionId: owner,
    backend: "host-process",
    kind: "shell",
    label: "pnpm run build",
    sourceRequestId: `src_${serial}`,
    lifetimeMs: 60 * 60 * 1000,
    settingsGeneration: 1,
    bootEpoch: "boot-wiring",
    ownerLimit: 1_000,
  });
  backgroundWorkStore.markRunning({ itemId: item.id });
  return item.id;
}

/**
 * The one fake: a provider backend port. In production the pi package registers
 * this exact shape, and the supervisor is the only caller either way.
 */
function fakePort(): BackgroundWorkBackendPort & {
  stopAllRequests: BackgroundWorkStopAllRequest[];
  hostCloses: number;
} {
  const stopAllRequests: BackgroundWorkStopAllRequest[] = [];
  return {
    backend: "host-process",
    stopAllRequests,
    hostCloses: 0,
    async launch() {
      return { launched: true };
    },
    async stop() {
      return { acknowledged: true };
    },
    async stopAll(request) {
      stopAllRequests.push(request);
      return {
        acknowledgedItemIds: backgroundWorkStore
          .listItems({
            ownerSessionId: request.ownerSessionId,
            state: "active",
          })
          .map((item) => item.id),
        unconfirmedItemIds: [],
      };
    },
  };
}

/**
 * Register the port on the SINGLETON for one test. The supervisor refuses a
 * second registration for a backend, so this reaches into its registry to undo
 * itself — the alternative is a fresh supervisor, which is exactly the wiring
 * this file exists to exercise.
 */
function withPort(port: BackgroundWorkBackendPort): () => void {
  const registry = (
    backgroundWorkSupervisor as unknown as {
      ports: Map<string, BackgroundWorkBackendPort>;
    }
  ).ports;
  const previous = registry.get(port.backend);
  registry.set(port.backend, port);
  return () => {
    if (previous) registry.set(port.backend, previous);
    else registry.delete(port.backend);
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

async function subscribedConnection(
  sent: ServerMessage[],
): Promise<Connection> {
  const connection = new Connection(fakeSocket(sent));
  hub.register(connection);
  cleanups.push(() => hub.unregister(connection));
  await connection.handle({ type: "subscribe", topics: ["background"] });
  return connection;
}

/** Send exactly what a browser sends, through the same validator the socket uses. */
async function send(
  connection: Connection,
  message: Record<string, unknown>,
): Promise<void> {
  const validated = validateClientMessage(message);
  assert.ok(
    validated.ok,
    `the validator rejected ${String(message.type)}: ${validated.ok ? "" : validated.reason}`,
  );
  await connection.handle(validated.msg as ClientMessage);
}

test("a validated Stop terminalizes the row and answers control feedback only", async () => {
  cleanups.push(withPort(fakePort()));
  const owner = makeOwner();
  const itemId = runningItem(owner);
  const sent: ServerMessage[] = [];
  const connection = await subscribedConnection(sent);
  sent.length = 0;

  await send(connection, {
    type: "stopBackgroundWork",
    itemId,
    requestId: "req-stop-1",
  });

  const answer = sent.find(
    (message) => message.type === "backgroundWorkStopAnswer",
  );
  assert.ok(answer && answer.type === "backgroundWorkStopAnswer");
  assert.equal(answer.requestId, "req-stop-1");
  assert.deepEqual(answer.items, [{ itemId, outcome: "stopped" }]);
  // Control feedback and NOTHING else: no row, no collection, no host detail.
  assert.deepEqual(Object.keys(answer).sort(), ["items", "requestId", "type"]);

  // The supervisor really terminalized it — the fact is durable, not asserted.
  const stored = backgroundWorkStore.getItem(itemId);
  assert.equal(stored?.state, "stopped");
  assert.equal(stored?.terminalReason, "stopped-by-owner");

  // And the browser learns it ONLY as a `background` state event.
  await hub.flushPendingBroadcastsForTests();
  const upserts = sent
    .filter(
      (message) =>
        message.type === "stateEvents" && message.topic === "background",
    )
    .flatMap((message) =>
      message.type === "stateEvents" ? message.events : [],
    )
    .filter((event) => event.id === itemId && event.kind === "upsert");
  assert.ok(upserts.length >= 1, "expected a background upsert for the row");
  const last = upserts.at(-1);
  assert.ok(last && last.kind === "upsert");
  assert.equal(last.item.state, "stopped");
});

test("an unknown id answers `unknown`, touches no row and emits no event", async () => {
  cleanups.push(withPort(fakePort()));
  const sent: ServerMessage[] = [];
  const connection = await subscribedConnection(sent);
  sent.length = 0;

  await send(connection, {
    type: "stopBackgroundWork",
    itemId: "bw_does_not_exist",
    requestId: "req-unknown",
  });

  const answer = sent.find(
    (message) => message.type === "backgroundWorkStopAnswer",
  );
  assert.ok(answer && answer.type === "backgroundWorkStopAnswer");
  assert.deepEqual(answer.items, [
    { itemId: "bw_does_not_exist", outcome: "unknown" },
  ]);
  // No row was touched, so nothing about this id can have been broadcast.
  // (Another test's rows may still be flushing on the shared hub, so the
  // assertion names THIS id rather than claiming silence.)
  await hub.flushPendingBroadcastsForTests();
  const events = sent
    .filter(
      (message) =>
        message.type === "stateEvents" && message.topic === "background",
    )
    .flatMap((message) =>
      message.type === "stateEvents" ? message.events : [],
    );
  assert.equal(
    events.some((event) => event.id === "bw_does_not_exist"),
    false,
  );
});

test("an oversized id is refused before any effect and never echoed back", async () => {
  cleanups.push(withPort(fakePort()));
  const sent: ServerMessage[] = [];
  const connection = await subscribedConnection(sent);
  sent.length = 0;
  const huge = "x".repeat(201);

  await send(connection, {
    type: "stopBackgroundWork",
    itemId: huge,
    requestId: "req-huge",
  });

  const answer = sent.find(
    (message) => message.type === "backgroundWorkStopAnswer",
  );
  assert.ok(answer && answer.type === "backgroundWorkStopAnswer");
  assert.deepEqual(answer.items, []);
  assert.equal(JSON.stringify(sent).includes(huge), false);
});

test("the Background processes card round-trips through updateSettings", async () => {
  const { getSettings } = await import("./settings.ts");
  const { BACKGROUND_WORK_SETTINGS_RANGES } = await import("@assistant/shared");
  const ranges = BACKGROUND_WORK_SETTINGS_RANGES;
  const before = getSettings().backgroundWork;
  cleanups.push(() => {
    void (async () => {
      const { updateSettings } = await import("./settings.ts");
      updateSettings({ backgroundWork: before });
    })();
  });
  const sent: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(sent));
  // The echo reaches every registered connection, the writer included.
  hub.register(connection);
  cleanups.push(() => hub.unregister(connection));

  // Both ends of every range, exactly what the card's inputs offer.
  for (const card of [
    {
      enabled: false,
      ownerSessionCap: ranges.ownerSessionCap.min,
      taskLifetimeMinutes: ranges.taskLifetimeMinutes.min,
      claudeEmptyHostGraceSeconds: ranges.claudeEmptyHostGraceSeconds.min,
    },
    {
      enabled: true,
      ownerSessionCap: ranges.ownerSessionCap.max,
      taskLifetimeMinutes: ranges.taskLifetimeMinutes.max,
      claudeEmptyHostGraceSeconds: ranges.claudeEmptyHostGraceSeconds.max,
    },
  ]) {
    sent.length = 0;
    await send(connection, {
      type: "updateSettings",
      patch: { backgroundWork: card },
    });
    // Durable, and echoed back verbatim: the card offers exactly what the
    // server stores, so nothing the UI can send comes back changed.
    assert.deepEqual(getSettings().backgroundWork, card);
    const echo = sent.find((message) => message.type === "settings");
    assert.ok(echo && echo.type === "settings");
    assert.deepEqual(echo.settings.backgroundWork, card);
  }

  // A hand-edited or older client's out-of-range card is CLAMPED, never stored.
  await send(connection, {
    type: "updateSettings",
    patch: {
      backgroundWork: {
        enabled: true,
        ownerSessionCap: 9_999,
        taskLifetimeMinutes: 0,
        claudeEmptyHostGraceSeconds: -5,
      },
    },
  });
  assert.deepEqual(getSettings().backgroundWork, {
    enabled: true,
    ownerSessionCap: ranges.ownerSessionCap.max,
    taskLifetimeMinutes: ranges.taskLifetimeMinutes.min,
    claudeEmptyHostGraceSeconds: ranges.claudeEmptyHostGraceSeconds.min,
  });
});

test("Stop-all protects the user's own turn and not a background-origin one", async () => {
  const port = fakePort();
  cleanups.push(withPort(port));

  // Wire the singleton exactly as `index.ts` does: the deployment's one turn
  // tracker, asked whether this owner's CURRENT turn is the user's own. Only
  // "is a turn running at all" is stubbed, because that reads a live driver.
  let turnRunning = false;
  const previousHandler = (
    backgroundWorkSupervisor as unknown as {
      ordinaryTurnActive: (ownerSessionId: string) => boolean;
    }
  ).ordinaryTurnActive;
  backgroundWorkSupervisor.setOrdinaryTurnActiveHandler((ownerSessionId) =>
    backgroundCompletionTurns.protectsOrdinaryTurn(ownerSessionId, turnRunning),
  );
  cleanups.push(() =>
    backgroundWorkSupervisor.setOrdinaryTurnActiveHandler(previousHandler),
  );

  const owner = makeOwner();
  const sent: ServerMessage[] = [];
  const connection = await subscribedConnection(sent);

  // 1. An ordinary prompted turn is running: Stop-all reserves, but the backend
  //    is told to protect that turn.
  runningItem(owner);
  turnRunning = true;
  await send(connection, {
    type: "stopAllBackgroundWork",
    ownerSessionId: owner,
    requestId: "req-all-1",
  });
  assert.equal(port.stopAllRequests.length, 1);
  assert.equal(port.stopAllRequests[0]?.protectOrdinaryTurn, true);
  // A human is not the owner session, so it must never claim to be one.
  assert.equal(port.stopAllRequests[0]?.callerSessionId, undefined);

  // 2. The SAME running turn, but it is background-origin — admitted through the
  //    completion tracker. The protection drops, which is the whole asymmetry.
  runningItem(owner);
  await backgroundCompletionTurns.run(owner, async (accepted) => {
    accepted();
    await send(connection, {
      type: "stopAllBackgroundWork",
      ownerSessionId: owner,
      requestId: "req-all-2",
    });
  });
  assert.equal(port.stopAllRequests.length, 2);
  assert.equal(port.stopAllRequests[1]?.protectOrdinaryTurn, false);

  const answers = sent.filter(
    (message) => message.type === "backgroundWorkStopAnswer",
  );
  assert.equal(answers.length, 2);
  for (const answer of answers) {
    assert.ok(answer.type === "backgroundWorkStopAnswer");
    assert.equal(answer.ownerSessionId, owner);
    // Still control feedback only, even for the owner-wide escalation.
    assert.deepEqual(
      Object.keys(answer)
        .filter((key) => key !== "hostCloseWaiting")
        .sort(),
      ["items", "ownerSessionId", "requestId", "type"],
    );
  }
});
