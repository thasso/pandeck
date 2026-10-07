import type { Meta, StoryObj } from "@storybook/react-vite";
import { CommentBody } from "../../../src/components/common/CommentBody.tsx";
const meta = {
  title: "Common/CommentBody",
  component: CommentBody,
} satisfies Meta<typeof CommentBody>;
export default meta;
export const TaskUpdate = {
  args: {
    body: "The retry path is fixed. I added coverage for **offline sessions** and linked the [implementation notes](https://example.test/docs/retries).",
  },
} satisfies StoryObj<typeof meta>;
