/**
 * What the coordinator is told a fix round costs ([Task-592](pa://task/592)).
 *
 * The numbers matter less than the two claims this section must never make:
 * that an unmeasured session cost nothing, and that the cheaper route is by
 * that fact the right one.
 *   pnpm --filter @assistant/server test src/workflow/runSpend.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { WorkflowStepRow } from "../db/workflowStore.ts";
import { routingSpendLines } from "./runSpend.ts";

let nextId = 0;

function agentStep(
  sessionId: string,
  payload: Record<string, unknown>,
): WorkflowStepRow {
  nextId += 1;
  return {
    id: nextId,
    runId: 1,
    kind: "agent",
    payload: payload as WorkflowStepRow["payload"],
    status: "completed",
    attempt: 1,
    executor: { kind: "session", id: sessionId },
    createdAt: 1,
    updatedAt: 1,
  };
}

function implement(sessionId: string): WorkflowStepRow {
  return agentStep(sessionId, { role: "implementer", objective: "implement" });
}

function implementerRevise(sessionId: string): WorkflowStepRow {
  return agentStep(sessionId, { role: "implementer", objective: "revise" });
}

function fixerRevise(sessionId: string): WorkflowStepRow {
  return agentStep(sessionId, {
    role: "implementer",
    objective: "revise",
    fixer: { modelId: "gpt-test", provider: "openai-codex" },
  });
}

/** A cost table standing in for recorded usage totals. */
function costs(table: Record<string, number>) {
  return (sessionId: string): number | undefined => table[sessionId];
}

test("a run with nothing measured says nothing about cost", () => {
  assert.deepEqual(routingSpendLines([implement("impl")], costs({})), []);
});

test("the two routes are reported at what they cost per assignment", () => {
  const lines = routingSpendLines(
    [
      implement("impl"),
      implementerRevise("impl"),
      agentStep("review", { role: "reviewer", objective: "review" }),
      fixerRevise("fix"),
    ],
    costs({ impl: 32, fix: 1.5, review: 4 }),
  ).join("\n");
  assert.match(lines, /spent \$38 so far across 3 sessions/);
  // $32 over two assignments against $1.50 over one — the whole point of the
  // section is that those two numbers sit next to each other.
  assert.match(lines, /implementer's own session has cost \$16 on average/);
  assert.match(lines, /fixer session has cost \$1\.50 on average/);
  assert.match(lines, /its next round costs more than its last/);
});

test("an unmeasured session is absent, never counted as free", () => {
  const lines = routingSpendLines(
    // The fixer round is in flight, or ran on a provider that reported no cost.
    [implement("impl"), fixerRevise("quiet")],
    costs({ impl: 20 }),
  ).join("\n");
  // A subtotal has to say it is one. Reporting "$20 across 1 session" while
  // two sessions ran reads as a complete total that valued the other at zero.
  assert.match(lines, /spent at least \$20 so far/);
  assert.match(lines, /1 of its 2 sessions/);
  assert.match(lines, /unknown, not free/);
  assert.doesNotMatch(
    lines,
    /fixer session has cost/,
    "no fixer assignment has been measured, so no rate is claimed",
  );
});

test("a route the run never used claims no rate at all", () => {
  // A session used only as the implementer must not surface as a fixer rate
  // of zero, which would read as free work nobody did.
  const lines = routingSpendLines(
    [implement("impl"), implementerRevise("impl"), implementerRevise("impl")],
    costs({ impl: 45 }),
  ).join("\n");
  assert.match(lines, /implementer's own session has cost \$15 on average/);
  assert.doesNotMatch(lines, /fixer session has cost/);
});

test("the section refuses to become a reason to soften a finding", () => {
  const lines = routingSpendLines(
    [implement("impl")],
    costs({ impl: 12 }),
  ).join("\n");
  assert.match(lines, /Cost is evidence here, never an instruction/);
  assert.match(lines, /may not leave a finding unanswered, downgrade one/);
  assert.match(
    lines,
    /a finding disputing the approach is worth the expensive session/,
  );
});
