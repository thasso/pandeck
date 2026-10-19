import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Item,
  ItemContent,
  ItemMedia,
} from "../../../src/components/ui/item.tsx";
import { TaskRowBody } from "../../../src/components/TaskRowBody.tsx";
import { BacklogFocusList } from "../../../src/components/BacklogFocusList.tsx";
import { BacklogInboxList } from "../../../src/components/BacklogInboxList.tsx";
import { TaskStatusIcon } from "../../../src/components/TaskStatusIcon.tsx";
import { buildTaskRowMeta } from "../../../src/lib/taskRowMeta.ts";
import { taskAreaProjects, taskAreaTask } from "../../fixtures/tasks.ts";

const meta = {
  title: "App/Tasks/Rows",
  component: TaskRowBody,
  args: {
    task: taskAreaTask,
    meta: null,
    projectsById: new Map(
      taskAreaProjects.map((project) => [project.id, project]),
    ),
    selected: false,
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof TaskRowBody>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FocusThreeLines: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Project and right-aligned Task id, title, then a static status glyph and Task signals.",
      },
    },
  },
  render: () => (
    <div className="w-80 surface-sidebar">
      <BacklogFocusList
        tasks={[taskAreaTask]}
        today={
          taskAreaTask.scheduledFor ?? new Date().toISOString().slice(0, 10)
        }
        projectsById={
          new Map(taskAreaProjects.map((project) => [project.id, project]))
        }
        sessionById={new Map()}
        showProjectBadge
        selectedId={taskAreaTask.id}
        onOpen={() => {}}
        onAcceptSuggestion={() => {}}
        onDismissSuggestion={() => {}}
        density="tight"
      />
    </div>
  ),
};

export const InboxRows: Story = {
  render: () => (
    <div className="w-80 surface-sidebar">
      <BacklogInboxList
        tasks={[
          taskAreaTask,
          {
            ...taskAreaTask,
            id: "715",
            title: "Arrival without a description",
            descriptionPreview: "",
          },
        ]}
        projectsById={
          new Map(taskAreaProjects.map((project) => [project.id, project]))
        }
        metaContext={{
          today:
            taskAreaTask.scheduledFor ?? new Date().toISOString().slice(0, 10),
          sessionById: new Map(),
          showProjectBadge: true,
        }}
        selectedId={taskAreaTask.id}
        onOpen={() => {}}
        onDismiss={() => {}}
        density="tight"
      />
    </div>
  ),
};

export const StatusStates: Story = {
  render: () => (
    <div className="w-full max-w-xl">
      {(["todo", "doing", "done"] as const).map((status) => {
        const task = { ...taskAreaTask, id: status, status };
        return (
          <Item
            key={status}
            size="sm"
            variant="outline"
            className="items-start"
          >
            <ItemMedia variant="icon">
              <TaskStatusIcon status={status} />
            </ItemMedia>
            <ItemContent>
              <TaskRowBody
                task={task}
                meta={null}
                projectsById={
                  new Map(
                    taskAreaProjects.map((project) => [project.id, project]),
                  )
                }
                selected={status === "doing"}
              />
            </ItemContent>
          </Item>
        );
      })}
    </div>
  ),
};

/**
 * A Task waiting on two open Tasks: the glyph and count on a two-line row's
 * meta line, and the same pair a single-line row keeps beside its title.
 */
export const Blocked: Story = {
  render: () => {
    const projectsById = new Map(
      taskAreaProjects.map((project) => [project.id, project]),
    );
    const blocked = { ...taskAreaTask, openBlockerCount: 2 };
    const meta = buildTaskRowMeta(blocked, {
      today: new Date().toISOString().slice(0, 10),
      sessionById: new Map(),
      showProjectBadge: true,
    });
    return (
      <div className="flex w-full max-w-xl flex-col gap-2">
        {[meta, null].map((rowMeta, index) => (
          <Item key={index} size="sm" variant="outline" className="items-start">
            <ItemMedia variant="icon">
              <TaskStatusIcon status={blocked.status} />
            </ItemMedia>
            <ItemContent>
              <TaskRowBody
                task={blocked}
                meta={rowMeta}
                projectsById={projectsById}
                selected={false}
              />
            </ItemContent>
          </Item>
        ))}
      </div>
    );
  },
};
