import type { WorkflowRunSummary } from "@assistant/shared";

export interface WorkflowIndicator {
  running: boolean;
  attention: boolean;
}

export type WorkflowIndicators = ReadonlyMap<string, WorkflowIndicator>;
export const NO_WORKFLOW_INDICATORS: WorkflowIndicators = new Map();

/** Active/paused Workflow Run attention, narrowed to one value per Task. */
export function workflowIndicatorEntries(
  runs: readonly WorkflowRunSummary[],
): Array<readonly [string, WorkflowIndicator]> {
  const byTask = new Map<string, WorkflowIndicator>();
  for (const run of runs) {
    if (run.lifecycle !== "active" && run.lifecycle !== "paused") continue;
    const previous = byTask.get(run.taskId);
    byTask.set(run.taskId, {
      running: Boolean(previous?.running || run.lifecycle === "active"),
      attention: Boolean(previous?.attention || run.lifecycle === "paused"),
    });
  }
  return [...byTask.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

/** Content identity for a stable indicator Map. */
export function workflowIndicatorKey(
  entries: readonly (readonly [string, WorkflowIndicator])[],
): string {
  return entries
    .map(
      ([taskId, indicator]) =>
        `${taskId}:${indicator.running ? "r" : ""}${indicator.attention ? "a" : ""}`,
    )
    .join("\n");
}
