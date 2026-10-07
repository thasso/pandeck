import type { Meta, StoryObj } from "@storybook/react-vite";
import { JsonView } from "../../../src/components/common/JsonView.tsx";
const meta = { title: "Common/JsonView", component: JsonView } satisfies Meta<
  typeof JsonView
>;
export default meta;
export const SessionPayload = {
  args: {
    defaultExpandedDepth: 2,
    value: {
      id: "session-84",
      title: "Investigate retry loop",
      status: "running",
      model: {
        provider: "anthropic",
        id: "claude-sonnet-4",
        thinking: "medium",
      },
      usage: { inputTokens: 18240, outputTokens: 921 },
      tools: ["read", "bash"],
    },
  },
} satisfies StoryObj<typeof meta>;
