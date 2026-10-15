import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  IdleWorktree,
  ProjectRecord,
  PullRequestConversationResponse,
  PullRequestInventoryItem,
} from "@assistant/shared";
import { PullRequestBrowser } from "../../../src/components/PullRequestBrowser.tsx";
import { PullRequestActionsProvider } from "../../../src/components/pullRequest/PullRequestActions.tsx";
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
  pullRequestInventory,
  worktreeProject,
} from "../../fixtures/worktree.ts";
import {
  pandeck120,
  pandeck120Conversation,
  pandeck121,
  pandeck121Conversation,
  reviewConversation,
  reviewRequestedItem,
} from "../../fixtures/pullRequests.ts";

/**
 * Real data from other repositories, present only on the machine that pulled
 * it (`fixtures/local/` is git-ignored). Absent, the "real" cases fall back to
 * the committed fixtures, so the catalog builds anywhere.
 */
const local = import.meta.glob<unknown>("../../fixtures/local/*.json", {
  eager: true,
  import: "default",
});
const localInventory = local["../../fixtures/local/inventory.json"] as
  { items: PullRequestInventoryItem[]; projects: ProjectRecord[] } | undefined;
const localDetails = local["../../fixtures/local/details.json"] as
  | Array<{
      item: PullRequestInventoryItem;
      conversation: PullRequestConversationResponse;
    }>
  | undefined;

type BrowserState = "populated" | "real" | "loading" | "empty" | "error";

/**
 * The cleanup queue's worktree half under the populated browser: what an idle
 * checkout holds decides whether the bulk act may take it.
 */
function idleWorktrees(): IdleWorktree[] {
  const day = 86_400_000;
  const at = (id: string, branch: string) => ({
    ...featureWorktree,
    id,
    branch,
    path: `/work/${branch}`,
    sessionIds: [],
    treeSessionIds: ["pd-coordinator"],
  });
  return [
    {
      worktree: {
        ...at("pd-idle-merged", "pd-row-density"),
        pullRequest: { status: "merged", number: 312 },
      },
      kind: "delivered",
      lastActivityAt: NOW - 9 * day,
    },
    {
      worktree: at("pd-idle-spike", "pd-cache-spike"),
      kind: "unmerged",
      ahead: 3,
      pushed: false,
      lastActivityAt: NOW - 4 * day,
    },
  ];
}

type DetailState =
  | "open"
  | "review"
  | "merged"
  | "real"
  | "loading"
  | "joins-loading"
  | "conversation-loading"
  | "conversation-error";

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
    case "real":
      return ready(localInventory?.items ?? pullRequestInventory);
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
        title: "Record interrupted peer turns",
        createdAt: NOW - 5 * 3_600_000,
        updatedAt: NOW - 120_000,
        messageCount: 42,
        isStreaming: true,
      },
      {
        id: "s-review",
        harness: "pi",
        agentType: "developer",
        title: "Review the peer turn change",
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

function detailCase(state: DetailState): {
  item: PullRequestInventoryItem;
  conversation: LoadState<PullRequestConversationResponse>;
} {
  switch (state) {
    case "review":
      return {
        item: reviewRequestedItem,
        conversation: ready(reviewConversation),
      };
    case "merged":
      return { item: pandeck121, conversation: ready(pandeck121Conversation) };
    case "real": {
      const real = localDetails?.[0];
      return real
        ? { item: real.item, conversation: ready(real.conversation) }
        : {
            item: reviewRequestedItem,
            conversation: ready(reviewConversation),
          };
    }
    case "conversation-loading":
      return { item: pandeck120, conversation: loading() };
    case "conversation-error":
      return {
        item: pandeck120,
        conversation: failed("GitHub answered 502 Bad Gateway."),
      };
    default:
      return { item: pandeck120, conversation: ready(pandeck120Conversation) };
  }
}

/**
 * The Pull Requests section: the sidebar browser over the inventory, and the
 * detail page one row opens, each in its load states. The detail page sits
 * under the real `PullRequestActionsProvider`, so its inline buttons are the
 * ones the app renders; nothing here reaches a server until one is clicked.
 */
export function PullRequestStory({
  frameWidth,
  surface,
  browserState,
  detailState,
}: PullRequestStoryProps) {
  const [selected, setSelected] = useState<PullRequestTarget | null>(null);
  const { item, conversation } = detailCase(detailState);
  const projects =
    browserState === "real" && localInventory
      ? localInventory.projects
      : [worktreeProject];
  return (
    <div className="h-screen bg-background p-2">
      <div className="h-full" style={{ width: frameWidth }}>
        {surface === "browser" ? (
          <PullRequestBrowser
            inventory={inventoryState(browserState)}
            onReload={() => {}}
            projects={projects}
            selected={selected}
            onOpen={setSelected}
            density="comfortable"
            idle={
              browserState === "populated"
                ? {
                    state: ready(idleWorktrees()),
                    fetchedAt: NOW,
                    onReload: () => {},
                    onOpenWorktree: () => {},
                    onRetired: () => {},
                  }
                : undefined
            }
          />
        ) : (
          <PullRequestActionsProvider
            item={item}
            onReload={() => {}}
            onStartSession={() => {}}
            onReview={() => {}}
          >
            <PullRequestDetailPage
              target={pullRequestTargetOf(item)}
              state={detailState === "loading" ? loading() : ready(item)}
              onReload={() => {}}
              projects={[worktreeProject]}
              joins={detailState === "joins-loading" ? coldJoins : freshJoins}
              status={dirtyStatus}
              conversation={conversation}
              onReloadConversation={() => {}}
              onOpenWorktree={() => {}}
              onOpenSession={() => {}}
              onOpenTask={() => {}}
            />
          </PullRequestActionsProvider>
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
      options: ["populated", "real", "loading", "empty", "error"],
    },
    detailState: {
      control: "inline-radio",
      options: [
        "open",
        "review",
        "merged",
        "real",
        "loading",
        "joins-loading",
        "conversation-loading",
        "conversation-error",
      ],
    },
  },
} satisfies Meta<typeof PullRequestStory>;

export default meta;
type Story = StoryObj<typeof meta>;

const phone = {
  globals: { viewport: { value: "paPhone", isRotated: false } },
} as const;

export const Browser: Story = {};
export const BrowserDark: Story = { globals: { theme: "dark" } };
export const BrowserReal: Story = { args: { browserState: "real" } };
export const BrowserPhone: Story = {
  args: { frameWidth: 390, browserState: "real" },
  ...phone,
};
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
export const DetailReview: Story = {
  args: { surface: "detail", frameWidth: 760, detailState: "review" },
};
export const DetailMerged: Story = {
  args: { surface: "detail", frameWidth: 760, detailState: "merged" },
};
export const DetailReal: Story = {
  args: { surface: "detail", frameWidth: 760, detailState: "real" },
};
export const DetailPhone: Story = {
  args: { surface: "detail", frameWidth: 390, detailState: "review" },
  ...phone,
};
export const DetailMergedPhone: Story = {
  args: { surface: "detail", frameWidth: 390, detailState: "merged" },
  ...phone,
};
export const DetailJoinsLoading: Story = {
  args: { surface: "detail", frameWidth: 760, detailState: "joins-loading" },
};
export const DetailConversationLoading: Story = {
  args: {
    surface: "detail",
    frameWidth: 760,
    detailState: "conversation-loading",
  },
};
export const DetailConversationError: Story = {
  args: {
    surface: "detail",
    frameWidth: 760,
    detailState: "conversation-error",
  },
};
export const DetailLoading: Story = {
  args: { surface: "detail", frameWidth: 760, detailState: "loading" },
};
