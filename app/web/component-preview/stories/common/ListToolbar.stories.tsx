import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChevronDown, Layers, RefreshCw } from "lucide-react";
import { ListFilterPopover } from "../../../src/components/common/ListFilterPopover.tsx";
import { ListToolbar } from "../../../src/components/common/ListToolbar.tsx";
import { RefreshIndicator } from "../../../src/components/common/load.tsx";
import type { OverflowAction } from "../../../src/components/common/OverflowMenu.tsx";
import { PropertyLabel } from "../../../src/components/common/PropertyList.tsx";
import { Button } from "../../../src/components/ui/button.tsx";

const noop = () => {};

/**
 * A browser bar at the sidebar's width: a grouping switch leading, the filter
 * at the right edge, and the list's actions in the trailing `⋯`.
 */
export function ListToolbarStory({
  refreshing = false,
  withActions = true,
}: {
  refreshing?: boolean;
  withActions?: boolean;
}) {
  const actions: OverflowAction[] = [
    {
      key: "refresh",
      icon: <RefreshCw />,
      label: "Refresh",
      onRun: noop,
      busy: refreshing,
      hint: "5m ago",
    },
  ];
  return (
    <div className="w-80 bg-background">
      <ListToolbar
        actions={withActions ? actions : undefined}
        actionsLabel="More pull request actions"
        filter={
          <ListFilterPopover active={1} label="Filters">
            <PropertyLabel>Project</PropertyLabel>
            <span className="text-sm">Pandeck</span>
          </ListFilterPopover>
        }
      >
        <Button variant="ghost" size="sm" className="gap-1.5 font-medium">
          <Layers className="text-muted-foreground" />
          By reason
          <ChevronDown className="text-muted-foreground" />
        </Button>
        {refreshing ? (
          <RefreshIndicator label="Refreshing pull requests" />
        ) : null}
      </ListToolbar>
    </div>
  );
}

const meta = {
  excludeStories: /.*Story$/,
  title: "Common/ListToolbar",
  component: ListToolbarStory,
} satisfies Meta<typeof ListToolbarStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithActions: Story = {};
export const Refreshing: Story = { args: { refreshing: true } };
export const FilterOnly: Story = { args: { withActions: false } };
export const WithActionsDark: Story = { globals: { theme: "dark" } };
