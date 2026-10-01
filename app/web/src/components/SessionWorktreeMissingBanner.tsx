import { TriangleAlert } from "lucide-react";
import { WORKTREE_MISSING_BLOCKED_REASON } from "@assistant/shared";

/**
 * The worktree this session ran in is gone (removed, or its folder deleted), so
 * the server refuses to start another turn: it would run the agent in the app's
 * own checkout instead of the repository every earlier turn worked on.
 *
 * Shown directly above a disabled composer, carrying the one affordance that
 * unblocks it — the explicit acknowledgement that running in the app directory
 * is what the user wants.
 */
export function SessionWorktreeMissingBanner({
  onAcknowledge,
}: {
  onAcknowledge: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4">
      <div
        role="status"
        className="mb-2 flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-400/10 px-3 py-2 text-caption text-fg sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-2"
      >
        <div className="flex items-start gap-2">
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber-500" />
          <p className="min-w-0 flex-1">{WORKTREE_MISSING_BLOCKED_REASON}</p>
        </div>
        <button
          type="button"
          onClick={onAcknowledge}
          className="shrink-0 rounded-lg border border-amber-500/50 px-3 py-1.5 font-medium text-amber-500 transition-colors hover:bg-amber-400/20 sm:ml-auto sm:px-2 sm:py-1"
        >
          Run in the app directory anyway
        </button>
      </div>
    </div>
  );
}
