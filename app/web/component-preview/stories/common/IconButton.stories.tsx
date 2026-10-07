import type { Meta, StoryObj } from "@storybook/react-vite";
import { Pencil, Trash2 } from "lucide-react";
import { IconButton } from "../../../src/components/common/IconButton.tsx";
const meta = {
  title: "Common/IconButton",
  component: IconButton,
} satisfies Meta<typeof IconButton>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Edit = {
  args: { label: "Edit task", children: <Pencil /> },
} satisfies Story;
export const Delete = {
  args: { label: "Delete worktree", children: <Trash2 />, size: "icon-sm" },
} satisfies Story;
