// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskItem, WorkflowRunSummary } from "@assistant/shared";
import type { AssistantActions } from "../hooks/useAssistant.ts";
import type { BacklogState } from "../hooks/useBacklog.ts";
import type { Prefs } from "../hooks/usePrefs.ts";
import { ALL_PROJECT_FILTER } from "../lib/backlogTreeModel.ts";
import { ready } from "../lib/loadState.ts";
import {
  runIdFromHash,
  workflowRunAnchorId,
  workflowRunPath,
} from "../lib/workflowRunRoutes.ts";
import { TaskManagementPage } from "./TaskManagementPage.tsx";

/**
 * The other half of the Sessions inbox's Workflow Run item ([Task-676](pa://task/676)):
 * selecting one has to land on THAT run's card, on the right Task — and it has
 * to do so although both loads it depends on are still on their way when the
 * address is reached. Native fragment scrolling resolves once against a page
 * that has no such element yet; these tests hold the wait that replaces it.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const item: TaskItem = {
  id: "676",
  title: "Surface live Workflow Runs",
  status: "doing",
  source: { createdBy: "user" },
  description: "",
  createdAt: 1,
  updatedAt: 2,
};

const run: WorkflowRunSummary = {
  id: "r1",
  taskId: item.id,
  recipeId: "code-delivery",
  recipeVersion: 1,
  lifecycle: "paused",
  lifecycleReason: "Merge decision: the pull request is green.",
  limits: { maxIterations: 3, maxReviewPasses: 2 },
  createdAt: 1,
  updatedAt: 2,
};

const prefs = {
  backlogView: "backlog",
  backlogViewMode: "normal",
  backlogProjectFilter: ALL_PROJECT_FILTER,
  backlogStatusFilter: ["todo", "doing", "done"],
  backlogMasterWidth: 360,
} as Prefs;

const actions = {
  requestTaskDetail: () => {},
  setOpenTaskProjection: () => {},
} as unknown as AssistantActions;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const scrolled: HTMLElement[] = [];

beforeEach(() => {
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolled.push(this as HTMLElement);
  };
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

function render(runs: WorkflowRunSummary[] | null) {
  container ??= document.createElement("div");
  if (!container.isConnected) document.body.append(container);
  root ??= createRoot(container);
  const backlogState = {
    connected: true,
    taskList: { items: [item], updatedAt: 4 },
    taskListError: null,
    projectList: null,
    taskMutations: {},
    taskProjectsAssignedSeq: 0,
    sessions: [],
    worktreeMerge: {},
  } as unknown as BacklogState;
  act(() => {
    root!.render(
      <TaskManagementPage
        backlogState={backlogState}
        connected
        detailState={ready<TaskItem | null>(item)}
        onDismissFailure={() => {}}
        workflowRuns={runs}
        workflowCards={{}}
        sessions={[]}
        taskMutations={{}}
        actions={actions}
        prefs={prefs}
        onUpdatePrefs={() => {}}
        selectedId={item.id}
        onSelect={() => {}}
        onCloseDetail={() => {}}
        onClose={() => {}}
        onOpenSession={() => {}}
      />,
    );
  });
}

describe("addressing one Workflow Run", () => {
  it("builds and reads the Task-anchored address", () => {
    expect(workflowRunPath("676", "r1")).toBe("/tasks/676#workflow-run-r1");
    expect(runIdFromHash("#workflow-run-r1")).toBe("r1");
    // Any other fragment addresses no run — above all the transcript's.
    expect(runIdFromHash("#m-entry-4")).toBe(null);
    expect(runIdFromHash("")).toBe(null);
  });

  it("waits for the run to load, then scrolls to it and focuses it", () => {
    window.history.replaceState({}, "", workflowRunPath(item.id, run.id));
    // The runs have not arrived: there is nothing to jump to, and nothing does.
    render(null);
    expect(document.getElementById(workflowRunAnchorId(run.id))).toBe(null);
    expect(scrolled).toHaveLength(0);

    render([run]);
    const anchor = document.getElementById(workflowRunAnchorId(run.id));
    expect(anchor).not.toBe(null);
    expect(scrolled).toEqual([anchor]);
    expect(document.activeElement).toBe(anchor);
    // The card the address named is the one that carries the run's reason.
    expect(anchor?.textContent).toContain(
      "Merge decision: the pull request is green.",
    );
  });

  it("jumps once per address, not on every later render", () => {
    window.history.replaceState({}, "", workflowRunPath(item.id, run.id));
    render([run]);
    expect(scrolled).toHaveLength(1);
    render([{ ...run, updatedAt: 3 }]);
    expect(scrolled).toHaveLength(1);
  });

  it("leaves the page alone when the address names no run", () => {
    window.history.replaceState({}, "", `/tasks/${item.id}`);
    render([run]);
    expect(scrolled).toHaveLength(0);
    expect(document.getElementById(workflowRunAnchorId(run.id))).not.toBe(null);
  });
});
