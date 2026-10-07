import type { Meta, StoryObj } from "@storybook/react-vite";
import { ResizableSeparator } from "../../../src/components/common/ResizableSeparator.tsx";
const meta = {
  title: "Common/ResizableSeparator",
  component: ResizableSeparator,
} satisfies Meta<typeof ResizableSeparator>;
export default meta;
export const SidebarDivider = {
  args: {
    label: "session sidebar",
    min: 220,
    max: 480,
    value: 304,
    resizing: false,
    onPointerDown: () => {},
    className: "!static h-32",
  },
} satisfies StoryObj<typeof meta>;
