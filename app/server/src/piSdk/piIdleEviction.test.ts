/**
 * The pi harness's idle release waits out a prompt already on its way in: a
 * prompt admitted at the door (awaiting its skills, memory and so on before it
 * runs) keeps the session resident, as does a run, an acquisition restarts the
 * clock, and an instance released anyway is refused at the door rather than
 * bound again.
 *
 * Run through Vitest: `pnpm --filter @assistant/server test src/piSdk/piIdleEviction.test.ts`
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "pi-idle-eviction-test-"));
process.env.ASSISTANT_CWD = tmp;

const { PiLiveSession } = await import("./PiLiveSession.ts");
const { HARNESS_IDLE_EVICT_MS } = await import("../harness.ts");
const { sessionRuntime } = await import("../session/runtimeInstance.ts");
const { ensureRuntimeSessionWithRuntime } =
  await import("../session/runtimePrompt.ts");
const { closeDb } = await import("../db/index.ts");

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

let counter = 0;

/** A pi session nobody views, with the eviction it reports. */
function idleSession() {
  const sessionId = `pi-idle-${Date.now()}-${counter++}`;
  let disposed = 0;
  const evicted: string[] = [];
  const live = new PiLiveSession(
    "coding" as never,
    {
      sessionId,
      sessionName: "Already named",
      isStreaming: false,
      sessionManager: { getBranch: () => [] },
      subscribe: () => () => {},
      getSessionStats: () => ({
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        contextSize: 0,
      }),
      prompt: () => Promise.resolve(),
      dispose: () => {
        disposed += 1;
      },
    } as never,
    {
      broadcastSessions: () => Promise.resolve(),
      noteRunStarted: () => {},
      checkPendingReload: () => {},
      isReloadQueued: () => false,
      browserRuntimesFor: () => [],
    } as never,
    (key) => evicted.push(key),
  );
  live.armIdleIfUnviewed();
  return { sessionId, live, evicted, disposed: () => disposed };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("an admitted prompt keeps an idle pi session resident until it settles", () => {
  const { sessionId, live, evicted } = idleSession();
  const admitted = sessionRuntime.admitPrompt(sessionId);
  vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS * 3);
  assert.equal(live.released, false);
  assert.deepEqual(evicted, []);

  admitted();
  vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS);
  assert.equal(live.released, true);
  assert.deepEqual(evicted, [sessionId]);
});

test("an acquisition restarts the clock", () => {
  const { live } = idleSession();
  vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS - 1_000);
  live.armIdleIfUnviewed();
  vi.advanceTimersByTime(2_000);
  assert.equal(live.released, false);
  vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS);
  assert.equal(live.released, true);
});

test("a run outlasting the clock keeps the session, which gets a full grace after it", () => {
  const { sessionId, live, evicted } = idleSession();
  const { toolId } = live.beginSyntheticTool("/commit", {});
  // An acquisition mid-run starts the clock; running out mid-run releases nothing.
  live.armIdleIfUnviewed();
  vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS * 3);
  assert.equal(live.released, false);

  live.finishSyntheticTool(toolId, "done");
  vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS - 1);
  assert.equal(live.released, false);
  vi.advanceTimersByTime(1);
  assert.equal(live.released, true);
  assert.deepEqual(evicted, [sessionId]);
});

test("a released pi session is refused at the door, and nothing is bound", () => {
  const { sessionId, live, disposed } = idleSession();
  vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS);
  assert.equal(disposed(), 1);
  assert.throws(
    () => ensureRuntimeSessionWithRuntime(sessionRuntime, live),
    /released from memory/,
  );
  assert.equal(sessionRuntime.get(sessionId), undefined);
});
