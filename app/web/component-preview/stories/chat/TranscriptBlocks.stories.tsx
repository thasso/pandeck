import type { Meta, StoryObj } from "@storybook/react-vite";
import { ThinkingBlock } from "../../../src/components/ThinkingBlock.tsx";
import {
  ToolCallBlock,
  type ToolStatus,
} from "../../../src/components/common/ToolCallBlock.tsx";
import { CodeBlock } from "../../../src/components/common/CodeBlock.tsx";
function TranscriptBlocks({
  status,
  expanded,
}: {
  status: ToolStatus;
  expanded: boolean;
}) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <ThinkingBlock defaultOpen={expanded}>
        The composer field must stay mounted while it folds. Replacing it would
        make the first tap fail to raise the iOS keyboard.
      </ThinkingBlock>
      <ToolCallBlock
        name="bash"
        status={status}
        summary="pnpm exec vitest run Composer MessageList Markdown"
        lineCount={80}
        defaultOpen={expanded}
      >
        {() => (
          <CodeBlock
            code={Array.from(
              { length: 80 },
              (_, i) => `✓ chat-regression-${i + 1}.test.tsx (4 tests)`,
            ).join("\n")}
            language="text"
            collapsedLines={12}
            copyable
          />
        )}
      </ToolCallBlock>
    </div>
  );
}
const meta = {
  title: "App/Chat/Transcript blocks",
  component: TranscriptBlocks,
  args: { status: "success", expanded: false },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TranscriptBlocks>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Collapsed = {} satisfies Story;
export const Expanded = { args: { expanded: true } } satisfies Story;
export const Running = {
  args: { status: "running", expanded: true },
} satisfies Story;
export const Failed = {
  args: { status: "error", expanded: true },
} satisfies Story;
export const ResultUnavailable = {
  args: { status: "incomplete" },
} satisfies Story;
