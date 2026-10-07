import type { Meta, StoryObj } from "@storybook/react-vite";
import { CommentComposer } from "../../../src/components/common/CommentComposer.tsx";
const meta = {
  title: "Common/CommentComposer",
  component: CommentComposer,
} satisfies Meta<typeof CommentComposer>;
export default meta;
export const Inline = {
  args: {
    onSubmit: () => {},
    placeholder: "Write a task update…",
    ariaLabel: "Add task comment",
    submitLabel: "Comment",
    layout: "row",
  },
} satisfies StoryObj<typeof meta>;
export const Card = {
  args: {
    onSubmit: () => {},
    placeholder: "Share progress with the team…",
    header: "Add a comment",
    layout: "card",
    value: "Storybook coverage is underway.",
  },
} satisfies StoryObj<typeof meta>;
