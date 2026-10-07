import type { Meta, StoryObj } from "@storybook/react-vite";
import type { TaskComment } from "@assistant/shared";
import { TaskComments } from "../../../src/components/TaskComments.tsx";
import { ready } from "../../../src/lib/loadState.ts";

const comments: TaskComment[] = [
  {
    id: "comment-user",
    taskId: "714",
    author: { kind: "user", name: "Alex" },
    body: "Please keep the keyboard flow unchanged.",
    createdAt: Date.now() - 3_600_000,
  },
  {
    id: "comment-agent",
    taskId: "714",
    author: { kind: "agent", name: "Reviewer", sessionId: "reviewer-session" },
    body: "The updated controls preserve the existing labels and callbacks.",
    createdAt: Date.now() - 1_800_000,
  },
];
const meta = {
  title: "App/Tasks/Comments",
  component: TaskComments,
  args: { state: ready(comments), onRetry: () => {}, onAddComment: () => {} },
  parameters: { layout: "padded" },
} satisfies Meta<typeof TaskComments>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Activity: Story = {};
export const Empty: Story = { args: { state: ready([]) } };
