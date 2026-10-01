// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { TaskItem } from "@assistant/shared";
import type { AssistantActions, UIState } from "../hooks/useAssistant.ts";
import type { Prefs } from "../hooks/usePrefs.ts";
import { ALL_PROJECT_FILTER } from "../lib/backlogTreeModel.ts";
import { TaskManagementPage } from "./TaskManagementPage.tsx";
import { ready } from "../lib/loadState.ts";

/**
 * The Task page's two R1 gates (`app/web/docs/loading-states.md`): the detail
 * pane must not answer a Task route with "select a task" while the list that
 * carries it is still cold, and the description must not print the word
 * "Loading" where the body will be.
 */

if (!window.matchMedia)
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

beforeEach(() => window.localStorage.clear());

const prefs = {
  backlogView: "backlog",
  backlogViewMode: "normal",
  backlogProjectFilter: ALL_PROJECT_FILTER,
  backlogStatusFilter: ["todo", "doing", "done"],
  backlogMasterWidth: 360,
} as Prefs;

function task(patch: Partial<TaskItem> = {}): TaskItem {
  return {
    id: "7",
    title: "Ship the thing",
    status: "todo",
    source: { createdBy: "user" },
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as TaskItem;
}

function render(options: {
  items: TaskItem[] | null;
  selectedId: string | null;
  taskDetails?: Record<string, TaskItem>;
}): string {
  const state = {
    connected: true,
    taskList: options.items ? { items: options.items, updatedAt: 1 } : null,
    projectList: null,
    sessions: [],
    worktreeMerge: {},
    workflowRuns: [],
    workflowCards: {},
    taskMutations: {},
    taskProjectsAssignedSeq: 0,
  } as unknown as UIState;
  return renderToStaticMarkup(
    <TaskManagementPage
      backlogState={state}
      connected
      detailState={
        options.selectedId && options.taskDetails?.[options.selectedId]
          ? ready(options.taskDetails[options.selectedId]!)
          : undefined
      }
      commentsState={ready([])}
      workflowRuns={[]}
      workflowCards={{}}
      sessions={[]}
      taskMutations={{}}
      actions={
        {
          listProjects: () => {},
          listTaskComments: () => {},
          unwatchTaskComments: () => {},
        } as unknown as AssistantActions
      }
      prefs={prefs}
      onUpdatePrefs={() => {}}
      selectedId={options.selectedId}
      onSelect={() => {}}
      onCloseDetail={() => {}}
      onClose={() => {}}
      onOpenSession={() => {}}
    />,
  );
}

describe("TaskManagementPage detail pane", () => {
  it("holds the pane for a selected Task while the list is still cold", () => {
    const html = render({ items: null, selectedId: "7" });
    expect(html).not.toContain("Select a task to see its details.");
    expect(html).toContain("Loading Task…");
  });

  it("keeps 'select a task' for the genuinely unselected pane", () => {
    // No id in the route is IDLE, not loading: nothing was asked for.
    expect(render({ items: null, selectedId: null })).toContain(
      "Select a task to see its details.",
    );
    expect(render({ items: [], selectedId: null })).toContain(
      "Select a task to see its details.",
    );
  });
});

describe("TaskManagementPage description", () => {
  it("reserves the body's lines when there is no preview to stand in", () => {
    const html = render({ items: [task()], selectedId: "7" });
    expect(html).not.toContain("Loading…");
    expect(html).not.toContain("No description yet.");
    expect(html).toContain('aria-label="Loading description"');
  });

  it("prefers the summary's preview over a placeholder", () => {
    const html = render({
      items: [task({ descriptionPreview: "the first line of the body" })],
      selectedId: "7",
    });
    expect(html).toContain("the first line of the body");
    expect(html).toContain('aria-label="Loading description"');
  });

  it("says there is no description only once the body has arrived", () => {
    const html = render({
      items: [task()],
      selectedId: "7",
      taskDetails: { "7": task({ description: "" }) },
    });
    expect(html).toContain("No description yet.");
    expect(html).not.toContain('aria-label="Loading description"');
  });
});
