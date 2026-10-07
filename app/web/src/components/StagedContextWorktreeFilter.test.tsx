// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorktreeRecord } from "@assistant/shared";
import { StagedContextPanel } from "./StagedContext.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function wt(id: string, branch: string, isMain = false): WorktreeRecord {
  return {
    id,
    projectId: "proj",
    branch,
    baseBranch: "main",
    path: `/tmp/${id}`,
    isMain,
    createdAt: 0,
  } as WorktreeRecord;
}

// Past the screenful threshold (> 8) so the filter input renders at all.
const worktrees = [
  wt("main:proj", "main", true),
  ...Array.from({ length: 9 }, (_, i) => wt(`wt${i}`, `feature/branch-${i}`)),
];

let container: HTMLDivElement;
let root: Root;

const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  if (scrollIntoViewDescriptor)
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollIntoView",
      scrollIntoViewDescriptor,
    );
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("hides the pinned/rest divider while a search query narrows the list", () => {
  act(() => {
    root.render(
      <StagedContextPanel
        value={{ projectId: "proj", worktreeId: null, task: null }}
        projects={[]}
        worktrees={worktrees}
        tasks={[]}
        projectsLoaded
        worktreesLoaded
        tasksLoaded
        onChangeProject={() => {}}
        onChangeWorktree={() => {}}
        onChangeTask={() => {}}
        initialField="worktree"
      />,
    );
  });
  expect(container.querySelector("hr")).not.toBeNull();

  const input = container.querySelector("input");
  if (!(input instanceof HTMLInputElement))
    throw new Error("Expected the worktree filter input");
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, "branch-3");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  expect(container.querySelector("hr")).toBeNull();
});
