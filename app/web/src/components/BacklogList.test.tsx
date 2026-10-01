// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { TaskListResponse } from "@assistant/shared";
import type { AssistantActions } from "../hooks/useAssistant.ts";
import type { BacklogState } from "../hooks/useBacklog.ts";
import type { Prefs } from "../hooks/usePrefs.ts";
import type { BacklogDensity } from "../lib/backlogTreeModel.ts";
import { ALL_PROJECT_FILTER } from "../lib/backlogTreeModel.ts";
import { BacklogList } from "./BacklogList.tsx";

/**
 * The Backlog's half of R1 (`app/web/docs/loading-states.md`): `state.taskList`
 * is `null` until the subscription answers, and every view under this component
 * reads a list that `?? []` has already flattened to "no Tasks". This is what
 * used to make a fresh sidebar say "No tasks yet. Add your first one above."
 * for as long as the first list took to arrive.
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
} as Prefs;

function render(
  taskList: TaskListResponse | null,
  density: BacklogDensity = "comfortable",
  taskListError: string | null = null,
): string {
  const state: BacklogState = {
    connected: true,
    taskList,
    taskListError,
    projectList: null,
    taskMutations: {},
    sessions: [],
    worktreeMerge: {},
  } as unknown as BacklogState;
  return renderToStaticMarkup(
    <BacklogList
      state={state}
      actions={{ listProjects: () => {} } as unknown as AssistantActions}
      prefs={prefs}
      onUpdatePrefs={() => {}}
      selectedId={null}
      onOpenTask={() => {}}
      density={density}
    />,
  );
}

const EMPTY_LIST = { items: [], updatedAt: 1 } as unknown as TaskListResponse;

describe("BacklogList first load", () => {
  it("reserves task rows instead of saying the Backlog is empty", () => {
    const html = render(null);
    expect(html).not.toContain("No tasks yet");
    expect(html).toContain('aria-label="Loading Tasks"');
    expect(html).toContain("animate-pulse");
  });

  it("says the Backlog is empty once the subscription answers with nothing", () => {
    const html = render(EMPTY_LIST);
    expect(html).toContain("No tasks yet. Add your first one above.");
    expect(html).not.toContain('aria-label="Loading Tasks"');
  });

  it("reserves the rail's shorter rows at tight density", () => {
    // R4: the placeholder is the height of the row it stands in for, and the
    // rail's rows are half a page row's height.
    expect(render(null, "tight")).toContain("h-7");
    expect(render(null, "comfortable")).toContain("h-11");
  });

  // A list that could not be READ is a condition on the collection, like the
  // project and worktree lists (`docs/messaging.md`): it is here whenever the
  // user is, with a retry, and never said in passing.
  it("renders a failed list read in place, over the rows it kept", () => {
    const html = render(EMPTY_LIST, "comfortable", "Failed to list tasks: EIO");
    expect(html).toContain("Failed to list tasks: EIO");
    expect(html).toContain("Retry");
    expect(render(EMPTY_LIST)).not.toContain("Failed to list tasks");
  });

  it("keeps the Focus and Inbox views off the empty text while cold", () => {
    for (const view of ["focus", "inbox"] as const) {
      const html = renderToStaticMarkup(
        <BacklogList
          state={
            {
              connected: true,
              taskList: null,
              projectList: null,
              taskMutations: {},
              sessions: [],
              worktreeMerge: {},
            } as unknown as BacklogState
          }
          actions={{ listProjects: () => {} } as unknown as AssistantActions}
          prefs={{ ...prefs, backlogView: view }}
          onUpdatePrefs={() => {}}
          selectedId={null}
          onOpenTask={() => {}}
          density="comfortable"
        />,
      );
      expect(html).toContain('aria-label="Loading Tasks"');
      expect(html).not.toContain("Nothing");
    }
  });
});
