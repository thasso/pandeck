import type { Meta, StoryObj } from "@storybook/react-vite";
import { Archive, Trash2 } from "lucide-react";
import { SwipeRow } from "../../../src/components/common/SwipeRow.tsx";
const meta = { title: "Common/SwipeRow", component: SwipeRow } satisfies Meta<
  typeof SwipeRow
>;
export default meta;
export const TaskActions = {
  args: {
    left: { label: "Archive", icon: <Archive />, run: () => true },
    right: {
      label: "Delete",
      icon: <Trash2 />,
      tone: "danger",
      run: () => true,
    },
    children: (
      <div className="rounded-md border bg-card p-4">
        <p className="font-medium">Review token usage report</p>
        <p className="text-sm text-muted-foreground">Task-361 · Pandeck</p>
      </div>
    ),
  },
} satisfies StoryObj<typeof meta>;
