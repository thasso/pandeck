import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Item,
  ItemContent,
  ItemMedia,
} from "../../../src/components/ui/item.tsx";
import { TaskRowBody } from "../../../src/components/TaskRowBody.tsx";
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
 * A Task waiting on open Tasks: the "Blocked" chip on a two-line row's meta
 * line, and the glyph a single-line row keeps beside its title. The count is
 * the tooltip.
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
