import { describe, expect, it } from "vitest";
import type { WorkflowRunSummary } from "@assistant/shared";
import {
  workflowIndicatorEntries,
  workflowIndicatorKey,
} from "./workflowIndicator.ts";

function run(
  id: string,
  taskId: string,
  lifecycle: WorkflowRunSummary["lifecycle"],
): WorkflowRunSummary {
  return {
    id,
    taskId,
    recipeId: "code-delivery",
    recipeVersion: 4,
    lifecycle,
    limits: { maxIterations: 3, maxReviewPasses: 1 },
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("workflow indicators", () => {
  it("folds active and paused runs per Task and ignores terminal history", () => {
    expect(
      workflowIndicatorEntries([
        run("1", "20", "active"),
        run("2", "20", "paused"),
        run("3", "21", "completed"),
        run("4", "22", "paused"),
      ]),
    ).toEqual([
      ["20", { running: true, attention: true }],
      ["22", { running: false, attention: true }],
    ]);
  });

  it("gives equal content the same compact identity key", () => {
    const first = workflowIndicatorEntries([
      run("1", "2", "paused"),
      run("2", "1", "active"),
    ]);
    const second = workflowIndicatorEntries([
      run("2", "1", "active"),
      run("1", "2", "paused"),
    ]);
    expect(workflowIndicatorKey(first)).toBe(workflowIndicatorKey(second));
  });
});
