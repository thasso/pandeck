import assert from "node:assert/strict";
import { test } from "vitest";
import {
  applyMeetingRegion,
  buildCacheKey,
  cacheKeyMatches,
  candidateId,
  canonicalActionKey,
  MINUTES_REGION_END,
  MINUTES_REGION_START,
  meetingEntryId,
  meetingEntryPath,
  reconcileCandidates,
  renderMeetingEntry,
  shouldAutoCreateTask,
  type FreshCandidate,
  type MinutesCandidate,
} from "./minutes.ts";

function fresh(
  title: string,
  extra: Partial<FreshCandidate> = {},
): FreshCandidate {
  return {
    title,
    action: `do ${title}`,
    context: "",
    ownerReason: "",
    confidence: "high",
    dueDate: null,
    snippet: "",
    ...extra,
  };
}

test("composite cache key invalidates on content OR any version change", () => {
  const key = buildCacheKey("hashA", "map1");
  assert.equal(cacheKeyMatches(key, buildCacheKey("hashA", "map1")), true);
  assert.equal(
    cacheKeyMatches(key, buildCacheKey("hashB", "map1")),
    false,
    "content change re-runs",
  );
  assert.equal(
    cacheKeyMatches(key, buildCacheKey("hashA", "map2")),
    false,
    "mapping version bump re-runs unchanged content",
  );
  assert.equal(
    cacheKeyMatches({ ...key, curatorVersion: "0" }, key),
    false,
    "curator version bump re-runs",
  );
  assert.equal(
    cacheKeyMatches(undefined, key),
    false,
    "no prior record never matches",
  );
});

/**
 * `candidateId` is PERSISTED: stored candidates carry it, and Task links hang
 * off it. Every other test recomputes it through this same function, so a
 * changed hash input (the source/action separator included) would orphan every
 * stored candidate with the suite still green. Hence a literal.
 */
test("candidateId is stable for a source and action key", () => {
  assert.equal(
    candidateId("drive:doc", canonicalActionKey("Ship WEB-1")),
    "mc_573fd2211115",
  );
});

test("reconciliation keeps ids/Task links on unrelated edits and supersedes removed actions", () => {
  const first = reconcileCandidates(
    [],
    [fresh("Ship WEB-1"), fresh("Review QA-2", { confidence: "low" })],
    {
      sourceId: "drive:doc",
      contentHash: "h1",
      observedAt: "2026-07-13T10:00:00.000Z",
    },
  );
  assert.equal(first.length, 2);
  const shipId = candidateId("drive:doc", canonicalActionKey("Ship WEB-1"));
  assert.equal(first.find((c) => c.id === shipId)?.status, "proposed");

  // Simulate a Task created for the "Ship" candidate.
  const withTask: MinutesCandidate[] = first.map((c) =>
    c.id === shipId ? { ...c, status: "task-created", taskId: "42" } : c,
  );

  // Re-extract: the doc changed prose ("Ship WEB-1 now!") but the same action, dropped the review action, added a new one.
  const second = reconcileCandidates(
    withTask,
    [
      fresh("Ship WEB-1", { action: "ship it now" }),
      fresh("Draft release notes"),
    ],
    {
      sourceId: "drive:doc",
      contentHash: "h2",
      observedAt: "2026-07-13T12:00:00.000Z",
    },
  );
  const ship = second.find((c) => c.id === shipId)!;
  assert.equal(
    ship.status,
    "task-created",
    "acceptance/task state persists across re-extraction",
  );
  assert.equal(ship.taskId, "42", "Task link preserved");
  assert.equal(ship.action, "ship it now", "content refreshed");
  assert.equal(ship.firstObservedHash, "h1");
  assert.equal(ship.lastObservedHash, "h2");

  const review = second.find((c) => c.title === "Review QA-2")!;
  assert.equal(
    review.status,
    "superseded",
    "dropped action is superseded, not deleted",
  );

  const draft = second.find((c) => c.title === "Draft release notes")!;
  assert.equal(
    draft.status,
    "proposed",
    "genuinely new action gets a fresh proposed candidate",
  );
});

test("task proposal policy: auto creates high AND medium, low needs acceptance, review creates none", () => {
  const reconciled = reconcileCandidates(
    [],
    [
      fresh("A", { confidence: "high" }),
      fresh("B", { confidence: "medium" }),
      fresh("C", { confidence: "low" }),
    ],
    { sourceId: "s", contentHash: "h", observedAt: "t" },
  );
  const high = reconciled.find((c) => c.title === "A")!;
  const medium = reconciled.find((c) => c.title === "B")!;
  const low = reconciled.find((c) => c.title === "C")!;
  assert.equal(shouldAutoCreateTask(high, "auto"), true);
  assert.equal(
    shouldAutoCreateTask(medium, "auto"),
    true,
    "medium now auto-creates",
  );
  assert.equal(
    shouldAutoCreateTask(low, "auto"),
    false,
    "only low confidence requires acceptance",
  );
  assert.equal(
    shouldAutoCreateTask(high, "review"),
    false,
    "review policy requires acceptance",
  );
  assert.equal(
    shouldAutoCreateTask({ ...high, taskId: "1" }, "auto"),
    false,
    "already has a Task",
  );
});

test("meeting entry anchors to the meeting day and is collision-safe across same-title meetings", () => {
  const a = meetingEntryPath("2026-07-13", "Weekly Sync", "drive:aaa");
  const b = meetingEntryPath("2026-07-13", "Weekly Sync", "drive:bbb");
  assert.notEqual(a, b, "same title + day but different source stays distinct");
  assert.match(a, /^meetings\/2026-07-13-weekly-sync-[0-9a-f]{8}$/);
  assert.equal(meetingEntryId("drive:aaa"), meetingEntryId("drive:aaa"));
  assert.notEqual(meetingEntryId("drive:aaa"), meetingEntryId("drive:bbb"));
});

test("re-curation rewrites only the generated region and preserves user Notes", () => {
  const candidates = reconcileCandidates([], [fresh("Ship it")], {
    sourceId: "drive:doc",
    contentHash: "h1",
    observedAt: "t",
  });
  const input = {
    meetingDate: "2026-07-13",
    title: "Sync",
    sourceId: "drive:doc",
    sourceLink: "https://x",
    meetingSummary: "We synced.",
    candidates,
    observedLate: false,
  };
  const entry = renderMeetingEntry(input);
  assert.ok(
    entry.includes(MINUTES_REGION_START) && entry.includes(MINUTES_REGION_END),
  );
  const edited = entry.replace(
    "<!-- User-owned notes. Re-curation never touches this section. -->",
    "Call Christian about this.",
  );

  const input2 = {
    ...input,
    meetingSummary: "We synced and decided.",
    observedLate: true,
  };
  const updated = applyMeetingRegion(edited, input2);
  assert.ok(
    updated.includes("Call Christian about this."),
    "user notes preserved",
  );
  assert.ok(
    updated.includes("We synced and decided."),
    "generated summary refreshed",
  );
  assert.ok(
    updated.includes("Late-arriving minutes"),
    "late-arrival note rendered",
  );
  assert.equal(
    updated.split(MINUTES_REGION_START).length,
    2,
    "exactly one generated region",
  );
});
