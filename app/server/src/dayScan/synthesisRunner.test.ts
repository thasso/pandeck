import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { KnowledgeBaseStore } from "../knowledgeBaseStore.ts";
import { runDaySynthesis } from "./synthesisRunner.ts";
import { resetDaySynthesisStoreForTests } from "../db/daySynthesisStore.ts";
import { curateMinutes, type MinutesExtractor } from "./minutesRun.ts";
import { canonicalActionKey, candidateId } from "./minutes.ts";
import { renderMachineAppendix, skeletonEntry } from "./appendix.ts";

const cleanups: Array<() => void> = [];
const DATE = "2026-07-13";

beforeEach(() => resetDaySynthesisStoreForTests());
afterEach(() => {
  resetDaySynthesisStoreForTests();
  while (cleanups.length) cleanups.pop()!();
});

function store(): KnowledgeBaseStore {
  const root = mkdtempSync(join(tmpdir(), "synth-runner-"));
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
};

async function seed(kb: KnowledgeBaseStore, sid: string): Promise<string> {
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
      createTask: async () => "x",
      mappingVersion: "m1",
      policy: "review",
      maxDocsPerRun: 5,
    },
  );
  const manifest = {
    schemaVersion: 1,
    runId: "seed",
    date: DATE,
    window: { startIso: "a", endIso: "b", timeZone: "Europe/Berlin" },
    asOf: "c",
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
  await kb
    .commitChanges(
      [
        ...curated.changes,
        {
          op: "write",
          path: `daily-summaries/${DATE}/assets/manifest.json`,
          content: JSON.stringify(manifest),
        },
        {
          op: "write",
          path: `daily-summaries/${DATE}/index.md`,
          content: skeletonEntry(
            DATE,
            renderMachineAppendix(manifest, rollup, []),
          ),
        },
      ],
      { actor: { kind: "system", name: "day-scan" }, reason: "seed" },
    )
    .then((r) => curated.finalize(r.commit));
  return candidateId(sid, canonicalActionKey("Ship WEB-1"));
}

test("malformed synthesizer output is rejected and nothing is applied", async () => {
  const kb = store();
  await seed(kb, `drive:${Math.random().toString(36).slice(2)}`);
  const res = await runDaySynthesis(DATE, {
    store: kb,
    synthesizer: async () => ({
      sections: [{ id: "not-a-section", markdown: "x" }],
      taskProposals: [],
      threadProposals: [],
    }),
    createTaskForCandidate: () => "T1",
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => /Unknown section id/.test(e)));
});

test("valid output applies: narrative written, candidate accepted as a Task", async () => {
  const kb = store();
  const sid = `drive:${Math.random().toString(36).slice(2)}`;
  const cid = await seed(kb, sid);
  let created = 0;
  const res = await runDaySynthesis(DATE, {
    store: kb,
    synthesizer: async ({ digest }) => ({
      sections: [{ id: "needs-attention", markdown: "Ship WEB-1." }],
      taskProposals: [{ candidateId: cid, title: "Ship WEB-1", accept: true }],
      threadProposals: [
        {
          threadId: null,
          title: "SSAI",
          state: "active",
          issueKeys: ["WEB-1"],
          summary: "s",
          baseRevision: digest.threadsRevision,
        },
      ],
    }),
    createTaskForCandidate: () => {
      created += 1;
      return "T1";
    },
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.tasksCreated, 1);
    assert.equal(res.threadsApplied.length, 1);
  }
  assert.equal(created, 1);
  assert.match(
    await kb.readEntryFile(`daily-summaries/${DATE}/index.md`),
    /Needs your attention/,
  );
});
