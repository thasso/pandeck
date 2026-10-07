import type { Meta, StoryObj } from "@storybook/react-vite";
import { CommentThread } from "../../../src/components/diff/comments.tsx";
import { ReviewCommentList } from "../../../src/components/review/ReviewCommentList.tsx";
import { SendCommentsSheet } from "../../../src/components/review/SendCommentsSheet.tsx";
import { worktreeReviewThreads } from "../../../src/components/worktree/worktreeReview.tsx";
import { ChatCommentChip } from "../../../src/components/ChatCommentChip.tsx";
import type { PendingChatComment } from "../../../src/lib/chatCommentPrompt.ts";
import { reviewComments } from "../../fixtures/worktree.ts";

export interface ReviewCommentsStoryProps {
  frameWidth: number;
  surface: "page-list" | "panel-list" | "empty" | "send" | "chat-chip";
}

const COMMENT_ACTIONS = {
  onAddComment: () => {},
  onResolveComment: () => {},
  onDeleteComment: () => {},
};

const threads = worktreeReviewThreads(reviewComments, () => {});

/** A thread as the page list expands it: the same card the diff line shows. */
function renderThread(threadId: string) {
  const root = reviewComments.find((comment) => comment.id === threadId)!;
  return (
    <CommentThread
      root={root}
      replies={reviewComments.filter(
        (comment) => comment.parentId === threadId,
      )}
      actions={COMMENT_ACTIONS}
    />
  );
}

/** Document comments waiting in a tray, as the browser stores them. */
const chatComments: PendingChatComment[] = [
  {
    id: "p1",
    anchor: {
      kind: "document",
      document: { kind: "hostFile", path: "/work/pandeck/docs/retries.md" },
    },
    quote: "retry three times with a fixed delay",
    lines: { start: 3, end: 3 },
    body: "This sentence promises a retry the code no longer makes.",
    createdAt: "2026-10-07T11:40:00.000Z",
  },
  {
    id: "p2",
    anchor: {
      kind: "document",
      document: { kind: "knowledgeFile", path: "projects/pandeck/retries.md" },
    },
    body: "Link the table to the provider docs instead of restating it — it will drift the next time the policy changes.",
    createdAt: "2026-10-07T11:52:00.000Z",
  },
];

/**
 * Review comments in each place they are triaged: the page list (expands to
 * the thread), the panel list (rows are links), the submit sheet, and the
 * pending-comments chip that rides with a chat prompt.
 */
export function ReviewCommentsStory({
  frameWidth,
  surface,
}: ReviewCommentsStoryProps) {
  return (
    <div className="min-h-screen bg-background p-4">
      <div style={{ width: frameWidth }}>
        {surface === "page-list" ? (
          <ReviewCommentList
            threads={threads}
            renderThread={renderThread}
            onSend={() => {}}
          />
        ) : surface === "panel-list" ? (
          <ReviewCommentList threads={threads} onOpen={() => {}} />
        ) : surface === "empty" ? (
          <ReviewCommentList threads={[]} onOpen={() => {}} />
        ) : surface === "chat-chip" ? (
          <ChatCommentChip
            comments={chatComments}
            activeCommentId="p2"
            onSelect={() => {}}
            onRemove={() => {}}
            onClear={() => {}}
            onReveal={() => {}}
            labelSources
          />
        ) : (
          <SendCommentsSheet
            count={2}
            sessions={[
              { id: "s-impl", title: "Implement retry backoff", linked: true },
              { id: "s-review", title: "Review the retry change" },
            ]}
            newLabel="New session in this worktree"
            newDetail="Continue on the new-session page to pick the model and edit the prompt"
            newSubmitLabel="Continue to session draft"
            startWithout={{
              label: "Start session with this worktree",
              onRun: () => {},
            }}
            onClose={() => {}}
            onSend={() => {}}
          />
        )}
      </div>
    </div>
  );
}

const meta = {
  excludeStories: /.*Story$/,
  id: "review-comments",
  title: "App/Worktree/Review comments",
  component: ReviewCommentsStory,
  parameters: { layout: "fullscreen" },
  args: { frameWidth: 360, surface: "page-list" },
  argTypes: {
    frameWidth: { control: { type: "range", min: 280, max: 720, step: 1 } },
    surface: {
      control: "inline-radio",
      options: ["page-list", "panel-list", "empty", "send", "chat-chip"],
    },
  },
} satisfies Meta<typeof ReviewCommentsStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PageList: Story = {};
export const PageListDark: Story = { globals: { theme: "dark" } };
export const PanelList: Story = { args: { surface: "panel-list" } };
export const Empty: Story = { args: { surface: "empty" } };
export const SubmitReview: Story = { args: { surface: "send" } };
export const SubmitReviewDark: Story = {
  args: { surface: "send" },
  globals: { theme: "dark" },
};
export const PendingChatComments: Story = { args: { surface: "chat-chip" } };
