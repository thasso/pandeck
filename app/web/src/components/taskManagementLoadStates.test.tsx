// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { TaskComment, TaskItem } from "@assistant/shared";
import type { AssistantActions } from "../hooks/useAssistant.ts";
import type { BacklogState } from "../hooks/useBacklog.ts";
import type { Prefs } from "../hooks/usePrefs.ts";
import { ALL_PROJECT_FILTER } from "../lib/backlogTreeModel.ts";
import {
  failed,
  loading,
  ready,
  refreshing,
  type LoadState,
} from "../lib/loadState.ts";
import { TaskManagementPage } from "./TaskManagementPage.tsx";

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

const item: TaskItem = {
  id: "455",
  title: "Stable Task surface",
  status: "doing",
  source: { createdBy: "user" },
  description: "## Retained body\n\nReadable while refreshing.",
  descriptionPreview: "Retained body",
  createdAt: 1,
  updatedAt: 2,
};

const comment: TaskComment = {
  id: "comment-1",
  taskId: item.id,
  author: { kind: "user", name: "Alice" },
  body: "Keep this activity visible.",
  createdAt: 3,
};

const actions = {
  requestTaskDetail: () => {},
  listTaskComments: () => {},
  unwatchTaskComments: () => {},
} as unknown as AssistantActions;

function markup({
  tasks = [item],
  selectedId = item.id,
  detailState = ready<TaskItem | null>(item),
  commentsState = ready<TaskComment[]>([]),
  workflowRuns = [],
  failure,
}: {
  tasks?: TaskItem[] | null;
  selectedId?: string | null;
  detailState?: LoadState<TaskItem | null>;
  commentsState?: LoadState<TaskComment[]>;
  workflowRuns?: [] | null;
  failure?: string;
} = {}): string {
  const backlogState = {
    connected: true,
    taskList: tasks === null ? null : { items: tasks, updatedAt: 4 },
    taskListError: null,
    projectList: null,
    taskMutations: {},
    taskProjectsAssignedSeq: 0,
    sessions: [],
    worktreeMerge: {},
  } as BacklogState;
  return renderToStaticMarkup(
    <TaskManagementPage
      backlogState={backlogState}
      connected
      detailState={detailState}
      commentsState={commentsState}
      failure={failure}
      onDismissFailure={() => {}}
      workflowRuns={workflowRuns}
      workflowCards={{}}
      sessions={[]}
      taskMutations={{}}
      actions={actions}
      prefs={prefs}
      onUpdatePrefs={() => {}}
      selectedId={selectedId}
      onSelect={() => {}}
      onCloseDetail={() => {}}
      onClose={() => {}}
      onOpenSession={() => {}}
    />,
  );
}

describe("Task management load states", () => {
  it("distinguishes a cold selected route, a missing Task, and no selection", () => {
    expect(markup({ tasks: null })).toContain("Loading Task…");
    expect(markup({ tasks: [], selectedId: "missing" })).toContain(
      "Task-missing is not available",
    );
    expect(markup({ tasks: [], selectedId: null })).toContain(
      "Select a task to see its details.",
    );
  });

  it("retains the same Task body through refresh and refresh failure", () => {
    const refreshingHtml = markup({ detailState: refreshing(item) });
    expect(refreshingHtml).toContain("Retained body");
    expect(refreshingHtml).toContain("Refreshing description");

    const failedHtml = markup({
      detailState: failed("Could not refresh the Task.", item),
    });
    expect(failedHtml).toContain("Retained body");
    expect(failedHtml).toContain("Could not refresh the Task.");
    expect(failedHtml).toContain("Retry");
  });

  it("does not claim empty activity before an authoritative answer", () => {
    const cold = markup({ commentsState: loading() });
    expect(cold).toContain("Loading Task activity");
    expect(cold).not.toContain("No activity yet");

    const empty = markup({ commentsState: ready([]) });
    expect(empty).toContain("No activity yet");
  });

  it("retains activity while refreshing or failed", () => {
    expect(markup({ commentsState: refreshing([comment]) })).toContain(
      "Keep this activity visible.",
    );
    const failedHtml = markup({
      commentsState: failed("Could not refresh activity.", [comment]),
    });
    expect(failedHtml).toContain("Keep this activity visible.");
    expect(failedHtml).toContain("Could not refresh activity.");
  });

  // A write about the Task itself that no control here tracks — archiving it is
  // the usual one — is rendered ON the Task, which is what lets the announcer
  // stay quiet about it (`docs/messaging.md`).
  it("renders the failure the open Task is carrying, with its dismiss", () => {
    const html = markup({ failure: "Failed to archive task: locked" });
    expect(html).toContain("Failed to archive task: locked");
    expect(html).toContain("Dismiss");
    // R2: the Task's own content stays readable underneath it.
    expect(html).toContain("Retained body");
    expect(markup()).not.toContain("Failed to archive task");

    // And it is drawn even when the Task's body is NOT there — a refused delete
    // has already taken the row out of the list optimistically, so a note only
    // the loaded panel could draw would be claimed here and shown by nothing.
    const gone = markup({
      tasks: [],
      selectedId: "missing",
      failure: "Failed to delete task: locked",
    });
    expect(gone).toContain("Failed to delete task: locked");
    expect(gone).toContain("Task-missing is not available");
  });

  it("reserves the workflow card slot until the topic answers", () => {
    const html = markup({ workflowRuns: null });
    expect(html).toContain("Loading Task workflow runs");
    expect(markup({ workflowRuns: [] })).not.toContain(
      "Loading Task workflow runs",
    );
  });
});
