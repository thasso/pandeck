/**
 * @module workflowStart
 * @purpose Settle backgrounded `startWorkflowRun` requests: given the ids the
 *   user sent to the background ("Run in background" on the start flow) and the
 *   per-request progress map, decide which requests just reached a terminal
 *   phase, what toast each outcome earns, and which entries can be dropped.
 * @useWhen `App.tsx`'s background-start effect, on every `workflowRunStarts`
 *   change. Pure so two interleaved starts settling in any order — or in the
 *   same render — are unit-testable.
 */
import type { WorkflowRunStartPhase } from "@assistant/shared";

/** The slice of one request's progress this module reads (structurally
 *  compatible with `useAssistant`'s `WorkflowRunStartState`). */
export interface WorkflowStartProgress {
  phase: WorkflowRunStartPhase;
  branch?: string;
  error?: string;
}

export interface WorkflowStartToast {
  message: string;
  tone: "success" | "error";
}

export interface BackgroundStartSettlement {
  /** Ids that reached a terminal phase: untrack them and clear their entries. */
  settled: string[];
  /** One toast per settled id, in the same order. */
  toasts: WorkflowStartToast[];
}

/** The toast one terminal start outcome earns. */
export function workflowStartOutcomeToast(
  state: WorkflowStartProgress,
): WorkflowStartToast | null {
  if (state.phase === "started")
    return {
      message: state.branch
        ? `Workflow run started on ${state.branch}.`
        : "Workflow run started.",
      tone: "success",
    };
  if (state.phase === "failed")
    return {
      message: state.error ?? "Starting the workflow run failed.",
      tone: "error",
    };
  return null;
}

/**
 * Which tracked background requests have settled. EVERY tracked id is checked
 * against the map — never just the latest message — so two provisioning runs
 * finishing close together each deliver their own outcome and none is lost.
 */
export function settleBackgroundWorkflowStarts(
  tracked: readonly string[],
  starts: Record<string, WorkflowStartProgress>,
): BackgroundStartSettlement {
  const settled: string[] = [];
  const toasts: WorkflowStartToast[] = [];
  for (const requestId of tracked) {
    const state = starts[requestId];
    if (!state) continue;
    const toast = workflowStartOutcomeToast(state);
    if (!toast) continue;
    settled.push(requestId);
    toasts.push(toast);
  }
  return { settled, toasts };
}
