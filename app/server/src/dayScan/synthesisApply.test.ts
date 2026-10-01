import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { KnowledgeBaseStore } from "../knowledgeBaseStore.ts";
import {
  applySynthesis,
  getDaySynthesisRun,
  reconcileDaySynthesisOnStartup,
} from "./synthesisApply.ts";
import {
  resetDaySynthesisStoreForTests,
  setRunState,
} from "../db/daySynthesisStore.ts";
import { curateMinutes, type MinutesExtractor } from "./minutesRun.ts";
import {
  canonicalActionKey,
  candidateId,
  type MinutesCandidate,
} from "./minutes.ts";
import { renderMachineAppendix, skeletonEntry } from "./appendix.ts";
import type { SynthesisResult } from "./synthesisSchema.ts";

const cleanups: Array<() => void> = [];
const DATE = "2026-07-13";

beforeEach(() => resetDaySynthesisStoreForTests());
afterEach(() => {
  resetDaySynthesisStoreForTests();
  while (cleanups.length) cleanups.pop()!();
});

function store(): KnowledgeBaseStore {
  const root = mkdtempSync(join(tmpdir(), "synth-apply-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return new KnowledgeBaseStore(root);
}

const extractor: MinutesExtractor = {
  async extract() {
    return {
      meetingSummary: "Synced.",
      actions: [
        {
          title: "Ship WEB-1",
          action: "ship it",
          context: "",
          ownerReason: "",
          confidence: "high",
          dueDate: null,
          snippet: "",
        },
      ],
    };
  },
};

/** Seed one committed meeting entry with a proposed candidate (review policy → no auto Task). */
async function seedCandidate(
  kb: KnowledgeBaseStore,
  sid: string,
): Promise<string> {
  const curated = await curateMinutes(
    [
      {
        sourceId: sid,
        sourceLink: "https://x",
        title: "Sync",
        meetingDate: DATE,
        content: "notes",
        observedLate: false,
      },
    ],
    {
      store: kb,
      extractor,
      createTask: async () => "unused",
      mappingVersion: "m1",
      policy: "review",
      maxDocsPerRun: 5,
    },
  );
  // The collection run also creates the day entry skeleton (with the narrative region).
  const manifest = {
    schemaVersion: 1,
    runId: "seed",
    date: DATE,
    window: {
      startIso: "2026-07-12T22:00:00.000Z",
      endIso: "2026-07-13T22:00:00.000Z",
      timeZone: "Europe/Berlin",
    },
    asOf: "2026-07-13T18:00:00.000Z",
    sources: [],
    changesSinceLastRun: 0,
  };
  const rollup = {
    schemaVersion: 1,
    runId: "seed",
    date: DATE,
    mappingVersion: "m1",
    buckets: [],
    suppressed: { bots: 0, routine: 0 },
  };
  const dayEntry = skeletonEntry(
    DATE,
    renderMachineAppendix(manifest, rollup, []),
  );
  const res = await kb.commitChanges(
    [
      ...curated.changes,
      {
        op: "write",
        path: `daily-summaries/${DATE}/index.md`,
        content: dayEntry,
      },
    ],
    {
      actor: { kind: "system", name: "day-scan" },
      reason: "day-scan collection seed",
    },
  );
  curated.finalize(res.commit);
  return candidateId(sid, canonicalActionKey("Ship WEB-1"));
}

function result(cid: string): SynthesisResult {
  return {
    sections: [{ id: "needs-attention", markdown: "Ship WEB-1 today." }],
    taskProposals: [{ candidateId: cid, title: "Ship WEB-1", accept: true }],
    threadProposals: [
      {
        threadId: null,
        title: "SSAI",
        state: "active",
        issueKeys: ["WEB-1"],
        summary: "ongoing",
        baseRevision: 0,
      },
    ],
  };
}

test("apply creates the candidate Task once, writes narrative + threads, and journals applied", async () => {
  const kb = store();
  const sid = `drive:${Math.random().toString(36).slice(2)}`;
  const cid = await seedCandidate(kb, sid);
  let taskCalls = 0;

  const res = await applySynthesis({
    store: kb,
    runId: "run-1",
    date: DATE,
    result: result(cid),
    createTaskForCandidate: () => {
      taskCalls += 1;
      return "T1";
    },
  });
  assert.equal(res.tasksCreated, 1);
  assert.equal(taskCalls, 1);
  assert.equal(res.threadsApplied.length, 1);
  assert.ok(res.kbCommit);
  assert.equal(getDaySynthesisRun("run-1")?.state, "applied");

  // Candidate is linked in its committed source of truth.
  const candidates = JSON.parse(
    await kb.readEntryFile(await entryPathFor(sid)),
  ) as { candidates: MinutesCandidate[] };
  const linked = candidates.candidates.find((c) => c.id === cid);
  assert.equal(linked?.taskId, "T1");
  assert.equal(linked?.status, "task-created");

  // Narrative landed in the day entry.
  const day = await kb.readEntryFile(`daily-summaries/${DATE}/index.md`);
  assert.match(day, /Needs your attention/);
  assert.match(day, /Ship WEB-1 today/);
});

test("re-applying the SAME run resumes without creating a second Task", async () => {
  const kb = store();
  const sid = `drive:${Math.random().toString(36).slice(2)}`;
  const cid = await seedCandidate(kb, sid);
  let taskCalls = 0;
  const create = () => {
    taskCalls += 1;
    return "T1";
  };

  await applySynthesis({
    store: kb,
    runId: "run-2",
    date: DATE,
    result: result(cid),
    createTaskForCandidate: create,
  });
  const again = await applySynthesis({
    store: kb,
    runId: "run-2",
    date: DATE,
    result: result(cid),
    createTaskForCandidate: create,
  });
  assert.equal(again.resumed, true);
  assert.equal(taskCalls, 1, "no duplicate Task on resume");
});

test("a candidate already task-created is skipped as stale in a later run", async () => {
  const kb = store();
  const sid = `drive:${Math.random().toString(36).slice(2)}`;
  const cid = await seedCandidate(kb, sid);
  await applySynthesis({
    store: kb,
    runId: "run-3a",
    date: DATE,
    result: result(cid),
    createTaskForCandidate: () => "T1",
  });

  let taskCalls = 0;
  const later = await applySynthesis({
    store: kb,
    runId: "run-3b",
    date: DATE,
    result: result(cid),
    createTaskForCandidate: () => {
      taskCalls += 1;
      return "T2";
    },
  });
  assert.deepEqual(later.staleTaskProposals, [cid]);
  assert.equal(taskCalls, 0, "terminal candidate never creates a second Task");
});

test("startup reconciliation closes a run whose KB commit landed but journal stayed non-terminal", async () => {
  const kb = store();
  const sid = `drive:${Math.random().toString(36).slice(2)}`;
  const cid = await seedCandidate(kb, sid);
  const res = await applySynthesis({
    store: kb,
    runId: "run-4",
    date: DATE,
    result: result(cid),
    createTaskForCandidate: () => "T1",
  });
  assert.ok(res.kbCommit);
  // Simulate a crash after the commit but before the journal reached 'applied'.
  setRunState("run-4", "applying");
  assert.equal(getDaySynthesisRun("run-4")?.state, "applying");

  const closed = await reconcileDaySynthesisOnStartup(kb);
  assert.deepEqual(closed, ["run-4"]);
  assert.equal(getDaySynthesisRun("run-4")?.state, "applied");
});

/** Resolve the committed candidates.json path for the seeded source. */
async function entryPathFor(sid: string): Promise<string> {
  const { readMinutesIndex } = await import("./minutesRun.ts");
  const record = readMinutesIndex().find((r) => r.sourceId === sid)!;
  return `${record.entryPath}/assets/candidates.json`;
}
