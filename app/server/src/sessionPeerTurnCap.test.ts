import { expect, test, vi } from "vitest";
import { isSessionPeerTurnCap } from "@assistant/shared";
vi.mock("./hub.ts", () => ({ hub: { broadcastSessions: vi.fn() } }));
const { sessionStore } = await import("./db/sessionStore.ts");
const { closeDb } = await import("./db/index.ts");
const {
  directPeerTurnCapOf,
  setSessionPeerTurnCap,
  admitDirectPeerTurns,
  recordDirectPeerChild,
  resetDirectPeerChildrenForTests,
} = await import("./peerSpawnRuntimes.ts");
const inspection = await import("./tools/sessions/sessionInspection.ts");
// Load the mocked notification module before synchronous setters fire-and-forget.
await import("./hub.ts");

function create(id: string) {
  sessionStore.upsert({ id, harness: "pi", agentType: "assistant" });
}

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

test("lowering gates new counted starts without touching running or low-cost peers", async () => {
  const id = "cap-admission";
  create(id);
  resetDirectPeerChildrenForTests();
  const state = vi
    .spyOn(inspection, "runtimeStateFor")
    .mockResolvedValue("running");
  try {
    setSessionPeerTurnCap(id, 6);
    for (let i = 0; i < 5; i++)
      recordDirectPeerChild(id, `counted-${i}`, "counted");
    for (let i = 0; i < 20; i++) recordDirectPeerChild(id, `low-${i}`, "low");
    (await admitDirectPeerTurns(id, 1)).release();
    await expect(admitDirectPeerTurns(id, 2)).rejects.toThrow(
      /at most 6.*inspector/,
    );
    setSessionPeerTurnCap(id, 2);
    (await admitDirectPeerTurns(id, 0)).release();
    await expect(admitDirectPeerTurns(id, 1)).rejects.toThrow(/at most 2/);
    expect(
      state.mock.calls.every(([child]) => child.startsWith("counted-")),
    ).toBe(true);
  } finally {
    state.mockRestore();
    resetDirectPeerChildrenForTests();
  }
});

test("a queued admission reads the cap inside its critical section", async () => {
  const id = "cap-lock";
  create(id);
  resetDirectPeerChildrenForTests();
  recordDirectPeerChild(id, "blocked-child", "counted");
  let unblock!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const state = vi
    .spyOn(inspection, "runtimeStateFor")
    .mockImplementation(async () => {
      entered();
      await blocked;
      return "running";
    });
  try {
    setSessionPeerTurnCap(id, 2);
    const first = admitDirectPeerTurns(id, 1);
    await ready;
    const second = admitDirectPeerTurns(id, 3);
    setSessionPeerTurnCap(id, 6);
    unblock();
    const claims = await Promise.all([first, second]);
    claims.forEach((claim) => claim.release());
  } finally {
    unblock();
    state.mockRestore();
    resetDirectPeerChildrenForTests();
  }
});
