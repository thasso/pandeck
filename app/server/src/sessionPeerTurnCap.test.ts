import { expect, test, vi } from "vitest";
import { isSessionPeerTurnCap } from "@assistant/shared";
const hubLoad = vi.hoisted(() => vi.fn());
vi.mock("./hub.ts", () => {
  hubLoad();
  return { hub: {} };
});
const { sessionStore } = await import("./db/sessionStore.ts");
const { closeDb } = await import("./db/index.ts");
const {
  directPeerTurnCapOf,
  setSessionPeerTurnCap,
  admitDirectPeerTurns,
  recordDirectPeerChild,
  resetDirectPeerChildrenForTests,
  setPeerTurnCapChangedHook,
} = await import("./peerSpawnRuntimes.ts");
const inspection = await import("./tools/sessions/sessionInspection.ts");

function create(id: string) {
  sessionStore.upsert({ id, harness: "pi", agentType: "assistant" });
}

test("a synchronous cap write does not start loading the session hub", async () => {
  const id = "cap-no-hub-load";
  create(id);
  setSessionPeerTurnCap(id, 6);
  await vi.dynamicImportSettled();
  expect(hubLoad).not.toHaveBeenCalled();
});

test("cap bounds reject non-integers and non-numbers", () => {
  for (const value of [1, 16]) expect(isSessionPeerTurnCap(value)).toBe(true);
  for (const value of [0, 17, 1.5, NaN, "4", null])
    expect(isSessionPeerTurnCap(value)).toBe(false);
});

test("cap persists, survives metadata refresh and reset returns to four", () => {
  const id = "cap-durable";
  create(id);
  expect(directPeerTurnCapOf(id)).toBe(4);
  setSessionPeerTurnCap(id, 9);
  create(id);
  closeDb();
  expect(sessionStore.get(id)?.peerTurnCap).toBe(9);
  expect(directPeerTurnCapOf(id)).toBe(9);
  for (const cap of [0, 17, 2.5])
    expect(() => setSessionPeerTurnCap(id, cap)).toThrow();
  expect(
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "assistant",
      peerTurnCap: 17,
    }),
  ).toBe(false);
  expect(directPeerTurnCapOf(id)).toBe(9);
  setSessionPeerTurnCap(id, null);
  expect(sessionStore.get(id)?.peerTurnCap).toBeUndefined();
  expect(directPeerTurnCapOf(id)).toBe(4);
  expect(() => setSessionPeerTurnCap("cap-missing", 8)).toThrow();
  sessionStore.markDeleted(id);
  expect(() => setSessionPeerTurnCap(id, 8)).toThrow();
});

/** A direct child of `spawner`, as the spawn path records one. */
function recordChild(
  spawner: string,
  child: string,
  costClass: "low" | "counted",
) {
  recordDirectPeerChild({
    childSessionId: child,
    spawnerSessionId: spawner,
    costClass,
    source: { kind: "profile", profileId: "pr_test" },
    provider: "openai-codex",
    modelId: "gpt-5.6-terra",
    thinkingLevel: "medium",
    credentialProfileId: "codex-acct",
    createdAt: Date.now(),
  });
}

const counted = (n: number) =>
  Array.from({ length: n }, () => "counted" as const);

/** Release a claim and the hold tickets it handed out. */
function settle(claim: Awaited<ReturnType<typeof admitDirectPeerTurns>>) {
  claim.release();
  for (const row of claim.rows)
    if ("holdSeq" in row) claim.settleHold(row.holdSeq);
}

const decisions = (claim: Awaited<ReturnType<typeof admitDirectPeerTurns>>) =>
  claim.rows.map((row) => ("start" in row ? "start" : "hold"));

test("lowering holds new counted starts without touching running or low-cost peers", async () => {
  const id = "cap-admission";
  create(id);
  resetDirectPeerChildrenForTests();
  const state = vi.fn((_child: string) => "running" as const);
  const reader = vi
    .spyOn(inspection, "runtimeStateReader")
    .mockResolvedValue(state);
  try {
    setSessionPeerTurnCap(id, 6);
    for (let i = 0; i < 5; i++) recordChild(id, `counted-${i}`, "counted");
    for (let i = 0; i < 20; i++) recordChild(id, `low-${i}`, "low");
    const one = await admitDirectPeerTurns(id, counted(1));
    expect(decisions(one)).toEqual(["start"]);
    settle(one);
    // Six allowed, five running: the second row waits instead of the batch
    // being refused.
    const two = await admitDirectPeerTurns(id, counted(2));
    expect(decisions(two)).toEqual(["start", "hold"]);
    settle(two);
    setSessionPeerTurnCap(id, 2);
    settle(await admitDirectPeerTurns(id, []));
    const lowered = await admitDirectPeerTurns(id, ["counted", "low", "low"]);
    expect(decisions(lowered)).toEqual(["hold", "start", "start"]);
    settle(lowered);
    expect(
      state.mock.calls.every(([child]) => child.startsWith("counted-")),
    ).toBe(true);
  } finally {
    reader.mockRestore();
    resetDirectPeerChildrenForTests();
  }
});

test("a queued admission reads the cap inside its critical section", async () => {
  const id = "cap-lock";
  create(id);
  resetDirectPeerChildrenForTests();
  recordChild(id, "blocked-child", "counted");
  let unblock!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const state = vi
    .spyOn(inspection, "runtimeStateReader")
    .mockImplementation(async () => {
      entered();
      await blocked;
      return () => "running";
    });
  try {
    setSessionPeerTurnCap(id, 2);
    const first = admitDirectPeerTurns(id, counted(1));
    await ready;
    const second = admitDirectPeerTurns(id, counted(3));
    setSessionPeerTurnCap(id, 6);
    unblock();
    const claims = await Promise.all([first, second]);
    // At the cap of 2 the second batch would wait for two of its rows.
    expect(claims.map(decisions)).toEqual([
      ["start"],
      ["start", "start", "start"],
    ]);
    claims.forEach(settle);
  } finally {
    unblock();
    state.mockRestore();
    resetDirectPeerChildrenForTests();
  }
});

test("an invalid cap throws synchronously and schedules no start", () => {
  const wake = vi.fn();
  setPeerTurnCapChangedHook(wake);
  try {
    const id = "cap-invalid";
    create(id);
    for (const cap of [0, 17, 2.5])
      expect(() => setSessionPeerTurnCap(id, cap)).toThrow();
    expect(() => setSessionPeerTurnCap("cap-nobody", 3)).toThrow();
    expect(wake).not.toHaveBeenCalled();
    // A valid write persists before it returns, then schedules the wake.
    expect(setSessionPeerTurnCap(id, 3)).toBeUndefined();
    expect(directPeerTurnCapOf(id)).toBe(3);
    expect(wake).toHaveBeenCalledExactlyOnceWith(id);
  } finally {
    setPeerTurnCapChangedHook(undefined);
  }
});
