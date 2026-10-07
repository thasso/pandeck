import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  CopyButton,
  InlineCopyButton,
} from "../../../src/components/common/CopyButton.tsx";
function CopyButtonsStory() {
  return (
    <div className="flex max-w-xl flex-col gap-5 p-6">
      <div className="flex items-center justify-between rounded-md border p-3">
        <code className="text-sm">pnpm --filter @assistant/web test</code>
        <CopyButton
          value="pnpm --filter @assistant/web test"
          label="Copy command"
        />
      </div>
      <p className="text-sm">
        Clone with <code>git clone https://example.test/pandeck.git</code>{" "}
        <InlineCopyButton
          value="git clone https://example.test/pandeck.git"
          label="Copy clone command"
        />
      </p>
    </div>
  );
}
const meta = {
  title: "Common/CopyButton",
  component: CopyButton,
  excludeStories: /.*Story$/,
} satisfies Meta<typeof CopyButton>;
export default meta;
export const CopyControls = {
  args: { value: "pnpm test" },
  render: () => <CopyButtonsStory />,
} satisfies StoryObj<typeof meta>;
