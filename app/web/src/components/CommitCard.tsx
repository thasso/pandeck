import {
  AlertTriangle,
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

function tone(commit: CommitDisplay): string {
  if (commit.status === "committed") return "border-success/30 bg-success-soft";
  if (commit.status === "dry-run") return "border-primary/30 bg-accent";
  if (commit.status === "blocked" || commit.status === "failed")
    return "border-danger/30 bg-danger-soft";
  return "border-line bg-panel";
}

function statusIcon(commit: CommitDisplay) {
  if (commit.status === "committed")
    return <CheckCircle2 size={16} className="text-success" />;
  if (commit.status === "dry-run")
    return <GitCommitHorizontal size={16} className="text-primary" />;
  return <XCircle size={16} className="text-danger" />;
}

function statusLabel(commit: CommitDisplay): string {
  if (commit.status === "committed")
    return `Committed${commit.commitHash ? ` ${commit.commitHash}` : ""}`;
  if (commit.status === "dry-run") return "Dry-run commit preview";
  if (commit.status === "blocked") return "Commit blocked";
  return "Commit failed";
}

function fileIcon(file: CommitFileChange) {
  if (file.status === "added" || file.status === "untracked")
    return <FilePlus2 size={13} className="text-success" />;
  if (file.status === "deleted")
    return <Trash2 size={13} className="text-danger" />;
  return <FileText size={13} className="text-faint" />;
}

export function CommitCard({
  commit,
  onAccept,
}: {
  commit: CommitDisplay;
  onAccept?: ((entryId: string) => void) | undefined;
}) {
  const [filesOpen, setFilesOpen] = useState(commit.files.length <= 8);
  const shownFiles = filesOpen ? commit.files : commit.files.slice(0, 6);
  return (
    <div className={`my-1.5 overflow-hidden rounded-xl border ${tone(commit)}`}>
      <div className="flex items-start gap-3 border-b border-line/60 px-3 py-3">
        <div className="mt-0.5">{statusIcon(commit)}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="text-sm font-semibold text-fg">
              {statusLabel(commit)}
            </div>
            {commit.repoRoot && (
              <div className="font-mono text-sm text-faint">
                {commit.repoRoot}
              </div>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-3 text-sm text-muted-foreground">
            <span>
              {commit.totals.files} file{commit.totals.files === 1 ? "" : "s"}
            </span>
            <span className="inline-flex items-center gap-1 text-success">
              <Plus size={11} />
              {commit.totals.additions}
            </span>
            <span className="inline-flex items-center gap-1 text-danger">
              <Minus size={11} />
              {commit.totals.deletions}
            </span>
            {commit.dryRun && (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-primary">
                no changes committed
              </span>
            )}
            {commit.forced && (
              <span className="rounded-full bg-warning-soft px-2 py-0.5 text-fg">
                forced
              </span>
            )}
            {commit.stagedOnly && (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-primary">
                staged only
              </span>
            )}
          </div>
        </div>
        {commit.canAcceptDryRun && commit.entryId && onAccept && (
          <button
            type="button"
            onClick={() => onAccept(commit.entryId!)}
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-primary/90"
          >
            Commit this
          </button>
        )}
      </div>

      <div className="space-y-3 px-3 py-3">
        {commit.commitMessage && (
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-faint">
              Commit message
            </div>
            <pre className="whitespace-pre-wrap rounded-lg bg-raised p-2 font-mono text-sm text-fg">
              {commit.commitMessage}
            </pre>
          </div>
        )}

        {(commit.addressedTasks?.length ?? 0) > 0 && (
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-faint">
              Session Task context
            </div>
            <div className="space-y-1 rounded-lg border border-line bg-panel/50 p-2">
              {commit.addressedTasks!.map((task) => (
                <div
                  key={task.id}
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                >
                  <span
                    className={`size-1.5 rounded-full ${task.status === "done" ? "bg-success" : "bg-primary"}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-fg">
                    {task.title}
                  </span>
                  <span className="text-faint">{task.status}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {commit.files.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setFilesOpen((open) => !open)}
              className="mb-1 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-faint hover:text-muted-foreground"
            >
              <ChevronDown
                size={12}
                className={`transition-transform ${filesOpen ? "" : "-rotate-90"}`}
              />
              Files
            </button>
            <div className="overflow-hidden rounded-lg border border-line bg-panel/50">
              {shownFiles.map((file) => (
                <div
                  key={file.path}
                  className="flex items-center gap-2 border-b border-line/50 px-2 py-1.5 last:border-b-0"
                >
                  {fileIcon(file)}
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">
                    {file.path}
                  </span>
                  {file.sessionTouched && (
                    <span className="rounded bg-primary/15 px-1.5 py-0.5 text-xs text-primary">
                      session
                    </span>
                  )}
                  <span className="text-sm text-success">
                    +{file.additions ?? 0}
                  </span>
                  <span className="text-sm text-danger">
                    -{file.deletions ?? 0}
                  </span>
                </div>
              ))}
              {!filesOpen && commit.files.length > shownFiles.length && (
                <div className="px-2 py-1.5 text-sm text-faint">
                  + {commit.files.length - shownFiles.length} more files
                </div>
              )}
            </div>
          </div>
        )}

        {commit.blockers.length > 0 && (
          <div className="rounded-lg border border-danger/35 bg-danger-soft px-2.5 py-2 text-sm text-fg">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-fg">
              <XCircle size={13} className="text-danger" />
              Blockers
            </div>
            <ul className="list-disc space-y-1 pl-5 marker:text-danger">
              {commit.blockers.map((b, i) => (
                <li key={i}>
                  {b.file && (
                    <span className="font-mono text-danger">{b.file}: </span>
                  )}
                  {b.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {commit.warnings.length > 0 && (
          <div className="rounded-lg border border-warning/35 bg-warning-soft px-2.5 py-2 text-sm text-fg">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-fg">
              <AlertTriangle size={13} className="text-warning" />
              Warnings
            </div>
            <ul className="list-disc space-y-1 pl-5 marker:text-warning">
              {commit.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        {commit.error && (
          <div className="rounded-lg border border-danger/35 bg-danger-soft px-2.5 py-2 text-sm text-fg">
            {commit.error}
          </div>
        )}
      </div>
    </div>
  );
}
