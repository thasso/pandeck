import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  backgroundWorkBackendsForHarness,
  harnessSupportsBackgroundWorkBackend,
  type Harness,
} from "@assistant/shared";
import type {
  BackgroundWorkOwnerEligibility,
  BackgroundWorkOwnerEvidence,
  BackgroundWorkOwnerExclusion,
} from "./policy.ts";

const dataDir = mkdtempSync(join(tmpdir(), "background-work-policy-test-"));
process.env.DATA_DIR = dataDir;
process.env.ASSISTANT_CWD = dataDir;

const {
  backgroundWorkOwnerDecision,
  backgroundWorkOwnerEligibility,
  readBackgroundWorkOwnerEvidence,
} = await import("./policy.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const workflowStore = await import("../db/workflowStore.ts");

let serial = 0;
function makeSession(
  scope: "user" | "internal" | "subagent" = "user",
  harness: Harness = "claude-sdk",
): string {
  serial += 1;
  const id = `policy-${scope}-${serial}`;
  sessionStore.upsert({ id, scope, harness, agentType: "developer" });
  return id;
}

const ELIGIBLE: BackgroundWorkOwnerEvidence = {
  exists: true,
  scope: "user",
  subagentOwned: false,
  workflowOwned: false,
  harness: "claude-sdk",
};

function exclusionOf(
  decision: BackgroundWorkOwnerEligibility,
): BackgroundWorkOwnerExclusion | undefined {
  return decision.eligible ? undefined : decision.exclusion;
}

test("only an interactive top-level user session may own background work", () => {
  assert.deepEqual(backgroundWorkOwnerDecision(ELIGIBLE, "claude-query"), {
    eligible: true,
  });

  // Keyed by exclusion, so a new one cannot be added without a case here.
  const excluded: Record<
    BackgroundWorkOwnerExclusion,
    Partial<BackgroundWorkOwnerEvidence>
  > = {
    // A helper or one-shot run has no session record at all.
    "unknown-session": { exists: false },
    "non-user-scope": { scope: "internal" },
    "subagent-owned": { subagentOwned: true },
    "workflow-owned": { workflowOwned: true },
    // A Claude session cannot supervise a PA-owned process.
    "harness-backend-mismatch": { harness: "claude-sdk" },
  };
  for (const [exclusion, overrides] of Object.entries(excluded)) {
    const backend =
      exclusion === "harness-backend-mismatch"
        ? "host-process"
        : "claude-query";
    const decision = backgroundWorkOwnerDecision(
      { ...ELIGIBLE, ...overrides },
      backend,
    );
    assert.equal(decision.eligible, false, JSON.stringify(overrides));
    assert.equal(exclusionOf(decision), exclusion);
    assert.ok(
      decision.eligible === false && decision.reason.length > 0,
      "a denial always carries a reason",
    );
  }
});

test("evidence is read default-closed from the durable stores", () => {
  const owner = makeSession();
  assert.deepEqual(readBackgroundWorkOwnerEvidence(owner), ELIGIBLE);
  assert.deepEqual(backgroundWorkOwnerEligibility(owner, "claude-query"), {
    eligible: true,
  });

  // An id nothing persisted is unknown, not eligible-by-default.
  const missing = readBackgroundWorkOwnerEvidence("no-such-session");
  assert.equal(missing.exists, false);
  assert.equal(missing.harness, undefined);
  assert.equal(
    exclusionOf(
      backgroundWorkOwnerEligibility("no-such-session", "claude-query"),
    ),
    "unknown-session",
  );

  for (const scope of ["internal", "subagent"] as const) {
    const id = makeSession(scope);
    assert.equal(readBackgroundWorkOwnerEvidence(id).scope, scope);
    assert.equal(
      exclusionOf(backgroundWorkOwnerEligibility(id, "claude-query")),
      "non-user-scope",
    );
  }
});

test("a session may own only the background backend its harness supports", () => {
  const claude = makeSession("user", "claude-sdk");
  const pi = makeSession("user", "pi");
  assert.equal(readBackgroundWorkOwnerEvidence(claude).harness, "claude-sdk");
  assert.equal(readBackgroundWorkOwnerEvidence(pi).harness, "pi");

  // Each harness owns its own backend …
  assert.equal(
    backgroundWorkOwnerEligibility(claude, "claude-query").eligible,
    true,
  );
  assert.equal(
    backgroundWorkOwnerEligibility(pi, "host-process").eligible,
    true,
  );

  // … and neither may own the other's, in either direction.
  assert.equal(
    exclusionOf(backgroundWorkOwnerEligibility(claude, "host-process")),
    "harness-backend-mismatch",
  );
  assert.equal(
    exclusionOf(backgroundWorkOwnerEligibility(pi, "claude-query")),
    "harness-backend-mismatch",
  );
});

test("the harness capability predicate is the shared one", () => {
  assert.deepEqual(backgroundWorkBackendsForHarness("claude-sdk"), [
    "claude-query",
  ]);
  assert.deepEqual(backgroundWorkBackendsForHarness("pi"), ["host-process"]);
  assert.equal(
    harnessSupportsBackgroundWorkBackend("pi", "claude-query"),
    false,
  );
  assert.equal(
    harnessSupportsBackgroundWorkBackend("claude-sdk", "claude-query"),
    true,
  );
});

test("a user session executing a workflow step is workflow-owned", () => {
  const executor = makeSession();
  assert.equal(
    backgroundWorkOwnerEligibility(executor, "claude-query").eligible,
    true,
  );

  const actor = { kind: "user" } as const;
  const run = workflowStore.createRun({
    taskId: 4711,
    recipeId: "code-delivery",
    recipeVersion: 1,
    maxIterations: 1,
    maxReviewPasses: 1,
    actor,
  });
  const step = workflowStore.appendStep({
    runId: run.id,
    kind: "agent",
    payload: {},
    actor,
  });
  workflowStore.startStep(step.id, { kind: "session", id: executor }, actor);

  assert.equal(readBackgroundWorkOwnerEvidence(executor).workflowOwned, true);
  assert.equal(
    exclusionOf(backgroundWorkOwnerEligibility(executor, "claude-query")),
    "workflow-owned",
  );
});
