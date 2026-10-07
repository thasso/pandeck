import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProjectDetailPage } from "../../../src/components/ProjectDetailPage.tsx";
import { ready } from "../../../src/lib/loadState.ts";
import { taskAreaProjects } from "../../fixtures/tasks.ts";

const project = taskAreaProjects[0]!;
const meta = {
  title: "Tasks/Project detail",
  component: ProjectDetailPage,
  args: {
    projects: taskAreaProjects,
    loaded: true,
    selectedId: project.id,
    detailState: ready(project),
    worktreeState: ready([]),
    onBackToList: () => {},
    onSave: () => {},
    onCloneRepo: () => {},
    onRemoveClone: () => {},
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ProjectDetailPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};
export const EmptyRegistry: Story = {
  args: { projects: [], selectedId: null },
};
