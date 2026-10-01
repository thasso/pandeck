/**
 * Human Stop ([Task-486](pa://task/486)): what the browser's Stop and Stop-all
 * do, and — as much — what they refuse to claim.
 *   pnpm --filter @assistant/server test src/backgroundWorkHumanStop.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { BackgroundWorkItem } from "./db/backgroundWorkStore.ts";
import {
  stopAllBackgroundWorkForHuman,
  stopBackgroundWorkForHuman,
  type BackgroundWorkHumanStopDeps,
} from "./backgroundWorkHumanStop.ts";
import type {
  BackgroundWorkStopAllOwnerRequest,
  BackgroundWorkStopOneRequest,
  BackgroundWorkStopResult,
} from "./backgroundWork/supervisor.ts";

function itemRow(over: Partial<BackgroundWorkItem> = {}): BackgroundWorkItem {
  return {
    id: "bw_1",
    ownerSessionId: "owner-a",
    backend: "host-process",
    kind: "shell",
    label: "pnpm run build",
    sourceRequestId: "req",
    provenance: "reserved",
    state: "running",
    stopState: "none",
    stopAttempts: 0,
    lifetimeMs: 60_000,
    deadlineAt: 1_000,
    settingsGeneration: 1,
    bootEpoch: "boot",
    createdAt: 0,
    updatedAt: 0,
    revision: 1,
    ...over,
  } as BackgroundWorkItem;
}

interface Recorder {
  deps: BackgroundWorkHumanStopDeps;
  stopOneCalls: BackgroundWorkStopOneRequest[];
  stopAllCalls: BackgroundWorkStopAllOwnerRequest[];
}

function deps(
  over: Partial<{
    item: BackgroundWorkItem | undefined;
    stopOneResult: BackgroundWorkStopResult;
    stopAllResults: BackgroundWorkStopResult[];
    hostState: string | undefined;
    ordinaryTurnActive: boolean;
  }> = {},
): Recorder {
  const stopOneCalls: BackgroundWorkStopOneRequest[] = [];
  const stopAllCalls: BackgroundWorkStopAllOwnerRequest[] = [];
  const item = "item" in over ? over.item : itemRow();
  return {
    stopOneCalls,
    stopAllCalls,
    deps: {
      async stopOne(request) {
        stopOneCalls.push(request);
        return (
          over.stopOneResult ?? { state: "stopped", item: item ?? itemRow() }
        );
      },
      async stopAllOwner(request) {
        stopAllCalls.push(request);
        return over.stopAllResults ?? [];
      },
      getItem: (id) => (item && item.id === id ? item : undefined),
      hostStateForOwner: () => over.hostState,
      ordinaryTurnActive: () => over.ordinaryTurnActive ?? false,
    },
  };
}

test("Stop resolves the owner from the durable row, not from the client", async () => {
  const recorder = deps({ item: itemRow({ ownerSessionId: "owner-z" }) });
  const answer = await stopBackgroundWorkForHuman(
    "bw_1",
    "req-1",
    recorder.deps,
  );
  assert.equal(recorder.stopOneCalls.length, 1);
  assert.equal(recorder.stopOneCalls[0]?.ownerSessionId, "owner-z");
  // The source id names the HUMAN, so a retry from the browser is idempotent in
  // the store without colliding with the model tool's tool-call ids.
  assert.equal(recorder.stopOneCalls[0]?.sourceRequestId, "human:req-1");
  assert.deepEqual(answer.items, [{ itemId: "bw_1", outcome: "stopped" }]);
});

test("an unknown id answers `unknown` and reaches no domain service", async () => {
  const recorder = deps({ item: undefined });
  const answer = await stopBackgroundWorkForHuman(
    "nope",
    "req-2",
    recorder.deps,
  );
  assert.equal(recorder.stopOneCalls.length, 0);
  assert.deepEqual(answer.items, [{ itemId: "nope", outcome: "unknown" }]);
});

test("a malformed or oversized id is refused before anything is read", async () => {
  const recorder = deps();
  for (const bad of [undefined, "", "   ", "x".repeat(201), 7]) {
    const answer = await stopBackgroundWorkForHuman(bad, "r", recorder.deps);
    assert.deepEqual(answer.items, []);
  }
  assert.equal(recorder.stopOneCalls.length, 0);
});

test("an unacknowledged Stop stays unconfirmed instead of reading as closed", async () => {
  const recorder = deps({
    stopOneResult: {
      state: "stop-unconfirmed",
      item: itemRow({ stopState: "unconfirmed", stopAttempts: 2 }),
    },
  });
  const answer = await stopBackgroundWorkForHuman(
    "bw_1",
    "req-3",
    recorder.deps,
  );
  assert.deepEqual(answer.items, [
    { itemId: "bw_1", outcome: "stop-unconfirmed" },
  ]);
});

test("Stop-all never claims to be the owner's own turn", async () => {
  const recorder = deps({
    stopAllResults: [{ state: "stopped", item: itemRow() }],
  });
  const answer = await stopAllBackgroundWorkForHuman(
    "owner-a",
    "req-4",
    recorder.deps,
  );
  const call = recorder.stopAllCalls[0];
  assert.ok(call);
  assert.equal(call.ownerSessionId, "owner-a");
  // `callerSessionId` is what the supervisor reads as "the owner session itself
  // is asking". A human is not that caller, so it must be absent — otherwise a
  // background-origin turn would be protected from a Stop the user asked for.
  assert.equal(call.callerSessionId, undefined);
  assert.equal(answer.ownerSessionId, "owner-a");
  assert.deepEqual(answer.items, [{ itemId: "bw_1", outcome: "stopped" }]);
  assert.equal(answer.hostCloseWaiting, undefined);
});

test("a host still open after Stop-all is reported as a wait, with its reason", async () => {
  const protectedTurn = await stopAllBackgroundWorkForHuman(
    "owner-a",
    "req-5",
    deps({ hostState: "live", ordinaryTurnActive: true }).deps,
  );
  assert.deepEqual(protectedTurn.hostCloseWaiting, { protectedTurn: true });

  // Still open, but not because of the user's turn: the wait is stated without
  // inventing a protected turn that is not there.
  const draining = await stopAllBackgroundWorkForHuman(
    "owner-a",
    "req-6",
    deps({ hostState: "draining", ordinaryTurnActive: false }).deps,
  );
  assert.deepEqual(draining.hostCloseWaiting, { protectedTurn: false });

  for (const closed of ["closed", "stopped", "lost", undefined]) {
    const answer = await stopAllBackgroundWorkForHuman(
      "owner-a",
      "req-7",
      deps({ hostState: closed, ordinaryTurnActive: true }).deps,
    );
    assert.equal(answer.hostCloseWaiting, undefined);
  }
});

test("Stop-all reports every outcome the supervisor gave, verbatim", async () => {
  const recorder = deps({
    stopAllResults: [
      { state: "stopped", item: itemRow({ id: "a" }) },
      { state: "awaiting-binding", item: itemRow({ id: "b" }) },
      { state: "stop-unconfirmed", item: itemRow({ id: "c" }) },
      { state: "already-terminal", item: itemRow({ id: "d" }) },
      { state: "not-owner" },
    ],
  });
  const answer = await stopAllBackgroundWorkForHuman(
    "owner-a",
    "req-8",
    recorder.deps,
  );
  assert.deepEqual(answer.items, [
    { itemId: "a", outcome: "stopped" },
    { itemId: "b", outcome: "awaiting-binding" },
    { itemId: "c", outcome: "stop-unconfirmed" },
    { itemId: "d", outcome: "already-terminal" },
  ]);
});

test("an empty owner id reaches no domain service", async () => {
  const recorder = deps();
  const answer = await stopAllBackgroundWorkForHuman("  ", "r", recorder.deps);
  assert.equal(recorder.stopAllCalls.length, 0);
  assert.deepEqual(answer.items, []);
});
