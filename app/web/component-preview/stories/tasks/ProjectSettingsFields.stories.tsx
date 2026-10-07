import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProjectSettingsFields } from "../../../src/components/ProjectSettingsFields.tsx";
import { taskAreaProjects } from "../../fixtures/tasks.ts";

const meta = {
  title: "App/Tasks/Project settings fields",
  component: ProjectSettingsFields,
  args: { project: taskAreaProjects[0]!, onSave: () => {} },
  parameters: { layout: "padded" },
} satisfies Meta<typeof ProjectSettingsFields>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Settings: Story = {};
