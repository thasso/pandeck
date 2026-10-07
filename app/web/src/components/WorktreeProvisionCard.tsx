import { GitBranch, RotateCw, XCircle } from "lucide-react";
import type { WorktreeProvisionDisplay } from "@assistant/shared";

import { ErrorNote, Spinner } from "./common/load.tsx";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * @component WorktreeProvisionCard
 * @purpose The genesis card of a session started with "+ New worktree": names
 * the branch, the base it forked from, and — when provisioning failed — the
 * blocker plus the Retry that re-runs the whole send.
 * @useWhen A `worktreeProvision` display block appears in a transcript, live
 * (browser-built from provisioning progress) or durable (server-appended once
 * the session exists).
 * @avoidWhen Any other worktree surface: the browser and the worktree page own
 * ongoing state, this card only reports how the session began.
 * @intent A failed card is never durable — a failed provision creates no
 * session — so Retry only ever appears on the live one, and only the host that
 * still holds the unsent prompt passes `onRetry`.
 */
export function WorktreeProvisionCard({
  provision,
  onRetry,
  onOpenWorktree,
}: {
  provision: WorktreeProvisionDisplay;
  /** Re-run the send that failed; omitted when the prompt is no longer at hand. */
  onRetry?: (() => void) | undefined;
  onOpenWorktree?: ((worktreeId: string) => void) | undefined;
}) {
  const failed = provision.state === "failed";
  const done = provision.state === "created";

  return (
    <Card size="sm" className="my-1.5">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-x-2">
          {failed ? (
            <XCircle className="size-4 text-destructive" />
          ) : done ? (
            <GitBranch className="size-4 text-success" />
          ) : (
            <Spinner />
          )}
          {phaseLabel(provision)}
          {provision.branch &&
            (done && provision.worktreeId && onOpenWorktree ? (
              <Button
                variant="link"
                size="sm"
                className="min-w-0 px-0 font-mono"
                onClick={() => onOpenWorktree(provision.worktreeId!)}
              >
                <span className="truncate">{provision.branch}</span>
              </Button>
            ) : (
              // Until the checkout exists there is nothing to open, so the
              // name is just a name.
              <span className="min-w-0 truncate font-mono font-normal text-muted-foreground">
                {provision.branch}
              </span>
            ))}
        </CardTitle>
        {provision.baseBranch && (
          <CardDescription>
            forked from{" "}
            <span className="font-mono">{provision.baseBranch}</span>
          </CardDescription>
        )}
      </CardHeader>
      {(provision.error || (failed && onRetry)) && (
        <CardContent className="flex flex-col items-start gap-2">
          {provision.error && (
            <ErrorNote
              message={provision.error}
              onRetry={failed ? onRetry : undefined}
            />
          )}
          {!provision.error && failed && onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RotateCw />
              Retry
            </Button>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function phaseLabel(provision: WorktreeProvisionDisplay): string {
  switch (provision.state) {
    case "naming":
      return "Naming the worktree…";
    case "creating":
      return "Creating the worktree…";
    case "submodules":
      return "Checking out submodules…";
    case "created":
      return "Created worktree";
    case "failed":
      return "Could not create the worktree";
  }
}
