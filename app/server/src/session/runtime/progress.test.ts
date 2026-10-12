/**
 * The run progress tracker on its own, under fake timers: what publishes at
 * once, what is coalesced, and that nothing from an ended run is published
 * into the next one.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { RunProgress } from "@assistant/shared/session";
import { runProgressPhase } from "@assistant/shared/session";
import { PROGRESS_COALESCE_MS, RunProgressTracker } from "./progress.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

function track() {
  const published: RunProgress[] = [];
  const tracker = new RunProgressTracker((progress) =>
    published.push(progress),
  );
  return { tracker, published };
}

test("a run starts waiting on the model and publishes at once", () => {
  const { tracker, published } = track();
  tracker.start();
  assert.equal(published.length, 1);
  assert.equal(runProgressPhase(published[0]!), "waiting");
  assert.equal(published[0]!.awaitingModelSince, 1_000_000);
  assert.equal(published[0]!.observedAt, 1_000_000);
  // A second start while one is tracked changes nothing.
  tracker.start();
  assert.equal(published.length, 1);
});

test("nothing is tracked or published before a run starts", () => {
  const { tracker, published } = track();
  tracker.modelOutput();
  tracker.toolStarted("t1", "bash");
  tracker.toolEnded("t1", false);
  tracker.retry({ attempt: 1 });
  tracker.activity();
  vi.advanceTimersByTime(10 * PROGRESS_COALESCE_MS);
  assert.equal(published.length, 0);
  assert.equal(tracker.snapshot(), undefined);
});

test("the first output after a wait publishes at once; more output is coalesced", () => {
  const { tracker, published } = track();
  tracker.start();
  vi.advanceTimersByTime(5_000);
  tracker.modelOutput();
  assert.equal(published.length, 2, "waiting → receiving is a transition");
  assert.equal(runProgressPhase(published[1]!), "receiving");
  assert.equal(published[1]!.lastModelOutputAt, 1_005_000);

  // A burst of deltas inside the window publishes nothing until it closes.
  for (let i = 0; i < 50; i++) {
    vi.advanceTimersByTime(20);
    tracker.modelOutput();
  }
  assert.equal(published.length, 2);
  vi.advanceTimersByTime(PROGRESS_COALESCE_MS);
  assert.equal(published.length, 3, "one trailing publish for the burst");
  assert.equal(published[2]!.lastModelOutputAt, 1_006_000);
  // Silence publishes nothing further: a quiet provider does not advance.
  vi.advanceTimersByTime(60_000);
  assert.equal(published.length, 3);
});

test("parallel tools: a finished tool never hides one still running", () => {
  const { tracker, published } = track();
  tracker.start();
  tracker.toolStarted("a", "bash");
  vi.advanceTimersByTime(1_000);
  tracker.toolStarted("b", "read");
  assert.equal(published.length, 3, "each tool start publishes at once");
  assert.deepEqual(
    published[2]!.runningTools.map((tool) => tool.toolCallId),
    ["a", "b"],
  );
  vi.advanceTimersByTime(1_000);
  tracker.toolEnded("a", true);
  const afterA = published.at(-1)!;
  assert.equal(runProgressPhase(afterA), "tool", "b still runs");
  assert.deepEqual(
    afterA.runningTools.map((tool) => tool.toolCallId),
    ["b"],
  );
  assert.deepEqual(afterA.lastTool, {
    name: "bash",
    state: "failed",
    at: 1_002_000,
  });
  assert.equal(afterA.awaitingModelSince, undefined);

  vi.advanceTimersByTime(1_000);
  tracker.toolEnded("b", false);
  const afterB = published.at(-1)!;
  assert.equal(runProgressPhase(afterB), "waiting", "results went back");
  assert.equal(afterB.awaitingModelSince, 1_003_000);
  assert.equal(afterB.lastTool?.state, "completed");
});

test("a completion for a tool this run never started changes nothing", () => {
  const { tracker, published } = track();
  tracker.start();
  tracker.toolStarted("live", "bash");
  const before = published.length;
  tracker.toolEnded("from-an-earlier-run", false);
  // The durable copy of a completion already reported live is the same case.
  tracker.toolEnded("live", false);
  tracker.toolEnded("live", false);
  assert.equal(published.length, before + 1);
  assert.equal(published.at(-1)!.lastTool?.name, "bash");
});

test("a provider retry is reported until the model answers", () => {
  const { tracker, published } = track();
  tracker.start();
  vi.advanceTimersByTime(30_000);
  tracker.retry({ attempt: 2, maxAttempts: 10, delayMs: 4_000, status: 529 });
  const retrying = published.at(-1)!;
  assert.equal(runProgressPhase(retrying), "retrying");
  assert.deepEqual(retrying.retry, {
    attempt: 2,
    maxAttempts: 10,
    delayMs: 4_000,
    status: 529,
    at: 1_030_000,
  });
  // The wait is measured from the input, not from the retry report.
  assert.equal(retrying.awaitingModelSince, 1_000_000);
  tracker.modelOutput();
  const answered = published.at(-1)!;
  assert.equal(answered.retry, undefined);
  assert.equal(runProgressPhase(answered), "receiving");
});

test("a transition takes a pending coalesced publish with it", () => {
  const { tracker, published } = track();
  tracker.start();
  tracker.modelOutput(); // transition
  tracker.modelOutput(); // coalesced: timer armed
  const before = published.length;
  tracker.toolStarted("t", "bash");
  assert.equal(published.length, before + 1);
  vi.advanceTimersByTime(PROGRESS_COALESCE_MS * 2);
  assert.equal(published.length, before + 1, "the armed publish was dropped");
});

test("stop drops a pending publish; the next run starts clean", () => {
  const { tracker, published } = track();
  tracker.start();
  tracker.toolStarted("old", "bash");
  tracker.toolEnded("old", false);
  tracker.modelOutput();
  tracker.modelOutput(); // armed
  const before = published.length;
  tracker.stop();
  vi.advanceTimersByTime(PROGRESS_COALESCE_MS * 2);
  assert.equal(published.length, before, "nothing after the run ended");
  assert.equal(tracker.snapshot(), undefined);

  vi.setSystemTime(2_000_000);
  tracker.start();
  const fresh = published.at(-1)!;
  assert.equal(fresh.startedAt, 2_000_000);
  assert.deepEqual(fresh.runningTools, []);
  assert.equal(fresh.lastTool, undefined);
  assert.equal(fresh.lastModelOutputAt, undefined);
  // A late completion of the old run's tool cannot touch the new one.
  tracker.toolEnded("old", false);
  assert.equal(published.at(-1), fresh);
});

test("tool output moves activity without changing the phase", () => {
  const { tracker, published } = track();
  tracker.start();
  tracker.toolStarted("t", "bash");
  vi.advanceTimersByTime(PROGRESS_COALESCE_MS + 1);
  tracker.activity();
  assert.equal(
    published.at(-1)!.lastActivityAt,
    1_000_000 + PROGRESS_COALESCE_MS + 1,
  );
  assert.equal(runProgressPhase(published.at(-1)!), "tool");
});

test("snapshots are copies: a reader cannot mutate the tracker", () => {
  const { tracker } = track();
  tracker.start();
  tracker.toolStarted("t", "bash");
  const snap = tracker.snapshot()!;
  snap.runningTools.length = 0;
  assert.equal(tracker.snapshot()!.runningTools.length, 1);
});
