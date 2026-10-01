import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { KnowledgeBaseStore } from "../knowledgeBaseStore.ts";
import { DayScanCache } from "./cache.ts";
import {
  resetDayCollectionForTests,
  runDayCollection,
  stopDayCollection,
} from "./collectionRun.ts";
import { meetingEntryPath } from "./minutes.ts";
import type {
  CollectorOutput,
  DaySourceCollector,
  DaySourceFact,
  DaySourceSnapshot,
} from "./types.ts";

let kbRoot: string;
let cacheRoot: string;
let store: KnowledgeBaseStore;
let cache: DayScanCache;

beforeEach(() => {
  kbRoot = mkdtempSync(join(tmpdir(), "day-scan-kb-"));
  cacheRoot = mkdtempSync(join(tmpdir(), "day-scan-cache-"));
  store = new KnowledgeBaseStore(kbRoot);
  cache = new DayScanCache(cacheRoot);
  resetDayCollectionForTests();
});

afterEach(() => {
  resetDayCollectionForTests();
  rmSync(kbRoot, { recursive: true, force: true });
  rmSync(cacheRoot, { recursive: true, force: true });
});

const DATE = "2026-07-13";

function fact(id: string, extra: Partial<DaySourceFact> = {}): DaySourceFact {
  return { id, kind: "item", observedAt: "2026-07-13T10:00:00.000Z", ...extra };
}

function fakeCollector(
  key: DaySourceCollector["key"],
  impl: () => Promise<CollectorOutput> | CollectorOutput,
  ready = true,
): DaySourceCollector {
  return {
    key,
    label: key,
    readiness: () =>
      ready ? { ready: true } : { ready: false, reason: "unconfigured" },
    collect: async () => impl(),
  };
}

async function readSnapshot(key: string): Promise<DaySourceSnapshot> {
  return JSON.parse(
    await store.readEntryFile(
      `daily-summaries/${DATE}/assets/sources/${key}.json`,
    ),
  ) as DaySourceSnapshot;
}

/**
 * Golden synthetic fixture (modeled on the 2026-07-13 day shape, fully
 * synthetic data): two runs across jira/github/tempo/pa-like collectors
 * exercising the disposition/result contract, delta classes, accumulator
 * union, failed-source retention, and the atomic commit.
 */
test("golden two-run collection: added/changed/union/suppression/failed retention in one atomic commit per run", async () => {
  // Run 1: everything healthy.
  const run1 = await runDayCollection(DATE, {
    store,
    cache,
    collectors: [
      fakeCollector("jira", () => ({
        result: "complete",
        facts: [
          fact("jira:A", { title: "Issue A" }),
          fact("jira:B", { title: "Issue B" }),
        ],
      })),
      fakeCollector("github-events", () => ({
        result: "partial",
        facts: [fact("gh:1")],
        accumulate: true,
      })),
      fakeCollector("tempo", () => ({
        result: "complete",
        facts: [fact("tempo:1", { data: { seconds: 3600 } })],
      })),
      fakeCollector(
        "calendar",
        () => ({ result: "complete", facts: [] }),
        false,
      ),
    ],
  });

  assert.ok(run1.commit, "run 1 commits atomically");
  const manifest1 = run1.manifest;
  const jira1 = manifest1.sources.find((s) => s.key === "jira");
  assert.equal(jira1?.disposition, "attempted");
  assert.equal(jira1?.result, "complete");
  assert.equal(jira1?.added, 2);
  const skipped = manifest1.sources.find((s) => s.key === "calendar");
  assert.equal(skipped?.disposition, "skipped");
  assert.equal(skipped?.skipReason, "unconfigured");
  assert.equal(
    skipped?.result,
    undefined,
    "skipped is never classified as failed",
  );

  // Run 2: jira changes + loses an issue (complete baseline → real negative),
  // github partial scan sees a DIFFERENT event (union must keep both, absence
  // suppressed), tempo FAILS (prior snapshot retained, no delta).
  const run2 = await runDayCollection(DATE, {
    store,
    cache,
    collectors: [
      fakeCollector("jira", () => ({
        result: "complete",
        facts: [fact("jira:A", { title: "Issue A renamed" })],
      })),
      fakeCollector("github-events", () => ({
        result: "partial",
        facts: [fact("gh:2")],
        accumulate: true,
      })),
      fakeCollector("tempo", () => Promise.reject(new Error("tempo exploded"))),
      fakeCollector(
        "calendar",
        () => ({ result: "complete", facts: [] }),
        false,
      ),
    ],
  });

  const jiraDelta = run2.deltas.find((d) => d.source === "jira");
  assert.deepEqual(jiraDelta?.changed, ["jira:A"]);
  assert.deepEqual(jiraDelta?.noLongerObserved, ["jira:B"]);
  assert.equal(jiraDelta?.suppressedNegative, false);

  const ghDelta = run2.deltas.find((d) => d.source === "github-events");
  assert.deepEqual(ghDelta?.added, ["gh:2"]);
  assert.equal(
    ghDelta?.suppressedNegative,
    true,
    "partial run cannot support absence",
  );
  const ghSnapshot = await readSnapshot("github-events");
  assert.deepEqual(
    ghSnapshot.facts.map((f) => f.id).sort(),
    ["gh:1", "gh:2"],
    "accumulator unions by id, never removes",
  );

  const tempoManifest = run2.manifest.sources.find((s) => s.key === "tempo");
  assert.equal(tempoManifest?.result, "failed");
  assert.match(tempoManifest?.error ?? "", /tempo exploded/);
  assert.equal(
    run2.deltas.find((d) => d.source === "tempo"),
    undefined,
    "failed source produces no delta",
  );
  const tempoSnapshot = await readSnapshot("tempo");
  assert.equal(
    tempoSnapshot.runId,
    run1.runId,
    "failed source retains the last good snapshot",
  );

  // Origin tagging: the run commit carries the day-scan actor for self-exclusion.
  const history = await store.history({ limit: 5 });
  assert.match(history[0]?.trailers["KB-Actor"] ?? "", /day-scan/);
  assert.match(history[0]?.subject ?? "", /day-scan collection/);
});

test("the minutes substage folds meeting entries into the same atomic run commit and reports a summary", async () => {
  const sid = `drive:${Math.random().toString(36).slice(2)}`;
  const run = await runDayCollection(DATE, {
    store,
    cache,
    collectors: [
      fakeCollector("jira", () => ({
        result: "complete",
        facts: [fact("jira:A")],
      })),
    ],
    minutes: {
      async discover() {
        return [
          {
            sourceId: sid,
            sourceLink: "https://x",
            title: "Weekly Sync",
            meetingDate: DATE,
            content: "notes",
            observedLate: false,
          },
        ];
      },
      extractor: {
        async extract() {
          return {
            meetingSummary: "We synced.",
            actions: [
              {
                title: "Ship it",
                action: "ship",
                context: "",
                ownerReason: "",
                confidence: "high",
                dueDate: null,
                snippet: "",
              },
            ],
          };
        },
      },
      async createTask() {
        return "T-day";
      },
    },
  });

  assert.equal(run.manifest.minutes?.discovered, 1);
  assert.equal(run.manifest.minutes?.processed, 1);
  assert.equal(run.manifest.minutes?.tasksCreated, 1);
  // The meeting entry lands in the committed tree (same atomic commit as the snapshots).
  const entry = await store.readEntryFile(
    `${meetingEntryPath(DATE, "Weekly Sync", sid)}/index.md`,
  );
  assert.match(entry, /Action candidates/);
  assert.match(entry, /task T-day/);
  const latest = (await store.history({ limit: 1 }))[0];
  assert.match(latest?.subject ?? "", /day-scan collection/);
});

test("a corrupted prior snapshot is ignored as a baseline instead of poisoning the run", async () => {
  await store.commitChanges(
    [
      {
        op: "write",
        path: `daily-summaries/${DATE}/assets/sources/jira.json`,
        content: "{not json",
      },
    ],
    { actor: { kind: "system", name: "test" }, reason: "corrupt snapshot" },
  );
  const run = await runDayCollection(DATE, {
    store,
    cache,
    collectors: [
      fakeCollector("jira", () => ({
        result: "complete",
        facts: [fact("jira:A")],
      })),
    ],
  });
  const delta = run.deltas.find((d) => d.source === "jira");
  assert.deepEqual(delta?.added, ["jira:A"]);
  assert.equal(
    delta?.suppressedNegative,
    true,
    "no usable baseline: negatives suppressed",
  );
});

test("concurrent requests coalesce: one active run plus at most one follow-up", async () => {
  let runs = 0;
  const slowCollector = fakeCollector("jira", async () => {
    runs += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { result: "complete" as const, facts: [] };
  });
  const opts = { store, cache, collectors: [slowCollector] };
  const [first, second, third] = await Promise.all([
    runDayCollection(DATE, opts),
    runDayCollection(DATE, opts),
    runDayCollection(DATE, opts),
  ]);
  assert.equal(
    runs,
    2,
    "three concurrent requests → the active run + one coalesced follow-up",
  );
  assert.equal(first.coalesced ?? false, false);
  assert.equal(second.coalesced, true);
  assert.equal(third.coalesced, true);
  assert.equal(
    second.runId,
    third.runId,
    "both waiters share the follow-up run",
  );
});

test("graceful shutdown refuses new runs", async () => {
  stopDayCollection();
  await assert.rejects(
    () => runDayCollection(DATE, { store, cache, collectors: [] }),
    /shutting down/,
  );
});
