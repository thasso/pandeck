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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ErrorNote } from "./common/load.tsx";
import { NoticeList } from "./tools/NoticeList.tsx";

function statusIcon(commit: CommitDisplay) {
  if (commit.status === "committed")
    return <CheckCircle2 className="size-4 text-success" />;
  if (commit.status === "dry-run")
    return <GitCommitHorizontal className="size-4 text-primary" />;
  return <XCircle className="size-4 text-destructive" />;
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
    return <FilePlus2 className="size-3.5 text-success" />;
  if (file.status === "deleted")
    return <Trash2 className="size-3.5 text-destructive" />;
  return <FileText className="size-3.5 text-muted-foreground" />;
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
    <Card size="sm" className="my-1.5">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-x-2">
          {statusIcon(commit)}
          {statusLabel(commit)}
          {commit.repoRoot && (
            <span className="font-mono text-sm font-normal text-muted-foreground">
              {commit.repoRoot}
            </span>
          )}
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-2">
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
        </CardDescription>
        {commit.canAcceptDryRun && commit.entryId && onAccept && (
          <CardAction>
            <Button size="sm" onClick={() => onAccept(commit.entryId!)}>
              Commit this
            </Button>
          </CardAction>
        )}
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {commit.commitMessage && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Commit message
            </p>
            <pre className="rounded-lg bg-muted p-2 font-mono text-sm whitespace-pre-wrap">
              {commit.commitMessage}
            </pre>
          </div>
        )}

        {(commit.addressedTasks?.length ?? 0) > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Session Task context
            </p>
            <ul className="flex flex-col gap-1 text-sm">
              {commit.addressedTasks!.map((task) => (
                <li key={task.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{task.title}</span>
                  <Badge
                    variant={task.status === "done" ? "success" : "secondary"}
                  >
                    {task.status}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )}

        {commit.files.length > 0 && (
          <div>
            <Button
              variant="ghost"
              size="xs"
              className="-ml-2"
              aria-expanded={filesOpen}
              onClick={() => setFilesOpen((open) => !open)}
            >
              <ChevronDown className={filesOpen ? "" : "-rotate-90"} />
              Files
            </Button>
            <ul className="mt-1 divide-y rounded-lg border">
              {shownFiles.map((file) => (
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
                  <span className="text-destructive">
                    -{file.deletions ?? 0}
                  </span>
                </li>
              ))}
              {!filesOpen && commit.files.length > shownFiles.length && (
                <li className="px-2 py-1.5 text-sm text-muted-foreground">
                  + {commit.files.length - shownFiles.length} more files
                </li>
              )}
            </ul>
          </div>
        )}

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
      </CardContent>
    </Card>
  );
}
