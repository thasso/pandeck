import assert from "node:assert/strict";
import { test } from "vitest";
import { applyThreadProposals, emptyThreadsDoc } from "./threads.ts";
import type { SynthesisThreadProposal } from "./synthesisSchema.ts";

function proposal(
  over: Partial<SynthesisThreadProposal>,
): SynthesisThreadProposal {
  return {
    threadId: null,
    title: "T",
    state: "active",
    issueKeys: [],
    summary: "s",
    baseRevision: 0,
    ...over,
  };
}

test("applying a proposal bumps the revision once and creates a stable thread id", () => {
  const doc = emptyThreadsDoc();
  const res = applyThreadProposals(
    doc,
    [proposal({ title: "SSAI", issueKeys: ["WEB-1"] })],
    "t1",
  );
  assert.equal(res.changed, true);
  assert.equal(res.next.revision, 1);
  assert.equal(res.next.threads.length, 1);
  assert.equal(res.applied.length, 1);
});

test("a stale baseRevision rejects the proposal instead of clobbering newer state", () => {
  const doc = { revision: 3, threads: [] };
  const res = applyThreadProposals(doc, [proposal({ baseRevision: 2 })], "t1");
  assert.equal(res.changed, false);
  assert.equal(res.rejectedStale.length, 1);
  assert.equal(res.next.revision, 3, "revision untouched when nothing applies");
});

test("re-applying the same proposals against the bumped doc is idempotent (no double-apply)", () => {
  const first = applyThreadProposals(
    emptyThreadsDoc(),
    [proposal({ title: "SSAI", issueKeys: ["WEB-1"], baseRevision: 0 })],
    "t1",
  );
  // The runner re-proposes against the OLD base revision it computed with.
  const second = applyThreadProposals(
    first.next,
    [proposal({ title: "SSAI", issueKeys: ["WEB-1"], baseRevision: 0 })],
    "t2",
  );
  assert.equal(
    second.changed,
    false,
    "stale base revision → rejected, so no duplicate thread",
  );
  assert.equal(second.next.threads.length, 1);
});

test("proposals merge into an existing thread by shared issue key", () => {
  const first = applyThreadProposals(
    emptyThreadsDoc(),
    [proposal({ title: "SSAI", issueKeys: ["WEB-1"], baseRevision: 0 })],
    "t1",
  );
  const merged = applyThreadProposals(
    first.next,
    [
      proposal({
        title: "SSAI cont",
        issueKeys: ["WEB-1", "WEB-2"],
        state: "waning",
        baseRevision: 1,
      }),
    ],
    "t2",
  );
  assert.equal(merged.next.threads.length, 1, "merged, not duplicated");
  assert.deepEqual(merged.next.threads[0]?.issueKeys.sort(), [
    "WEB-1",
    "WEB-2",
  ]);
  assert.equal(merged.next.threads[0]?.state, "waning");
});
