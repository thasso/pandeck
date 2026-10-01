import { useMemo } from "react";
import type { WorkflowRunSummary } from "@assistant/shared";
import {
  NO_WORKFLOW_INDICATORS,
  workflowIndicatorEntries,
  workflowIndicatorKey,
  type WorkflowIndicators,
} from "../lib/workflowIndicator.ts";

/** A content-stable per-Task Workflow Run projection for memoized Backlog rows. */
export function useWorkflowIndicators(
  runs: readonly WorkflowRunSummary[],
): WorkflowIndicators {
  const entries = useMemo(() => workflowIndicatorEntries(runs), [runs]);
  const key = workflowIndicatorKey(entries);
  // The key, not the freshly derived array, is the identity contract.
  return useMemo(
    () => (entries.length ? new Map(entries) : NO_WORKFLOW_INDICATORS),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` IS the content of `entries`; depending on the array would hand memoized Backlog rows a new Map on every run broadcast
    [key],
  );
}
