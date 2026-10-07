import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChartBlock } from "../../../src/components/common/ChartBlock.tsx";
const meta = {
  title: "Common/ChartBlock",
  component: ChartBlock,
} satisfies Meta<typeof ChartBlock>;
export default meta;
export const SessionActivity = {
  args: {
    spec: JSON.stringify({
      type: "bar",
      title: "Sessions by day",
      labels: ["Mon", "Tue", "Wed", "Thu", "Fri"],
      series: [{ label: "Sessions", data: [4, 7, 5, 9, 6] }],
      yLabel: "Sessions",
    }),
  },
} satisfies StoryObj<typeof meta>;
