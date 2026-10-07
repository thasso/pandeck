import type { Meta, StoryObj } from "@storybook/react-vite";
import { TaskPlanningSection } from "../../../src/components/TaskPlanningSection.tsx";
import { taskAreaTask } from "../../fixtures/tasks.ts";

const meta = {
  title: "App/Tasks/Planning section",
  component: TaskPlanningSection,
  args: { task: taskAreaTask, onPatch: () => {} },
  parameters: { layout: "padded" },
} satisfies Meta<typeof TaskPlanningSection>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Scheduled: Story = {};
const {
  scheduledFor: _scheduledFor,
  dueDate: _dueDate,
  ...unscheduledTask
} = taskAreaTask;
export const Unscheduled: Story = {
  args: { task: { ...unscheduledTask, priority: "normal" } },
};
