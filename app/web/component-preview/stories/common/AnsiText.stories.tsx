import type { Meta, StoryObj } from "@storybook/react-vite";
import { AnsiText } from "../../../src/components/common/AnsiText.tsx";
const meta = { title: "Common/AnsiText", component: AnsiText } satisfies Meta<
  typeof AnsiText
>;
export default meta;
export const BuildLog = {
  args: {
    text: "\u001b[32m✓\u001b[0m Typecheck passed\n\u001b[33m⚠\u001b[0m 2 optional snapshots skipped\n\u001b[1;31m✗ Deploy failed\u001b[0m",
  },
} satisfies StoryObj<typeof meta>;
