import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  ApprovalCard as ApprovalCardData,
  ApprovalGrant,
} from "@assistant/shared";
import { ApprovalCard } from "../../../src/components/ApprovalCard.tsx";

export interface ApprovalSessionGrantStoryProps {
  frameWidth: number;
}

const comment: ApprovalCardData = {
  renderKind: "approval",
  id: "appr-comment-1",
  sessionId: "session-1",
  kind: "githubPullRequest",
  status: "pending",
  title: "Comment on pull request",
  summary: "acme/player#412",
  createdAt: Date.now() - 5 * 60_000,
  body: {
    kind: "githubPullRequest",
    operation: "comment",
    repo: "acme/player",
    pullNumber: 412,
    commentBody:
      "The retry now backs off exponentially; ready for another look.",
  },
};

const grants: ApprovalGrant[] = [
  {
    key: "github:comment",
    grantedAt: Date.now() - 4 * 60_000,
    sourceApprovalId: "appr-comment-granted",
  },
];

/**
 * One session's lifecycle, top to bottom: the card offering "Approve for
 * session", the same card after it granted its operation, a later card the
 * grant covers while the turn is still running, and that card once it ran.
 */
const cards: ApprovalCardData[] = [
  comment,
  {
    ...comment,
    id: "appr-comment-granted",
    status: "executed",
    decision: "approved",
    grantedForSession: true,
    resolvedAt: Date.now() - 4 * 60_000,
    resultSummary: "Commented on #412",
    resultUrl: "https://github.com/acme/player/pull/412",
  },
  {
    ...comment,
    id: "appr-comment-2",
    summary: "acme/player#415",
    autoApproved: true,
    body: { ...comment.body, pullNumber: 415 } as ApprovalCardData["body"],
  },
  {
    ...comment,
    id: "appr-comment-3",
    summary: "acme/player#415",
    status: "executed",
    decision: "approved",
    autoApproved: true,
    resultSummary: "Commented on #415",
    resultUrl: "https://github.com/acme/player/pull/415",
    body: { ...comment.body, pullNumber: 415 } as ApprovalCardData["body"],
  },
];

export function ApprovalSessionGrantStory({
  frameWidth,
}: ApprovalSessionGrantStoryProps) {
  return (
    <div className="bg-background p-4" style={{ width: frameWidth }}>
      {cards.map((card, index) => (
        <ApprovalCard
          key={index}
          approval={card}
          grants={grants}
          onResolve={() => {}}
          onRevokeGrant={() => {}}
        />
      ))}
    </div>
  );
}

const meta = {
  excludeStories: /.*Story$/,
  id: "approval-session-grant",
  title: "Cards/Approve for session",
  component: ApprovalSessionGrantStory,
  parameters: { layout: "fullscreen" },
  argTypes: {
    frameWidth: { control: { type: "range", min: 360, max: 960, step: 1 } },
  },
} satisfies Meta<typeof ApprovalSessionGrantStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Lifecycle: Story = {
  args: { frameWidth: 720 },
};
