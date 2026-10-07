import type { Meta, StoryObj } from "@storybook/react-vite";
import { TaskContextSections } from "../../../src/components/TaskContextSections.tsx";
import { taskAreaProjects, taskAreaTask } from "../../fixtures/tasks.ts";

const meta = {
  title: "Tasks/Context sections",
  component: TaskContextSections,
  args: {
    task: taskAreaTask,
    projects: taskAreaProjects,
    projectsById: new Map(
      taskAreaProjects.map((project) => [project.id, project]),
    ),
    onPatch: () => {},
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof TaskContextSections>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};
