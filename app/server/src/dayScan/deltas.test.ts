import assert from "node:assert/strict";
import { test } from "vitest";
import { computeDelta } from "./deltas.ts";
import {
  DAY_SCAN_SCHEMA_VERSION,
  type DaySourceFact,
  type DaySourceSnapshot,
} from "./types.ts";

function fact(id: string, extra: Partial<DaySourceFact> = {}): DaySourceFact {
  return { id, kind: "item", observedAt: "2026-07-13T10:00:00.000Z", ...extra };
}

function snapshot(
  facts: DaySourceFact[],
  result: "complete" | "partial" = "complete",
  runId = "r1",
): DaySourceSnapshot {
  return {
    schemaVersion: DAY_SCAN_SCHEMA_VERSION,
    source: "jira",
    date: "2026-07-13",
    runId,
    collectedAt: "2026-07-13T10:00:00.000Z",
    result,
    facts,
  };
}

test("added and changed compare against the previous snapshot; volatile fields never count", () => {
  const previous = snapshot([
    fact("a", { title: "one" }),
    fact("b", { title: "two" }),
  ]);
  const delta = computeDelta({
    source: "jira",
    current: {
      result: "complete",
      facts: [
        // Same content, different observedAt — must NOT be `changed`.
        fact("a", { title: "one", observedAt: "2026-07-13T15:00:00.000Z" }),
        fact("b", { title: "two changed" }),
        fact("c", { title: "new" }),
      ],
    },
    previous,
    baseline: previous,
  });
  assert.deepEqual(delta.added, ["c"]);
  assert.deepEqual(delta.changed, ["b"]);
  assert.deepEqual(delta.noLongerObserved, []);
  assert.equal(delta.suppressedNegative, false);
});

test("a partial run yields positives but suppresses absence conclusions", () => {
  const baseline = snapshot([fact("a"), fact("gone")]);
  const delta = computeDelta({
    source: "github-events",
    current: { result: "partial", facts: [fact("a"), fact("new")] },
    previous: baseline,
    baseline,
  });
  assert.deepEqual(delta.added, ["new"]);
  assert.deepEqual(delta.noLongerObserved, []);
  assert.equal(delta.suppressedNegative, true);
});

test("no complete baseline also suppresses negatives, even on a complete run", () => {
  const previousPartial = snapshot([fact("a"), fact("gone")], "partial");
  const delta = computeDelta({
    source: "jira",
    current: { result: "complete", facts: [fact("a")] },
    previous: previousPartial,
    baseline: null,
  });
  assert.deepEqual(delta.noLongerObserved, []);
  assert.equal(delta.suppressedNegative, true);
});

test("noLongerObserved needs complete current + complete baseline, and is never confirmed deletion", () => {
  const baseline = snapshot([fact("a"), fact("gone"), fact("cancelled")]);
  const delta = computeDelta({
    source: "calendar",
    current: { result: "complete", facts: [fact("a")] },
    previous: baseline,
    baseline,
    confirmedDeletedIds: ["cancelled"],
  });
  assert.deepEqual(delta.noLongerObserved, ["gone"]);
  assert.deepEqual(delta.confirmedDeleted, ["cancelled"]);
  assert.equal(delta.suppressedNegative, false);
});
