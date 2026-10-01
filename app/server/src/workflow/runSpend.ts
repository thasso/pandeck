/**
 * What this run has SPENT so far, rendered for the coordinator's routing
 * decision ([Task-592](pa://task/592)).
 *
 * The coordinator chooses who answers a finding from role sets, families,
 * prior fixers and remaining iterations — and, until now, from nothing at all
 * about what any of it costs. It was making a cost trade-off blind, and the
 * measured result is that 53 fix rounds routed to an implementer's own session
 * accounted for 25% of every dollar this engine has ever spent, at $14.64 a
 * round against $0.73 for the same work in a fresh fixer session.
 *
 * This is I/O — usage totals are live rows that keep moving — so it can never
 * enter the recipe, which is a pure function of (run, steps) and must re-derive
 * the same decision after a restart. It follows the review-handoff precedent
 * instead: the dispatcher reads it and hands the rendered section to the
 * assignment builder.
 *
 * Only THIS RUN's own sessions are measured. A cross-run average would be a
 * better predictor and a worse fact; the run can prove what it spent, and the
 * numbers a coordinator acts on should be ones the run itself can show.
 */

import { sessionStore } from "../db/sessionStore.ts";
import type { WorkflowStepRow } from "../db/workflowStore.ts";
import type { WorkflowJsonValue } from "@assistant/shared";

/** A session's spend, shared evenly across the assignments it served. */
type SessionSpend = {
  /** Total recorded cost of the session, in USD. */
  total: number;
  /** Assignments the run gave it. */
  assignments: number;
};

/**
 * What one session has cost in USD, or undefined when nothing was recorded for
 * it. A parameter rather than a direct read so the rendering stays a pure
 * function of what it is told — the only part of this worth testing is the
 * arithmetic and the sentences, and neither needs a database to be true.
 */
type SessionCostReader = (sessionId: string) => number | undefined;

/** The live reader: recorded usage totals, in USD. */
const recordedSessionCost: SessionCostReader = (sessionId) => {
  const micros = sessionStore.getUsageTotals(sessionId)?.costMicros;
  return micros === undefined ? undefined : micros / 1_000_000;
};

function payloadRecord(value: unknown): Record<string, WorkflowJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, WorkflowJsonValue>)
    : {};
}

/** Whether a revise round was routed to a fixer rather than the implementer. */
function isFixerRound(step: WorkflowStepRow): boolean {
  const fixer = payloadRecord(payloadRecord(step.payload).fixer);
  return typeof fixer.modelId === "string";
}

/**
 * Per-session spend for every session this run has used. A session with no
 * recorded usage yet is absent rather than zero: "not measured" and "cost
 * nothing" are different claims, and only one of them is ever true.
 */
function spendBySession(
  steps: readonly WorkflowStepRow[],
  costOf: SessionCostReader,
): Map<string, SessionSpend> {
  const assignments = new Map<string, number>();
  for (const step of steps) {
    if (step.kind !== "agent" || step.executor?.kind !== "session") continue;
    const id = step.executor.id;
    assignments.set(id, (assignments.get(id) ?? 0) + 1);
  }
  const spend = new Map<string, SessionSpend>();
  for (const [id, count] of assignments) {
    const total = costOf(id);
    if (total === undefined) continue;
    spend.set(id, { total, assignments: count });
  }
  return spend;
}

function usd(amount: number): string {
  return amount >= 10 ? `$${amount.toFixed(0)}` : `$${amount.toFixed(2)}`;
}

/**
 * The spend section for a fix-routing decision, or undefined when this run has
 * not recorded enough to say anything true.
 *
 * Deliberately NOT a recommendation. It states what the two routes have cost in
 * this run and leaves the judgement where it belongs: a finding that disputes
 * the approach is worth an expensive session, and the coordinator is the one
 * who can tell that from a targeted correction.
 */
export function routingSpendLines(
  steps: readonly WorkflowStepRow[],
  costOf: SessionCostReader = recordedSessionCost,
): string[] {
  const spend = spendBySession(steps, costOf);
  if (spend.size === 0) return [];
  let runTotal = 0;
  for (const entry of spend.values()) runTotal += entry.total;
  const sessionsUsed = new Set(
    steps
      .filter(
        (step) => step.kind === "agent" && step.executor?.kind === "session",
      )
      .map((step) => step.executor!.id),
  ).size;
  const unmeasured = sessionsUsed - spend.size;

  const implementerSessions = new Set<string>();
  const fixerSessions = new Set<string>();
  for (const step of steps) {
    if (step.kind !== "agent" || step.executor?.kind !== "session") continue;
    const payload = payloadRecord(step.payload);
    if (payload.role !== "implementer") continue;
    (isFixerRound(step) ? fixerSessions : implementerSessions).add(
      step.executor.id,
    );
  }

  const perAssignment = (ids: Set<string>): number | undefined => {
    let cost = 0;
    let assignments = 0;
    for (const id of ids) {
      const entry = spend.get(id);
      if (!entry) continue;
      cost += entry.total;
      assignments += entry.assignments;
    }
    return assignments > 0 ? cost / assignments : undefined;
  };
  const implementerRate = perAssignment(implementerSessions);
  const fixerRate = perAssignment(fixerSessions);

  return [
    // A SUBTOTAL, and named as one whenever it is: a session whose provider
    // has reported nothing yet is unknown, and a total that quietly leaves it
    // out reads as a total that counted it as free.
    unmeasured > 0
      ? `This run has spent at least ${usd(runTotal)} so far: that is ${String(spend.size)} of its ${String(sessionsUsed)} sessions, and the other ${String(unmeasured)} ${unmeasured === 1 ? "has" : "have"} not reported a cost yet — unknown, not free.`
      : `This run has spent ${usd(runTotal)} so far across ${String(spend.size)} session${spend.size === 1 ? "" : "s"}.`,
    ...(implementerRate !== undefined
      ? [
          `An assignment in the implementer's own session has cost ${usd(implementerRate)} on average in this run; that session re-reads everything it has already done, so its next round costs more than its last.`,
        ]
      : []),
    ...(fixerRate !== undefined
      ? [
          `An assignment in a fixer session has cost ${usd(fixerRate)} on average in this run.`,
        ]
      : []),
    "Weigh that against what the findings ask for rather than minimizing it: a finding disputing the approach is worth the expensive session, and a targeted correction is not. Cost is evidence here, never an instruction — you may not leave a finding unanswered, downgrade one, or pick a runtime you judge unequal to the work in order to spend less.",
  ];
}
