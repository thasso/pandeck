import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { KnowledgeBaseStore } from "../knowledgeBaseStore.ts";
import {
  curateMinutes,
  type MinutesDoc,
  type MinutesExtractor,
} from "./minutesRun.ts";
import type { FreshCandidate } from "./minutes.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function store(): KnowledgeBaseStore {
  const root = mkdtempSync(join(tmpdir(), "minutes-run-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return new KnowledgeBaseStore(root);
}

function action(
  title: string,
  confidence: FreshCandidate["confidence"],
): FreshCandidate {
  return {
    title,
    action: `do ${title}`,
    context: "",
    ownerReason: "",
    confidence,
    dueDate: null,
    snippet: "",
  };
}

function extractorFor(
  map: Record<string, { summary: string | null; actions: FreshCandidate[] }>,
): MinutesExtractor {
  return {
    async extract(doc) {
      const e = map[doc.content] ?? { summary: null, actions: [] };
      return { meetingSummary: e.summary, actions: e.actions };
    },
  };
}

function doc(
  sourceId: string,
  content: string,
  over: Partial<MinutesDoc> = {},
): MinutesDoc {
  return {
    sourceId,
    sourceLink: `https://x/${sourceId}`,
    title: "Weekly Sync",
    meetingDate: "2026-07-13",
    content,
    observedLate: false,
    ...over,
  };
}

async function commit(
  kb: KnowledgeBaseStore,
  changes: Parameters<KnowledgeBaseStore["commitChanges"]>[0],
): Promise<string> {
  const res = await kb.commitChanges(changes, {
    actor: { kind: "system", name: "day-scan" },
    reason: "minutes",
  });
  return res.commit;
}

test("auto policy creates a Task for a high candidate (not low); a cache-key hit skips reprocessing", async () => {
  const kb = store();
  const created: string[] = [];
  const deps = {
    store: kb,
    extractor: extractorFor({
      v1: {
        summary: "Synced.",
        actions: [action("Ship WEB-1", "high"), action("Maybe review", "low")],
      },
    }),
    createTask: async ({ candidate }: { candidate: { title: string } }) => {
      created.push(candidate.title);
      return `T${created.length}`;
    },
    mappingVersion: "m1",
    policy: "auto" as const,
    maxDocsPerRun: 5,
  };

  const sid = `drive:${Math.random().toString(36).slice(2)}`;
  const first = await curateMinutes([doc(sid, "v1")], deps);
  assert.deepEqual(first.processed, [sid]);
  assert.equal(
    first.tasksCreated,
    1,
    "only the high-confidence candidate auto-creates",
  );
  assert.deepEqual(created, ["Ship WEB-1"]);
  const commitId = await commit(kb, first.changes);
  first.finalize(commitId);

  // Same content + mapping version → cache hit, no extraction/Task work.
  const second = await curateMinutes([doc(sid, "v1")], deps);
  assert.deepEqual(second.cached, [sid]);
  assert.deepEqual(second.processed, []);
  assert.equal(second.tasksCreated, 0);
});

test("force-recuration reprocesses unchanged content without recreating the Task", async () => {
  const kb = store();
  let taskCalls = 0;
  const deps = {
    store: kb,
    extractor: extractorFor({
      v1: { summary: null, actions: [action("Ship it", "high")] },
    }),
    createTask: async () => {
      taskCalls += 1;
      return "T1";
    },
    mappingVersion: "m1",
    policy: "auto" as const,
    maxDocsPerRun: 5,
  };
  const sid = `drive:${Math.random().toString(36).slice(2)}`;
  const first = await curateMinutes([doc(sid, "v1")], deps);
  first.finalize(await commit(kb, first.changes));
  assert.equal(taskCalls, 1);

  const forced = await curateMinutes([doc(sid, "v1")], {
    ...deps,
    force: true,
  });
  assert.deepEqual(forced.processed, [sid], "force ignores the cache-key hit");
  assert.equal(
    taskCalls,
    1,
    "the candidate's Task id is reattached from the ledger; no duplicate Task",
  );
  assert.equal(forced.tasksCreated, 0);
});

test("bounded run defers docs beyond maxDocsPerRun", async () => {
  const kb = store();
  const deps = {
    store: kb,
    extractor: extractorFor({
      a: { summary: null, actions: [] },
      b: { summary: null, actions: [] },
    }),
    createTask: async () => "T",
    mappingVersion: "m1",
    policy: "review" as const,
    maxDocsPerRun: 1,
  };
  const result = await curateMinutes(
    [
      doc("drive:a", "a", { meetingDate: "2026-07-13" }),
      doc("drive:b", "b", { meetingDate: "2026-07-14" }),
    ],
    deps,
  );
  assert.equal(result.processed.length, 1);
  assert.equal(result.deferred.length, 1);
  assert.deepEqual([...result.processed, ...result.deferred].sort(), [
    "drive:a",
    "drive:b",
  ]);
});

test("meeting-day anchoring: the entry path uses the meeting day, not the observation day", async () => {
  const kb = store();
  const deps = {
    store: kb,
    extractor: extractorFor({ late: { summary: null, actions: [] } }),
    createTask: async () => "T",
    mappingVersion: "m1",
    policy: "review" as const,
    maxDocsPerRun: 5,
  };
  const result = await curateMinutes(
    [
      doc("drive:late", "late", {
        meetingDate: "2026-07-12",
        observedLate: true,
      }),
    ],
    deps,
  );
  const entryWrite = result.changes.find(
    (c) => c.op === "write" && c.path.endsWith("index.md"),
  )!;
  assert.match(
    (entryWrite as { path: string }).path,
    /^meetings\/2026-07-12-/,
    "anchored to the 07-12 meeting day",
  );
});
