import { useState } from "react";
import { FileDiff, GitCommitHorizontal } from "lucide-react";
import {
  KNOWLEDGE_WORKTREE_ID,
  type WorktreeGitStatus,
} from "@assistant/shared";
import { commitWorktree, fetchWorktreeStatus } from "../lib/worktrees.ts";
import { knowledgeUncommittedCount } from "../lib/knowledgeCheckout.ts";
import { showToast } from "../lib/toast.ts";
import {
  Inspector,
  InspectorSection,
  type InspectorAction,
} from "./shell/Inspector.tsx";
import { CommitWorktreeDialog } from "./worktree/WorktreeDialogs.tsx";

/**
 * @component KnowledgeInspector
 * @purpose The object panel beside the Knowledge Base browser: how many files
 * carry edits no commit holds yet, and the one action for them — commit them.
 * @useWhen The main pane is on the `/knowledge` route.
 * @intent The KB is a folder that is also edited outside the app (an editor, a
 * `git pull`). Those edits stay uncommitted until the user commits them here;
 * the app never commits them on anyone's behalf.
 */
export function KnowledgeInspector({
  status: pushedStatus,
}: {
  status?: WorktreeGitStatus | undefined;
}) {
  const [fetchedStatus, setFetchedStatus] = useState<WorktreeGitStatus>();
  const status =
    fetchedStatus &&
    (!pushedStatus || fetchedStatus.updatedAt > pushedStatus.updatedAt)
      ? fetchedStatus
      : pushedStatus;
  const [commitOpen, setCommitOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const uncommitted = knowledgeUncommittedCount(status);

  const commit = async (message: string) => {
    setCommitting(true);
    setCommitError(null);
    try {
      const result = await commitWorktree(KNOWLEDGE_WORKTREE_ID, { message });
      showToast(
        result.status === "nothing-to-commit"
          ? "Nothing to commit in the Knowledge Base."
          : `Committed ${result.commitHash ?? "the Knowledge Base changes"}.`,
        { tone: result.status === "committed" ? "success" : "default" },
      );
      setCommitOpen(false);
      fetchWorktreeStatus(KNOWLEDGE_WORKTREE_ID)
        .then(setFetchedStatus)
        .catch(() => undefined);
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitting(false);
    }
  };

  const actions: InspectorAction[] =
    uncommitted > 0
      ? [
          {
            key: "commit",
            icon: <GitCommitHorizontal size={14} />,
            label: "Commit changes…",
            busy: committing,
            keepOpen: true,
            onRun: () => {
              setCommitError(null);
              setCommitOpen(true);
            },
          },
        ]
      : [];

  return (
    <>
      <Inspector relations={[]} actions={actions}>
        <InspectorSection
          id="knowledge-uncommitted"
          storageScope="knowledge"
          title="Uncommitted changes"
          icon={<FileDiff size={13} />}
          {...(uncommitted > 0 ? { summary: `${uncommitted}` } : {})}
        >
          <p className="text-sm text-muted-foreground">
            {!status
              ? "Reading the Knowledge Base…"
              : uncommitted > 0
                ? `${uncommitted} file${uncommitted === 1 ? "" : "s"} changed since the last commit.`
                : "Everything in the Knowledge Base is committed."}
          </p>
        </InspectorSection>
      </Inspector>
      {commitOpen && status ? (
        <CommitWorktreeDialog
          status={status}
          busy={committing}
          error={commitError}
          scopeLabel="the Knowledge Base"
          onCommit={(message) => void commit(message)}
          onClose={() => {
            if (!committing) setCommitOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
