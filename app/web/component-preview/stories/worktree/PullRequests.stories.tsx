import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { PullRequestInventoryItem } from "@assistant/shared";
import { PullRequestBrowser } from "../../../src/components/PullRequestBrowser.tsx";
import { PullRequestDetailPage } from "../../../src/components/pullRequest/PullRequestDetailPage.tsx";
import {
  pullRequestTargetOf,
  type PullRequestJoinSources,
  type PullRequestTarget,
} from "../../../src/lib/pullRequestInbox.ts";
import {
  failed,
  loading,
  ready,
  type LoadState,
} from "../../../src/lib/loadState.ts";
import {
  dirtyStatus,
  featureWorktree,
  NOW,
  pullRequest,
  pullRequestInventory,
  worktreeProject,
} from "../../fixtures/worktree.ts";

type BrowserState = "populated" | "loading" | "empty" | "error";
type DetailState = "open" | "merged" | "loading" | "joins-loading";

export interface PullRequestStoryProps {
  frameWidth: number;
  surface: "browser" | "detail";
  browserState: BrowserState;
  detailState: DetailState;
}

function inventoryState(
  state: BrowserState,
): LoadState<PullRequestInventoryItem[]> {
  switch (state) {
    case "populated":
      return ready(pullRequestInventory);
    case "loading":
      return loading();
    case "empty":
      return ready([]);
    case "error":
      return failed("The pull request inventory could not be read (502).");
  }
}

const freshJoins: PullRequestJoinSources = {
  worktrees: { rows: [featureWorktree], fresh: true },
  sessions: {
    rows: [
      {
        id: "s-impl",
        harness: "pi",
        agentType: "developer",
        title: "Implement retry backoff",
        createdAt: NOW - 5 * 3_600_000,
        updatedAt: NOW - 120_000,
        messageCount: 42,
        isStreaming: true,
      },
      {
        id: "s-review",
        harness: "pi",
        agentType: "developer",
        title: "Review the retry change",
        createdAt: NOW - 3_600_000,
        updatedAt: NOW - 600_000,
        messageCount: 12,
      },
    ],
    fresh: true,
  },
  tasks: {
    rows: [
      {
        id: "812",
        title: "Back off between provider retries",
        status: "doing",
        projectId: "pandeck",
        sessionRefs: [{ sessionId: "s-impl" }],
        source: { createdBy: "user" },
        createdAt: NOW - 86_400_000,
        updatedAt: NOW - 600_000,
      },
    ],
    fresh: true,
  },
};

const coldJoins: PullRequestJoinSources = {
  worktrees: { rows: null, fresh: false },
  sessions: { rows: null, fresh: false },
  tasks: { rows: null, fresh: false },
};

/**
 * The Pull Requests section: the sidebar browser over the inventory, and the
 * detail page one row opens, each in its load states.
 */
export function PullRequestStory({
  frameWidth,
  surface,
  browserState,
  detailState,
}: PullRequestStoryProps) {
  const [selected, setSelected] = useState<PullRequestTarget | null>(null);
  const item =
    detailState === "merged"
      ? pullRequest({ state: "merged", mergeable: undefined })
      : pullRequest();
  return (
    <div className="h-screen bg-background p-2">
      <div className="h-full" style={{ width: frameWidth }}>
        {surface === "browser" ? (
          <PullRequestBrowser
            inventory={inventoryState(browserState)}
            onReload={() => {}}
            projects={[worktreeProject]}
            selected={selected}
            onOpen={setSelected}
            density="comfortable"
          />
        ) : (
          <PullRequestDetailPage
            target={pullRequestTargetOf(item)}
            state={detailState === "loading" ? loading() : ready(item)}
            onReload={() => {}}
            projects={[worktreeProject]}
            joins={detailState === "joins-loading" ? coldJoins : freshJoins}
            status={dirtyStatus}
            onOpenWorktree={() => {}}
            onOpenSession={() => {}}
            onOpenTask={() => {}}
          />
        )}
      </div>
    </div>
  );
}

const meta = {
  excludeStories: /.*Story$/,
  id: "pull-requests",
  title: "App/Worktree/Pull requests",
  component: PullRequestStory,
  parameters: { layout: "fullscreen" },
  args: {
    frameWidth: 320,
    surface: "browser",
    browserState: "populated",
    detailState: "open",
  },
  argTypes: {
    frameWidth: { control: { type: "range", min: 240, max: 1024, step: 1 } },
    surface: { control: "inline-radio", options: ["browser", "detail"] },
    browserState: {
      control: "inline-radio",
      options: ["populated", "loading", "empty", "error"],
    },
    detailState: {
      control: "inline-radio",
      options: ["open", "merged", "loading", "joins-loading"],
    },
  },
} satisfies Meta<typeof PullRequestStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Browser: Story = {};
export const BrowserDark: Story = { globals: { theme: "dark" } };
export const BrowserLoading: Story = { args: { browserState: "loading" } };
export const BrowserEmpty: Story = { args: { browserState: "empty" } };
export const BrowserError: Story = { args: { browserState: "error" } };
export const Detail: Story = {
  args: { surface: "detail", frameWidth: 760 },
};
export const DetailDark: Story = {
  args: { surface: "detail", frameWidth: 760 },
  globals: { theme: "dark" },
};
export const DetailMerged: Story = {
  args: { surface: "detail", frameWidth: 760, detailState: "merged" },
};
export const DetailJoinsLoading: Story = {
  args: { surface: "detail", frameWidth: 760, detailState: "joins-loading" },
};
export const DetailLoading: Story = {
  args: { surface: "detail", frameWidth: 760, detailState: "loading" },
};
