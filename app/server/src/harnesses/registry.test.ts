/**
 * `harnessRegistry`: which engine holds a session, and how both stores reach
 * the hub. Routing an id that has to be opened from disk is covered end to end
 * by `sessionResolver.test.ts`.
 *   pnpm --filter @assistant/server test src/harnesses/registry.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "harness-registry-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { harnessRegistry } = await import("./registry.ts");
const { claudeSdkStore } = await import("../claudeSdk/claudeSdkStore.ts");
const { PiSessionDeletedError, piStore } = await import("../piSdk/piStore.ts");
const { sessionStore } = await import("../db/sessionStore.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

/** A stand-in for a resident session of either engine. */
const resident = (id: string) => ({ id, sessionId: id }) as never;

test("a resident session is found in the store its metadata row names", () => {
  const claude = resident("claude-row");
  const pi = resident("pi-row");
  vi.spyOn(claudeSdkStore, "get").mockImplementation((id) =>
    id === "claude-row" ? claude : undefined,
  );
  vi.spyOn(piStore, "getLiveById").mockImplementation((id) =>
    id === "pi-row" ? pi : undefined,
  );
  sessionStore.upsert({
    id: "claude-row",
    harness: "claude-sdk",
    agentType: "assistant",
  });
  sessionStore.upsert({ id: "pi-row", harness: "pi", agentType: "assistant" });

  assert.equal(harnessRegistry.residentById("claude-row"), claude);
  assert.equal(harnessRegistry.residentById("pi-row"), pi);
  assert.equal(harnessRegistry.residentById("nobody"), undefined);
});

test("a resident session without a metadata row is looked for in both stores", () => {
  const claude = resident("claude-new");
  const pi = resident("pi-new");
  vi.spyOn(claudeSdkStore, "get").mockImplementation((id) =>
    id === "claude-new" ? claude : undefined,
  );
  vi.spyOn(piStore, "getLiveById").mockImplementation((id) =>
    id === "pi-new" ? pi : undefined,
  );
  assert.equal(harnessRegistry.residentById("claude-new"), claude);
  assert.equal(harnessRegistry.residentById("pi-new"), pi);
});

test("every resident session is listed, pi's first", () => {
  const pi = resident("pi-a");
  const claude = resident("claude-a");
  vi.spyOn(piStore, "list").mockReturnValue([pi]);
  vi.spyOn(claudeSdkStore, "list").mockReturnValue([claude]);
  assert.deepEqual(harnessRegistry.resident(), [pi, claude]);
});

test("a pi reopen the delete beat is no session, not a failure", async () => {
  vi.spyOn(piStore, "getForDrive").mockReturnValue(undefined);
  vi.spyOn(claudeSdkStore, "getForDrive").mockReturnValue(undefined);
  sessionStore.upsert({
    id: "pi-deleted",
    harness: "pi",
    agentType: "assistant",
  });
  vi.spyOn(piStore, "acquireByRecordId").mockRejectedValue(
    new PiSessionDeletedError("pi-deleted"),
  );
  assert.equal(await harnessRegistry.acquireById("pi-deleted"), undefined);

  vi.spyOn(piStore, "acquireByRecordId").mockRejectedValue(new Error("boom"));
  await assert.rejects(harnessRegistry.acquireById("pi-deleted"), /boom/);
});

test("a resident session is driven as it is, with a full idle grace", async () => {
  const pi = resident("pi-live");
  const getForDrive = vi.spyOn(piStore, "getForDrive").mockReturnValue(pi);
  const reopen = vi.spyOn(piStore, "acquireByRecordId");
  assert.equal(await harnessRegistry.acquireById("pi-live"), pi);
  assert.deepEqual(getForDrive.mock.calls, [["pi-live"]]);
  assert.equal(reopen.mock.calls.length, 0);
});

test("both stores reach the hub through one host", () => {
  const calls: string[] = [];
  const setPiHost = vi.spyOn(piStore, "setHost");
  const setOnChange = vi.spyOn(claudeSdkStore, "setOnChange");
  const setProvider = vi.spyOn(claudeSdkStore, "setBrowserRuntimesProvider");
  const host = {
    broadcastSessions: async () => {
      calls.push("broadcastSessions");
    },
    noteRunStarted: () => {},
    checkPendingReload: () => {
      calls.push("checkPendingReload");
    },
    isReloadQueued: () => false,
    browserRuntimesFor: (sessionId: string) => {
      calls.push(`browserRuntimesFor:${sessionId}`);
      return [];
    },
  };
  harnessRegistry.setHost(host);

  assert.equal(setPiHost.mock.calls[0]?.[0], host);
  // A Claude session changing re-lists and re-checks a queued reload.
  setOnChange.mock.calls[0]?.[0]();
  setProvider.mock.calls[0]?.[0]("s1");
  assert.deepEqual(calls, [
    "broadcastSessions",
    "checkPendingReload",
    "browserRuntimesFor:s1",
  ]);
});
