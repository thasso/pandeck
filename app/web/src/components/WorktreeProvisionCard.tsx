import { GitBranch, RotateCw, XCircle } from "lucide-react";
import type { WorktreeProvisionDisplay } from "@assistant/shared";

import { Spinner } from "./common/load.tsx";

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
  const tone = failed
    ? "border-danger/30 bg-danger-soft"
    : done
      ? "border-success/30 bg-success-soft"
      : "border-line bg-panel";

  return (
    <div className={`my-1.5 overflow-hidden rounded-xl border ${tone}`}>
      <div className="flex items-start gap-3 px-3 py-3">
        <div className="mt-0.5">
          {failed ? (
            <XCircle size={16} className="text-danger" />
          ) : done ? (
            <GitBranch size={16} className="text-success" />
          ) : (
            <Spinner className="text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="text-sm font-semibold text-fg">
              {phaseLabel(provision)}
            </div>
            {provision.branch &&
              (done && provision.worktreeId && onOpenWorktree ? (
                <button
                  type="button"
                  onClick={() => onOpenWorktree(provision.worktreeId!)}
                  className="min-w-0 truncate font-mono text-sm text-faint hover:text-fg hover:underline"
                >
                  {provision.branch}
                </button>
              ) : (
                // Until the checkout exists there is nothing to open, so the
                // name is just a name.
                <span className="min-w-0 truncate font-mono text-sm text-faint">
                  {provision.branch}
                </span>
              ))}
          </div>
          {provision.baseBranch && (
            <div className="mt-1 text-sm text-muted-foreground">
              forked from{" "}
              <span className="font-mono text-faint">
                {provision.baseBranch}
              </span>
            </div>
          )}
          {provision.error && (
            <div className="mt-2 rounded-lg border border-danger/35 bg-danger-soft px-2.5 py-2 text-sm text-fg">
              {provision.error}
            </div>
          )}
          {failed && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-sm font-medium text-fg hover:border-line-strong hover:bg-raised"
            >
              <RotateCw size={13} />
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
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
