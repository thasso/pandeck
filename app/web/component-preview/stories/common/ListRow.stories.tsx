import type { Meta, StoryObj } from "@storybook/react-vite";
import { Check, GitBranch, GitPullRequest, Settings } from "lucide-react";
import { ListRow } from "../../../src/components/common/ListRow.tsx";
import { Badge } from "../../../src/components/ui/badge.tsx";
import { IconButton } from "../../../src/components/common/IconButton.tsx";

const meta = {
  title: "Common/ListRow",
  component: ListRow,
  args: {
    title: "Unify browser list items",
    leading: <GitPullRequest />,
    density: "tight",
    onOpen: () => {},
  },
  render: (args) => (
    <div className="w-64 surface-sidebar">
      <ListRow {...args} />
    </div>
  ),
} satisfies Meta<typeof ListRow>;
export default meta;
type Story = StoryObj<typeof meta>;

export const OneLine: Story = {
  args: {
    title: "Appearance",
    leading: <Settings />,
    render: <button type="button" />,
  },
};

export const TwoLines: Story = {
  args: { signals: <span>Ready for review</span> },
};

export const ThreeLines: Story = {
  args: {
    context: (
      <>
        <span>Pandeck</span>
        <span className="flex min-w-0 flex-1 basis-0 items-center gap-1">
          <GitBranch size={11} />
          <span className="truncate">interactive-ui</span>
        </span>
      </>
    ),
    age: "5m",
    signals: <Badge variant="outline">Review requested</Badge>,
    trailing: (
      <IconButton label="Settle" size="icon-xs">
        <Check />
      </IconButton>
    ),
  },
};

export const Selected: Story = {
  args: { ...ThreeLines.args, active: true },
};

export const Comfortable: Story = {
  args: { ...ThreeLines.args, density: "comfortable" },
};

export const Dark: Story = {
  args: ThreeLines.args,
  globals: { theme: "dark" },
};
