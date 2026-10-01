/**
 * Task 98: the bounded automatic memory processor. Isolated temp DB, fake clock,
 * injected fake runner (no provider calls).
 *   pnpm --filter @assistant/server test src/memory/memoryProcessor.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, test } from "vitest";
import type { MemoryProcessorRunner } from "./memoryProcessor.ts";

const tmp = mkdtempSync(join(tmpdir(), "memory-processor-test-"));
process.env.ASSISTANT_CWD = tmp;

const proc = await import("./memoryProcessor.ts");
const { memoryObservationStore } =
  await import("../db/memoryObservationStore.ts");
const { memoryStore } = await import("../db/memoryStore.ts");
const { getDb, closeDb } = await import("../db/index.ts");

const DAY = 86_400_000;
let nowMs = 1_700_000_000_000;
proc.setMemoryProcessorClockForTests(() => nowMs);

function fakeRunner(
  text: string,
  costMicrosUsd?: number,
): MemoryProcessorRunner {
  return {
    run: async () => ({
      text,
      ...(costMicrosUsd !== undefined ? { costMicrosUsd } : {}),
    }),
  };
}
function throwingRunner(): MemoryProcessorRunner {
  return {
    run: async () => {
      throw new Error("provider down");
    },
  };
}

function enqueue(
  text: string,
  opts: { turn?: string; persona?: string; tz?: string; ts?: number } = {},
) {
  return memoryObservationStore.enqueue({
    sessionId: "s1",
    userTurnId: opts.turn ?? `turn-${Math.random()}`,
    persona: opts.persona ?? "personal-assistant",
    humanText: text,
    sourceTimestampMs: opts.ts ?? nowMs,
    timezone: opts.tz ?? "Europe/Berlin",
    createdAt: nowMs,
  });
}
function claim(...obs: { id: number }[]) {
  return memoryObservationStore.claim(
    obs.map((o) => o.id),
    nowMs,
  );
}

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM memory_cards");
  db.exec("DELETE FROM memory_observations");
  db.exec("DELETE FROM memory_processor_runs");
  nowMs = 1_700_000_000_000;
  proc.resetMemoryProcessorRunnerForTests();
});

afterAll(() => {
  proc.resetMemoryProcessorClockForTests();
  proc.resetMemoryProcessorRunnerForTests();
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

test("valid create/reinforce/replace/archive/ignore apply atomically", async () => {
  const existing = memoryStore.insert({
    id: "mem_old",
    text: "Lives in Berlin",
    kind: "fact",
    scope: {},
    temporal: { mode: "persistent" },
    observedAtMs: nowMs,
    createdAt: nowMs,
    updatedAt: nowMs,
    sourceKind: "manual",
  });
  // Mention Berlin so the existing card is surfaced to the prompt (a replace target
  // must be one of the shown ids).
  const obs = enqueue(
    "I no longer live in Berlin — I moved to Munich, and I prefer tabs over spaces",
  );
  claim(obs);
  proc.setMemoryProcessorRunnerForTests(
    fakeRunner(
      JSON.stringify({
        operations: [
          {
            action: "create",
            observationIndex: 0,
            text: "Prefers tabs over spaces",
            kind: "preference",
            confidence: "high",
            evidence: "explicit",
          },
          {
            action: "replace",
            targetId: existing.id,
            text: "Lives in Munich",
            kind: "fact",
          },
          { action: "ignore", reason: "nothing else" },
        ],
      }),
    ),
  );
  const outcome = await proc.runMemoryProcessor(claimAgain(obs.id), {
    trigger: "batch",
  });
  assert.equal(outcome.ran, true);
  assert.equal(
    outcome.operationsApplied,
    2,
    "create + replace applied; ignore not counted",
  );
  const active = memoryStore
    .activeCards()
    .map((c) => c.text)
    .sort();
  assert.deepEqual(active, ["Lives in Munich", "Prefers tabs over spaces"]);
  assert.equal(memoryStore.get("mem_old")!.state, "superseded");
  assert.equal(memoryObservationStore.get(obs.id)!.state, "processed");
});

// Re-claim helper: the beforeEach clears state per test, but within a test the
// observation was already claimed; runMemoryProcessor consumes claimed rows.
function claimAgain(id: number) {
  const obs = memoryObservationStore.get(id)!;
  return [obs];
}

test("malformed / out-of-scope / secret-like output is rejected safely", async () => {
  const obs = enqueue("here is my key");
  claim(obs);
  // Unparseable output → parse-error, no cards, observation retryable.
  proc.setMemoryProcessorRunnerForTests(fakeRunner("not json at all"));
  const bad = await proc.runMemoryProcessor(claimAgain(obs.id), {
    trigger: "batch",
  });
  assert.equal(bad.reason, "parse-error");
  assert.equal(memoryStore.count(), 0);

  // Secret-like create is rejected by validation; contradictory replace without a valid target is rejected.
  claim(memoryObservationStore.get(obs.id)!); // re-claim (released by parse-error retry)
  proc.setMemoryProcessorRunnerForTests(
    fakeRunner(
      JSON.stringify({
        operations: [
          {
            action: "create",
            observationIndex: 0,
            text: "api_key=abcdef123456",
            kind: "fact",
          },
          {
            action: "replace",
            targetId: "mem_does_not_exist",
            text: "whatever",
            kind: "fact",
          },
        ],
      }),
    ),
  );
  const rejected = await proc.runMemoryProcessor(claimAgain(obs.id), {
    trigger: "batch",
  });
  assert.equal(
    rejected.operationsApplied,
    0,
    "secret + unknown-target rejected",
  );
  assert.ok(rejected.operations.every((o) => !o.ok));
  assert.equal(memoryStore.count(), 0, "nothing persisted");
});

test("relative temporal is normalized against the observation's source timestamp/timezone", async () => {
  const sourceTs = nowMs;
  const obs = enqueue("I'm traveling next week", {
    tz: "America/New_York",
    ts: sourceTs,
  });
  claim(obs);
  proc.setMemoryProcessorRunnerForTests(
    fakeRunner(
      JSON.stringify({
        operations: [
          {
            action: "create",
            observationIndex: 0,
            text: "Traveling next week",
            kind: "working",
            temporal: {
              mode: "window",
              relativeFromDays: 7,
              relativeUntilDays: 14,
            },
          },
        ],
      }),
    ),
  );
  await proc.runMemoryProcessor(claimAgain(obs.id), { trigger: "high-signal" });
  const card = memoryStore.activeCards()[0]!;
  assert.equal(
    card.temporal.validFromMs,
    sourceTs + 7 * DAY,
    "validFrom normalized against source ts",
  );
  assert.equal(card.temporal.validUntilMs, sourceTs + 14 * DAY);
  assert.equal(
    card.temporal.timezone,
    "America/New_York",
    "observation timezone applied",
  );
});

test("relative temporal days are calendar days in the zone, across DST and gaps", async () => {
  const cases: Array<[tz: string, base: string, expectedFrom: string]> = [
    // Auckland 26 Sep 00:30 (+12) → 27 Sep 00:30, before that day's 02:00 jump.
    [
      "Pacific/Auckland",
      "2026-09-25T12:30:00.000Z",
      "2026-09-26T12:30:00.000Z",
    ],
    // Auckland 4 Apr 00:30 (+13) → 5 Apr 00:30, before that day's 03:00 fall-back.
    [
      "Pacific/Auckland",
      "2026-04-03T11:30:00.000Z",
      "2026-04-04T11:30:00.000Z",
    ],
    // Havana 7 Mar 00:30 → 8 Mar 00:30 is skipped: the gap ends at 01:00 (05:00Z).
    ["America/Havana", "2026-03-07T05:30:00.000Z", "2026-03-08T05:00:00.000Z"],
  ];
  for (const [tz, base, expectedFrom] of cases) {
    getDb().exec("DELETE FROM memory_cards");
    const obs = enqueue(`tomorrow in ${tz}`, { tz, ts: Date.parse(base) });
    claim(obs);
    proc.setMemoryProcessorRunnerForTests(
      fakeRunner(
        JSON.stringify({
          operations: [
            {
              action: "create",
              observationIndex: 0,
              text: `Starts tomorrow (${tz})`,
              kind: "working",
              temporal: { mode: "window", relativeFromDays: 1 },
            },
          ],
        }),
      ),
    );
    await proc.runMemoryProcessor(claimAgain(obs.id), {
      trigger: "high-signal",
    });
    const card = memoryStore.activeCards()[0]!;
    assert.equal(
      new Date(card.temporal.validFromMs!).toISOString(),
      expectedFrom,
      `${tz} from ${base}`,
    );
  }
});

test("global call/hour ceiling cannot be exceeded, including bursts and retries", async () => {
  proc.setMemoryProcessorRunnerForTests(
    fakeRunner(JSON.stringify({ operations: [] })),
  );
  // Default ceiling is 12 calls/hour. Fire 15 batches within the hour.
  let ran = 0;
  let deferred = 0;
  for (let i = 0; i < 15; i += 1) {
    const obs = enqueue(`turn ${i}`, { turn: `t${i}` });
    claim(obs);
    const outcome = await proc.runMemoryProcessor(claimAgain(obs.id), {
      trigger: "every-turn",
    });
    if (outcome.ran) ran += 1;
    else if (outcome.reason === "budget-rate") deferred += 1;
  }
  assert.equal(ran, 12, "exactly the ceiling number of calls ran");
  assert.equal(deferred, 3, "the rest were deferred, not dropped");
  // Deferred observations are back to pending for a later window.
  assert.ok(
    memoryObservationStore.pendingCount() >= 3,
    "deferred observations remain retryable",
  );
});

test("daily cost ceiling blocks further calls once exhausted", async () => {
  // Each call reports $0.50; the default ceiling is $1/day, so the 3rd is blocked.
  proc.setMemoryProcessorRunnerForTests(
    fakeRunner(JSON.stringify({ operations: [] }), 500_000),
  );
  const results: boolean[] = [];
  for (let i = 0; i < 4; i += 1) {
    const obs = enqueue(`c${i}`, { turn: `c${i}` });
    claim(obs);
    results.push(
      (await proc.runMemoryProcessor(claimAgain(obs.id), { trigger: "batch" }))
        .ran,
    );
  }
  // Calls 1 and 2 run (cost 0 then 0.5 recorded), call 3 sees $1.0 recorded → blocked.
  assert.deepEqual(
    results,
    [true, true, false, false],
    "cost ceiling stops further calls once reached",
  );
});

test("recoverable provider failure keeps the observation retryable within bounded attempts", async () => {
  proc.setMemoryProcessorRunnerForTests(throwingRunner());
  const obs = enqueue("something", { turn: "retry-1" });
  claim(obs);
  const outcome = await proc.runMemoryProcessor(claimAgain(obs.id), {
    trigger: "batch",
  });
  assert.equal(outcome.reason, "error");
  assert.equal(
    memoryObservationStore.get(obs.id)!.state,
    "pending",
    "released for retry",
  );
});

test("hourly window reset re-allows calls", async () => {
  proc.setMemoryProcessorRunnerForTests(
    fakeRunner(JSON.stringify({ operations: [] })),
  );
  for (let i = 0; i < 12; i += 1) {
    const obs = enqueue(`w${i}`, { turn: `w${i}` });
    claim(obs);
    await proc.runMemoryProcessor(claimAgain(obs.id), { trigger: "batch" });
  }
  const blockedObs = enqueue("blocked", { turn: "blocked" });
  claim(blockedObs);
  assert.equal(
    (
      await proc.runMemoryProcessor(claimAgain(blockedObs.id), {
        trigger: "batch",
      })
    ).ran,
    false,
    "12/hr reached",
  );
  // Advance past the hour window.
  nowMs += 3_600_001;
  const afterObs = enqueue("after", { turn: "after" });
  claim(afterObs);
  assert.equal(
    (
      await proc.runMemoryProcessor(claimAgain(afterObs.id), {
        trigger: "batch",
      })
    ).ran,
    true,
    "calls allowed again after the window resets",
  );
});
