import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ApprovalCard as ApprovalCardData } from "@assistant/shared";
import { ApprovalCard } from "../../../src/components/ApprovalCard.tsx";

export interface GithubApprovalStoryProps {
  frameWidth: number;
}

const card = (
  id: string,
  rest: Omit<ApprovalCardData, "renderKind" | "id" | "sessionId" | "createdAt">,
): ApprovalCardData => ({
  renderKind: "approval",
  id,
  sessionId: "assistant-session",
  createdAt: Date.now() - 30_000,
  ...rest,
});

/** Every GitHub issue and branch card shape, pending and resolved. */
const cards: ApprovalCardData[] = [
  card("appr_issue_create", {
    kind: "githubIssue",
    status: "pending",
    title: "Create GitHub issue in acme/player",
    summary: "Seek bar jumps back after a DRM license renewal",
    body: {
      kind: "githubIssue",
      operation: "create",
      repo: "acme/player",
      title: "Seek bar jumps back after a DRM license renewal",
      issueBody:
        "After the license renews mid-playback the seek bar snaps to the segment start.\n\n**Steps**\n1. Play a Widevine stream with a 60s license\n2. Seek after renewal",
      labels: ["bug", "drm", "flaky"],
      assignees: ["alice"],
      newLabels: ["flaky"],
    },
  }),
  card("appr_issue_close", {
    kind: "githubIssue",
    status: "executed",
    title: "Edit acme/player#412",
    summary: "close (not planned) · unassign alice",
    resultSummary: "acme/player#412 — close (not planned); unassign alice",
    resultUrl: "https://github.com/acme/player/issues/412",
    body: {
      kind: "githubIssue",
      operation: "edit",
      repo: "acme/player",
      number: 412,
      state: "closed",
      stateReason: "not_planned",
      removeAssignees: ["alice"],
    },
  }),
  card("appr_issue_label", {
    kind: "githubIssue",
    status: "pending",
    title: "Change labels on acme/player#418",
    summary: "add label ready-for-review · remove label wip",
    body: {
      kind: "githubIssue",
      operation: "label",
      repo: "acme/player",
      number: 418,
      addLabels: ["ready-for-review"],
      removeLabels: ["wip"],
    },
  }),
  card("appr_branch_delete", {
    kind: "githubBranchDelete",
    status: "pending",
    title: "Delete 3 branches",
    summary: "acme/player · 1 open pull request(s) affected",
    body: {
      kind: "githubBranchDelete",
      repo: "acme/player",
      items: [
        { branch: "feat/old-seek-bar", headSha: "4be1c2d9aa01" },
        {
          branch: "spike/license-renewal",
          headSha: "91f0e33b7c12",
          openPullRequests: [
            {
              number: 405,
              title: "Spike: renew licenses ahead of expiry",
              url: "https://github.com/acme/player/pull/405",
              role: "head",
            },
          ],
        },
        { branch: "t88-drm-cleanup", headSha: "0c7d5e1f2a3b" },
      ],
    },
  }),
  card("appr_branch_partial", {
    kind: "githubBranchDelete",
    status: "executed",
    title: "Delete 2 branches",
    summary: "acme/player",
    resultSummary:
      "Deleted feat/old-seek-bar in acme/player; failed: t88-drm-cleanup moved to 5d1e0a9c3b7f since the proposal (0c7d5e1f2a3b); not deleted.",
    resultUrl: "https://github.com/acme/player/branches",
    body: {
      kind: "githubBranchDelete",
      repo: "acme/player",
      items: [
        {
          branch: "feat/old-seek-bar",
          headSha: "4be1c2d9aa01",
          deleted: true,
        },
        {
          branch: "t88-drm-cleanup",
          headSha: "0c7d5e1f2a3b",
          error:
            "t88-drm-cleanup moved to 5d1e0a9c3b7f since the proposal (0c7d5e1f2a3b); not deleted.",
        },
      ],
    },
  }),
];

export function GithubApprovalStory({ frameWidth }: GithubApprovalStoryProps) {
  return (
    <div className="bg-background p-4" style={{ width: frameWidth }}>
      {cards.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          onResolve={() => {}}
        />
      ))}
    </div>
  );
}

const meta = {
  excludeStories: /.*Story$/,
  id: "github-approval",
  title: "App/Cards/GitHub approvals",
  component: GithubApprovalStory,
  parameters: { layout: "fullscreen" },
  argTypes: {
    frameWidth: { control: { type: "range", min: 360, max: 960, step: 1 } },
  },
} satisfies Meta<typeof GithubApprovalStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllCards: Story = { args: { frameWidth: 720 } };
