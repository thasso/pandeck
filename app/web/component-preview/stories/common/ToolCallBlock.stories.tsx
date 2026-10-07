import type { Meta, StoryObj } from "@storybook/react-vite";
import { ToolCallBlock } from "../../../src/components/common/ToolCallBlock.tsx";
const meta = {
  title: "Common/ToolCallBlock",
  component: ToolCallBlock,
} satisfies Meta<typeof ToolCallBlock>;
export default meta;
export const Lifecycle = {
  args: { name: "bash", status: "running" },
  render: () => (
    <div className="flex max-w-3xl flex-col gap-3 p-6">
      <ToolCallBlock name="bash" status="running" summary="pnpm test" />
      <ToolCallBlock
        name="read"
        status="success"
        summary="app/web/src/App.tsx"
        durationSec={2}
        lineCount={18}
        defaultOpen
      >
        <pre className="font-mono text-xs">
          export function App() {"{"} return "Pandeck"; {"}"}
        </pre>
      </ToolCallBlock>
      <ToolCallBlock
        name="git push"
        status="error"
        summary="origin shadcn-ui-port"
        durationSec={4}
      >
        Permission denied
      </ToolCallBlock>
      <ToolCallBlock
        name="compact"
        status="incomplete"
        summary="history unavailable"
      />
    </div>
  ),
} satisfies StoryObj<typeof meta>;
export const Open = {
  args: {
    name: "read",
    status: "success",
    summary: "docs/ui-components.md",
    defaultOpen: true,
    lineCount: 42,
    children: "The Storybook catalog documents shared UI components.",
  },
} satisfies StoryObj<typeof meta>;
