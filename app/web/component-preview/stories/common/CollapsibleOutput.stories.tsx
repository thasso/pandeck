import type { Meta, StoryObj } from "@storybook/react-vite";
import { CollapsibleOutput } from "../../../src/components/common/CollapsibleOutput.tsx";
const meta = {
  title: "Common/CollapsibleOutput",
  component: CollapsibleOutput,
} satisfies Meta<typeof CollapsibleOutput>;
export default meta;
export const LongCommandOutput = {
  args: {
    text: Array.from(
      { length: 28 },
      (_, i) =>
        `Check ${i + 1}: ${i === 27 ? "all tests passed" : "completed"}`,
    ).join("\n"),
    collapsedLines: 6,
    chunkLines: 7,
  },
} satisfies StoryObj<typeof meta>;
