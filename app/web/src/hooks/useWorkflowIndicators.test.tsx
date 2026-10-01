// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { WorkflowRunSummary } from "@assistant/shared";
import { useWorkflowIndicators } from "./useWorkflowIndicators.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const base: WorkflowRunSummary = {
  id: "1",
  taskId: "370",
  recipeId: "code-delivery",
  recipeVersion: 4,
  lifecycle: "active",
  limits: { maxIterations: 3, maxReviewPasses: 1 },
  createdAt: 1,
  updatedAt: 1,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

it("keeps the same Map when a broadcast changes no indicator", () => {
  const seen: ReturnType<typeof useWorkflowIndicators>[] = [];
  function Probe({ runs }: { runs: WorkflowRunSummary[] }) {
    seen.push(useWorkflowIndicators(runs));
    return null;
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<Probe runs={[base]} />));
  act(() =>
    root!.render(
      <Probe runs={[{ ...base, updatedAt: 99, branch: "moved" }]} />,
    ),
  );
  expect(seen.at(-1)).toBe(seen[0]);

  act(() =>
    root!.render(
      <Probe
        runs={[{ ...base, lifecycle: "paused", lifecycleReason: "look" }]}
      />,
    ),
  );
  expect(seen.at(-1)).not.toBe(seen[0]);
});
