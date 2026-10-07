import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProjectLocalPathsSection } from "../../../src/components/ProjectLocalPaths.tsx";
import { taskAreaProjects } from "../../fixtures/tasks.ts";

const meta = {
  title: "Tasks/Project local paths",
  component: ProjectLocalPathsSection,
  args: { project: taskAreaProjects[0]!, onSave: () => {} },
  parameters: { layout: "padded" },
} satisfies Meta<typeof ProjectLocalPathsSection>;
export default meta;
type Story = StoryObj<typeof meta>;
export const MappedFolders: Story = {};
export const NoExtraFolders: Story = {
  args: { project: { ...taskAreaProjects[0]!, localPaths: [] } },
};
