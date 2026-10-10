import { TriangleAlert } from "lucide-react";
import { WORKTREE_MISSING_BLOCKED_REASON } from "@assistant/shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

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
    <div className="mx-auto mb-2 w-full max-w-3xl px-4">
      {/* The soft tint is translucent; back it so the transcript never shows through. */}
      <div className="rounded-lg bg-background">
        <Alert variant="warning" role="status">
          <TriangleAlert />
          <AlertDescription>
            <p>{WORKTREE_MISSING_BLOCKED_REASON}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={onAcknowledge}
              className="mt-2 h-auto min-h-7 max-w-full py-1 text-left whitespace-normal"
            >
              Run in the app directory anyway
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    </div>
  );
}
