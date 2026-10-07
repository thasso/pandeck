import type { Meta, StoryObj } from "@storybook/react-vite";
import { CodeBlock } from "../../../src/components/common/CodeBlock.tsx";
const meta = { title: "Common/CodeBlock", component: CodeBlock } satisfies Meta<
  typeof CodeBlock
>;
export default meta;
export const Short = {
  args: {
    filename: "tasks.ts",
    code: 'export const project = "Pandeck";\nconsole.log(project);',
    showLineNumbers: true,
  },
} satisfies StoryObj<typeof meta>;
export const Long = {
  args: {
    filename: "session.log",
    code: Array.from(
      { length: 36 },
      (_, i) =>
        `[2025-02-14T10:${String(i).padStart(2, "0")}:00Z] session worker ${i % 2 ? "ready" : "waiting"}`,
    ).join("\n"),
    collapsedLines: 5,
    chunkLines: 8,
  },
} satisfies StoryObj<typeof meta>;
export const Copyable = {
  args: {
    language: "json",
    code: '{\n  "project": "pandeck",\n  "status": "running"\n}',
    copyable: true,
  },
} satisfies StoryObj<typeof meta>;
