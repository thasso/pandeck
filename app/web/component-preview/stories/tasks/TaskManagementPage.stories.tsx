import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  AssistantActions,
  UIState,
} from "../../../src/hooks/useAssistant.ts";
import type { Prefs } from "../../../src/hooks/usePrefs.ts";
import type { TaskItem } from "@assistant/shared";
import { TaskManagementPage } from "../../../src/components/TaskManagementPage.tsx";
import { ALL_PROJECT_FILTER } from "../../../src/lib/backlogTreeModel.ts";
import { ready } from "../../../src/lib/loadState.ts";
import { taskAreaProjects, taskAreaTask } from "../../fixtures/tasks.ts";

const prefs = {
  backlogView: "backlog",
  backlogViewMode: "normal",
  backlogProjectFilter: ALL_PROJECT_FILTER,
  backlogStatusFilter: ["todo", "doing", "done"],
  backlogMasterWidth: 360,
} as Prefs;
const actions = new Proxy({}, { get: () => () => {} }) as AssistantActions;

/**
 * The open Task as an agent left it: still in the Inbox (never triaged) and
 * carrying a status suggestion — so the detail leads with both notice cards.
 */
const noticedTask: TaskItem = {
  ...(taskAreaTask as TaskItem),
  source: { createdBy: "agent", agentType: "developer" },
  statusSuggestion: {
    to: "done",
    at: Date.now() - 20 * 60_000,
    reason:
      "The backlog and project pages now use the shared property list, and the review found nothing left to change.",
  },
};

/** A plain Backlog row to stand beside the linked Task. */
function backlogTask(
  id: string,
  title: string,
  status: TaskItem["status"],
): TaskItem {
  return {
    id,
    title,
    status,
    description: "",
    projectId: "pandeck",
    source: { createdBy: "user" },
    triagedAt: Date.now(),
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now() - 60 * 60_000,
  };
}

/**
 * A Task linked every way a Task can be: held up by one open and one finished
 * Task, holding up another, and related to an archived one. The open blocker
 * makes it blocked, which its Backlog row says as well as its page.
 */
const linkedTasks: TaskItem[] = [
  {
    ...(taskAreaTask as TaskItem),
    triagedAt: Date.now(),
    openBlockerCount: 1,
    description:
      "Keep the backlog scannable while bringing its controls into the shared UI system.",
    blocked: true,
    links: {
      blockedBy: [
        {
          id: "698",
          title: "Settle the shared property list",
          status: "doing",
          projectId: "pandeck",
          archived: false,
        },
        {
          id: "702",
          title: "Move the inspector onto shadcn sections",
          status: "done",
          projectId: "pandeck",
          archived: false,
        },
      ],
      blocks: [
        {
          id: "731",
          title: "Write the Backlog walkthrough for the docs site",
          status: "todo",
          projectId: "docs",
          archived: false,
        },
      ],
      relates: [
        {
          id: "655",
          title: "Earlier pass at the project page layout",
          status: "todo",
          projectId: "pandeck",
          archived: true,
        },
      ],
    },
  },
  backlogTask("698", "Settle the shared property list", "doing"),
  {
    ...backlogTask(
      "731",
      "Write the Backlog walkthrough for the docs site",
      "todo",
    ),
    projectId: "docs",
    openBlockerCount: 1,
  },
];

function renderPage(
  state: "loading" | "empty" | "tasks" | "notices" | "links",
) {
  const items =
    state === "loading"
      ? null
      : state === "empty"
        ? []
        : state === "notices"
          ? [noticedTask]
          : state === "links"
            ? linkedTasks
            : [taskAreaTask as TaskItem];
  const backlogState = {
    connected: true,
    taskList: items === null ? null : { items, updatedAt: Date.now() },
    projectList: {
      projects: taskAreaProjects,
    } as unknown as UIState["projectList"],
    taskListError: null,
    sessions: [],
    worktreeMerge: {},
    taskMutations: {},
    taskProjectsAssignedSeq: 0,
  } as unknown as UIState;
  return (
    <TaskManagementPage
      backlogState={backlogState}
      connected
      workflowRuns={[]}
      workflowCards={{}}
      accountNames={{}}
      sessions={[]}
      taskMutations={{}}
      actions={actions}
      prefs={prefs}
      onUpdatePrefs={() => {}}
      selectedId={
        state === "notices"
          ? noticedTask.id
          : state === "links"
            ? linkedTasks[0]!.id
            : null
      }
      {...(state === "links" ? { detailState: ready(linkedTasks[0]!) } : {})}
      onSelect={() => {}}
      onCloseDetail={() => {}}
      onClose={() => {}}
      onOpenSession={() => {}}
    />
  );
}

const meta = {
  title: "App/Tasks/Backlog page",
  component: TaskManagementPage,
  args: {
    backlogState: {} as never,
    connected: true,
    workflowRuns: [],
    workflowCards: {},
    accountNames: {},
    sessions: [],
    taskMutations: {},
    actions,
    prefs,
    onUpdatePrefs: () => {},
    selectedId: null,
    onSelect: () => {},
    onCloseDetail: () => {},
    onClose: () => {},
    onOpenSession: () => {},
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TaskManagementPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = { render: () => renderPage("loading") };
export const Empty: Story = { render: () => renderPage("empty") };
export const WithTasks: Story = { render: () => renderPage("tasks") };
/** A Task opened with its notice cards: an agent's suggestion and the Inbox. */
export const TaskNotices: Story = { render: () => renderPage("notices") };
/**
 * A blocked Task's page: the Blocked marker on its facts line, its links
 * grouped under it, and the blocked rows in the Backlog beside it.
 */
export const TaskLinks: Story = { render: () => renderPage("links") };
