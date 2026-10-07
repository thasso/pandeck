import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  CommitWorktreeDialog,
  CreatePullRequestDialog,
  CreateWorktreeDialog,
  MergePullRequestDialog,
  MergeWorktreeDialog,
  RemoveWorktreeDialog,
} from "../../../src/components/worktree/WorktreeDialogs.tsx";
import { PullRequestMergeDialog } from "../../../src/components/pullRequest/PullRequestMergeDialog.tsx";
import {
  dirtyStatus,
  featureWorktree,
  pullRequest,
  worktreeStatus,
} from "../../fixtures/worktree.ts";

type DialogCase =
  | "create"
  | "commit"
  | "commit-error"
  | "create-pr"
  | "merge-pr"
  | "merge-local"
  | "merge-conflicts"
  | "retire"
  | "remove-dirty"
  | "pr-merge-cleanup"
  | "pr-merge-refused";

export interface WorktreeDialogStoryProps {
  dialog: DialogCase;
}

const noop = () => {};

/** Each worktree and pull-request confirmation, open, with wire-level state. */
export function WorktreeDialogStory({ dialog }: WorktreeDialogStoryProps) {
  switch (dialog) {
    case "create":
      return (
        <CreateWorktreeDialog
          projectName="Pandeck"
          proposal="retry-backoff"
          onPropose={noop}
          onCreate={noop}
          onClose={noop}
        />
      );
    case "commit":
    case "commit-error":
      return (
        <CommitWorktreeDialog
          status={dirtyStatus}
          busy={false}
          error={
            dialog === "commit-error"
              ? "Author identity unknown: set user.email in this checkout."
              : null
          }
          onCommit={noop}
          onClose={noop}
        />
      );
    case "create-pr":
      return (
        <CreatePullRequestDialog
          worktree={featureWorktree}
          busy={false}
          error={null}
          onCreate={noop}
          onClose={noop}
        />
      );
    case "merge-pr":
      return (
        <MergePullRequestDialog
          worktree={featureWorktree}
          prNumber={418}
          supportedMethods={["squash", "merge", "rebase"]}
          defaultMethod="squash"
          busy={false}
          error={null}
          onMerge={noop}
          onClose={noop}
        />
      );
    case "merge-local":
      return (
        <MergeWorktreeDialog
          worktree={featureWorktree}
          status={dirtyStatus}
          defaultStrategy="squash"
          onMerge={noop}
          onOpenSession={noop}
          onClose={noop}
        />
      );
    case "merge-conflicts":
      return (
        <MergeWorktreeDialog
          worktree={featureWorktree}
          status={worktreeStatus()}
          defaultStrategy="squash"
          merge={{
            phase: "agent_resolving",
            message: "Two files conflict with main.",
            conflictPaths: ["src/lib/retry.ts", "docs/retries.md"],
            agentSessionId: "s-merge",
          }}
          onMerge={noop}
          onOpenSession={noop}
          onClose={noop}
        />
      );
    case "retire":
      return (
        <RemoveWorktreeDialog
          worktree={featureWorktree}
          status={worktreeStatus({ merged: true, ahead: 0 })}
          retire={{
            sessionCount: 2,
            merged: false,
            refusal:
              "retry-backoff is not contained in origin/main at 8f3e2a1.",
          }}
          onRemove={noop}
          onClose={noop}
        />
      );
    case "remove-dirty":
      return (
        <RemoveWorktreeDialog
          worktree={featureWorktree}
          status={dirtyStatus}
          onRemove={noop}
          onClose={noop}
        />
      );
    case "pr-merge-cleanup":
    case "pr-merge-refused":
      return (
        <PullRequestMergeDialog
          item={pullRequest()}
          busy={false}
          {...(dialog === "pr-merge-refused"
            ? {
                refusal:
                  "Delivery into main could not be verified: the merge commit is not on origin/main yet.",
              }
            : {})}
          onConfirm={noop}
          onClose={noop}
        />
      );
  }
}

const meta = {
  excludeStories: /.*Story$/,
  id: "worktree-dialogs",
  title: "Worktree/Dialogs",
  component: WorktreeDialogStory,
  parameters: { layout: "fullscreen" },
  argTypes: {
    dialog: {
      control: "select",
      options: [
        "create",
        "commit",
        "commit-error",
        "create-pr",
        "merge-pr",
        "merge-local",
        "merge-conflicts",
        "retire",
        "remove-dirty",
        "pr-merge-cleanup",
        "pr-merge-refused",
      ],
    },
  },
} satisfies Meta<typeof WorktreeDialogStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CreateWorktree: Story = { args: { dialog: "create" } };
export const Commit: Story = { args: { dialog: "commit" } };
export const CommitFailed: Story = { args: { dialog: "commit-error" } };
export const CreatePullRequest: Story = { args: { dialog: "create-pr" } };
export const MergePullRequest: Story = { args: { dialog: "merge-pr" } };
export const MergePullRequestDark: Story = {
  args: { dialog: "merge-pr" },
  globals: { theme: "dark" },
};
export const MergeLocally: Story = { args: { dialog: "merge-local" } };
export const MergeConflicts: Story = { args: { dialog: "merge-conflicts" } };
export const RetireRefused: Story = { args: { dialog: "retire" } };
export const RetireRefusedDark: Story = {
  args: { dialog: "retire" },
  globals: { theme: "dark" },
};
export const RemoveDirty: Story = { args: { dialog: "remove-dirty" } };
export const PullRequestMergeAndCleanUp: Story = {
  args: { dialog: "pr-merge-cleanup" },
};
export const PullRequestCleanupRefused: Story = {
  args: { dialog: "pr-merge-refused" },
};
