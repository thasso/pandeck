import type { Meta, StoryObj } from "@storybook/react-vite";
import { LinkButton } from "../../../src/components/common/LinkButton.tsx";
const meta = {
  title: "Common/LinkButton",
  component: LinkButton,
} satisfies Meta<typeof LinkButton>;
export default meta;
export const OpenWorktree = {
  args: { href: "/worktrees/shadcn-ui-port", children: "Open worktree" },
} satisfies StoryObj<typeof meta>;
export const Secondary = {
  args: { href: "/tasks", variant: "outline", children: "Browse tasks" },
} satisfies StoryObj<typeof meta>;
