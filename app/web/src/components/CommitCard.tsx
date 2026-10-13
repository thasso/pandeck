import {
  CheckCircle2,
  ChevronDown,
  FilePlus2,
  FileText,
  GitCommitHorizontal,
  Minus,
  Plus,
  Trash2,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import type { CommitDisplay, CommitFileChange } from "@assistant/shared";
import { shortCommit } from "@assistant/shared/buildInfo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppCard, type AppCardTone } from "./common/AppCard.tsx";
import { ErrorNote } from "./common/load.tsx";
import { NoticeList } from "./tools/NoticeList.tsx";
import { TaskLinkList } from "./TaskLinkList.tsx";

const noop = () => {};

function statusIcon(commit: CommitDisplay) {
  if (commit.status === "committed") return <CheckCircle2 />;
  if (commit.status === "dry-run") return <GitCommitHorizontal />;
  return <XCircle />;
}

function statusLabel(commit: CommitDisplay): string {
  if (commit.status === "committed") return "Committed";
  if (commit.status === "dry-run") return "Commit preview";
  if (commit.status === "blocked") return "Commit blocked";
  return "Commit failed";
}

function statusTone(commit: CommitDisplay): AppCardTone {
  if (commit.status === "committed") return "success";
  if (commit.status === "dry-run") return "info";
  return "destructive";
}

function fileIcon(file: CommitFileChange) {
  if (file.status === "added" || file.status === "untracked")
    return <FilePlus2 className="size-3.5 text-success" />;
  if (file.status === "deleted")
    return <Trash2 className="size-3.5 text-destructive" />;
  return <FileText className="size-3.5 text-muted-foreground" />;
}

/**
 * A commit's files under a "Files" toggle, shared with the approval card that
 * overrides a blocked commit review.
 */
export function CommitFiles({ files }: { files: readonly CommitFileChange[] }) {
  // A long file list starts folded so the message stays the card's lead.
  const [open, setOpen] = useState(files.length <= 8);
  if (files.length === 0) return null;
  return (
    <div>
      {/* Reads as the section label it replaces ("Commit message"
            above): flush with the content edge, no pill, no open fill. */}
      <Button
        variant="ghost"
        size="xs"
        className="mb-1 h-auto gap-1 p-0 text-xs font-medium text-muted-foreground hover:bg-transparent hover:text-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground aria-expanded:hover:text-foreground dark:hover:bg-transparent"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDown className={open ? "" : "-rotate-90"} />
        Files
      </Button>
      {open && (
        <ul className="divide-y rounded-lg border">
          {files.map((file) => (
            <li
              key={file.path}
              className="flex items-center gap-2 px-2 py-1.5 text-sm"
            >
              {fileIcon(file)}
              <span className="min-w-0 flex-1 truncate font-mono">
                {file.path}
              </span>
              {file.sessionTouched && (
                <Badge variant="secondary">session</Badge>
              )}
              <span className="text-success">+{file.additions ?? 0}</span>
              <span className="text-destructive">-{file.deletions ?? 0}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CommitCard({
  commit,
  onAccept,
  onOpenTask,
}: {
  commit: CommitDisplay;
  onAccept?: ((entryId: string) => void) | undefined;
  /** Open one of the Tasks this commit addressed. */
  onOpenTask?: ((taskId: string) => void) | undefined;
}) {
  return (
    <AppCard
      tone={statusTone(commit)}
      icon={statusIcon(commit)}
      label={statusLabel(commit)}
      status={
        commit.commitHash ? (
          <span className="font-mono" title={commit.commitHash}>
            {shortCommit(commit.commitHash)}
          </span>
        ) : null
      }
      actions={
        commit.canAcceptDryRun && commit.entryId && onAccept ? (
          <Button size="xs" onClick={() => onAccept(commit.entryId!)}>
            Commit this
          </Button>
        ) : null
      }
      contentClassName="gap-3"
    >
      {/* The change at a glance: where, how much, and how it was made. */}
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
        {commit.repoRoot && (
          <span className="min-w-0 font-mono wrap-anywhere">
            {commit.repoRoot}
          </span>
        )}
        <span>
          {commit.totals.files} file{commit.totals.files === 1 ? "" : "s"}
        </span>
        <span className="inline-flex items-center gap-1 text-success">
          <Plus className="size-3" />
          {commit.totals.additions}
        </span>
        <span className="inline-flex items-center gap-1 text-destructive">
          <Minus className="size-3" />
          {commit.totals.deletions}
        </span>
        {commit.dryRun && (
          <Badge variant="secondary">no changes committed</Badge>
        )}
        {commit.forced && <Badge variant="warning">forced</Badge>}
        {commit.stagedOnly && <Badge variant="secondary">staged only</Badge>}
      </div>
      {commit.commitMessage && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            Commit message
          </p>
          <pre className="rounded-lg border bg-muted p-2 font-mono text-sm wrap-anywhere whitespace-pre-wrap">
            {commit.commitMessage}
          </pre>
        </div>
      )}

      {(commit.addressedTasks?.length ?? 0) > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            Session Tasks
          </p>
          {/* The same Task rows the inspector's Tasks section draws. */}
          <TaskLinkList
            items={commit.addressedTasks!}
            onOpen={onOpenTask ?? noop}
          />
        </div>
      )}

      <CommitFiles files={commit.files} />

      <NoticeList
        variant="destructive"
        title="Blockers"
        items={commit.blockers.map((b) => (
          <>
            {b.file && <span className="font-mono">{b.file}: </span>}
            {b.reason}
          </>
        ))}
      />
      <NoticeList title="Warnings" items={commit.warnings} />

      {commit.error && <ErrorNote message={commit.error} />}
    </AppCard>
  );
}
