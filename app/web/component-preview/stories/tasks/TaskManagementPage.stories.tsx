import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  AssistantActions,
  UIState,
} from "../../../src/hooks/useAssistant.ts";
import type { Prefs } from "../../../src/hooks/usePrefs.ts";
import type { TaskItem } from "@assistant/shared";
import { TaskManagementPage } from "../../../src/components/TaskManagementPage.tsx";
import { ALL_PROJECT_FILTER } from "../../../src/lib/backlogTreeModel.ts";
import { taskAreaProjects, taskAreaTask } from "../../fixtures/tasks.ts";

const prefs = {
  backlogView: "backlog",
  backlogViewMode: "normal",
  backlogProjectFilter: ALL_PROJECT_FILTER,
  backlogStatusFilter: ["todo", "doing", "done"],
  backlogMasterWidth: 360,
} as Prefs;
const actions = new Proxy({}, { get: () => () => {} }) as AssistantActions;

function renderPage(state: "loading" | "empty" | "tasks") {
  const items =
    state === "loading"
      ? null
      : state === "empty"
        ? []
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
      sessions={[]}
      taskMutations={{}}
      actions={actions}
      prefs={prefs}
      onUpdatePrefs={() => {}}
      selectedId={null}
      onSelect={() => {}}
      onCloseDetail={() => {}}
      onClose={() => {}}
      onOpenSession={() => {}}
    />
  );
}

const meta = {
  title: "Tasks/Backlog page",
  component: TaskManagementPage,
  args: {
    backlogState: {} as never,
    connected: true,
    workflowRuns: [],
    workflowCards: {},
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
