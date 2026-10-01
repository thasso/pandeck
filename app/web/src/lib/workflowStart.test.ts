import { describe, expect, it } from "vitest";
import {
  settleBackgroundWorkflowStarts,
  workflowStartOutcomeToast,
  type WorkflowStartProgress,
} from "./workflowStart.ts";

function entry(
  _requestId: string,
  patch: Partial<WorkflowStartProgress>,
): WorkflowStartProgress {
  return { phase: "creating", ...patch };
}

describe("workflowStartOutcomeToast", () => {
  it("maps started to a success toast naming the branch", () => {
    expect(
      workflowStartOutcomeToast({ phase: "started", branch: "t42-widget" }),
    ).toEqual({
      message: "Workflow run started on t42-widget.",
      tone: "success",
    });
    expect(workflowStartOutcomeToast({ phase: "started" })).toEqual({
      message: "Workflow run started.",
      tone: "success",
    });
  });

  it("maps failed to an error toast carrying the server's reason", () => {
    expect(
      workflowStartOutcomeToast({ phase: "failed", error: "boom" }),
    ).toEqual({ message: "boom", tone: "error" });
    expect(workflowStartOutcomeToast({ phase: "failed" })).toEqual({
      message: "Starting the workflow run failed.",
      tone: "error",
    });
  });

  it("treats every provisioning phase as not yet an outcome", () => {
    for (const phase of ["naming", "creating", "submodules"] as const) {
      expect(workflowStartOutcomeToast({ phase })).toBeNull();
    }
  });
});

describe("settleBackgroundWorkflowStarts", () => {
  // The review finding this guards: TWO runs backgrounded while the first is
  // still provisioning. Neither outcome may be lost, in either arrival order.
  it("settles two interleaved background starts independently", () => {
    const tracked = ["req-a", "req-b"];

    // First run still provisioning, second already failed: only b settles.
    const firstWave = settleBackgroundWorkflowStarts(tracked, {
      "req-a": entry("req-a", { phase: "submodules", branch: "t1-alpha" }),
      "req-b": entry("req-b", { phase: "failed", error: "no space left" }),
    });
    expect(firstWave.settled).toEqual(["req-b"]);
    expect(firstWave.toasts).toEqual([
      { message: "no space left", tone: "error" },
    ]);

    // Later, with b untracked, a reaches its own terminal phase and still
    // delivers its own outcome — nothing was overwritten by b's earlier one.
    const remaining = tracked.filter((id) => !firstWave.settled.includes(id));
    const secondWave = settleBackgroundWorkflowStarts(remaining, {
      "req-a": entry("req-a", { phase: "started", branch: "t1-alpha" }),
      "req-b": entry("req-b", { phase: "failed", error: "no space left" }),
    });
    expect(secondWave.settled).toEqual(["req-a"]);
    expect(secondWave.toasts).toEqual([
      { message: "Workflow run started on t1-alpha.", tone: "success" },
    ]);
  });

  it("settles both in one pass when both outcomes are already terminal", () => {
    const result = settleBackgroundWorkflowStarts(["req-a", "req-b"], {
      "req-a": entry("req-a", { phase: "started", branch: "t1-alpha" }),
      "req-b": entry("req-b", { phase: "failed", error: "boom" }),
    });
    expect(result.settled).toEqual(["req-a", "req-b"]);
    expect(result.toasts).toEqual([
      { message: "Workflow run started on t1-alpha.", tone: "success" },
      { message: "boom", tone: "error" },
    ]);
  });

  it("ignores untracked requests and requests with no entry yet", () => {
    const result = settleBackgroundWorkflowStarts(["req-a"], {
      "req-b": entry("req-b", { phase: "started" }),
    });
    expect(result.settled).toEqual([]);
    expect(result.toasts).toEqual([]);
  });
});
