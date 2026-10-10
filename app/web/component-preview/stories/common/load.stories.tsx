import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "../../../src/components/ui/button.tsx";
import {
  EmptyBox,
  ErrorNote,
  PaneLoading,
  RefreshIndicator,
  Skeleton,
  Spinner,
} from "../../../src/components/common/load.tsx";
function LoadStory() {
  return (
    <div className="flex max-w-xl flex-col gap-6 p-6">
      <section className="flex items-center gap-4">
        {(["xs", "sm", "md", "lg"] as const).map((size) => (
          <div key={size} className="flex items-center gap-2">
            <Spinner size={size} />
            <span className="text-xs">{size}</span>
          </div>
        ))}
        <Spinner variant="ring" size="lg" />
      </section>
      <PaneLoading label="Loading Task-361…" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-16 w-full" />
      </div>
      <p className="flex items-center gap-2 text-sm">
        Refreshing session list <RefreshIndicator />
      </p>
      <EmptyBox>
        Nothing in this project yet.<Button size="sm">Create a task</Button>
      </EmptyBox>
      <EmptyBox variant="inline">No review comments on this worktree.</EmptyBox>
      <EmptyBox variant="item">No recent worktrees</EmptyBox>
      <ErrorNote message="Could not load review comments." />
      <ErrorNote message="Could not refresh sessions." onRetry={() => {}} />
    </div>
  );
}
const meta = {
  title: "Common/load",
  component: LoadStory,
  excludeStories: /.*Story$/,
} satisfies Meta<typeof LoadStory>;
export default meta;
export const States = {} satisfies StoryObj<typeof meta>;
