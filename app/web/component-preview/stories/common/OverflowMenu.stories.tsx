import type { Meta, StoryObj } from "@storybook/react-vite";
import { GitMerge, Pause, RefreshCw } from "lucide-react";
import { OverflowMenu } from "../../../src/components/common/OverflowMenu.tsx";
import { Button } from "../../../src/components/ui/button.tsx";
import { DropdownMenuItem } from "../../../src/components/ui/dropdown-menu.tsx";

/** The overflow as it sits in a card footer: last, after the visible buttons. */
export function OverflowMenuStory() {
  return (
    <div className="flex items-center justify-end gap-1 bg-background p-8">
      <Button size="xs" variant="outline">
        <GitMerge />
        Merge
      </Button>
      <OverflowMenu label="More pull request actions" size="icon-xs">
        <DropdownMenuItem>
          <RefreshCw />
          Update with main
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Pause />
          Pause
        </DropdownMenuItem>
      </OverflowMenu>
    </div>
  );
}

const meta = {
  excludeStories: /.*Story$/,
  title: "Common/OverflowMenu",
  component: OverflowMenuStory,
} satisfies Meta<typeof OverflowMenuStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CardFooter: Story = {};
export const CardFooterDark: Story = { globals: { theme: "dark" } };
