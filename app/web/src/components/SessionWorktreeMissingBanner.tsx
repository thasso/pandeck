import { TriangleAlert } from "lucide-react";
import { WORKTREE_MISSING_BLOCKED_REASON } from "@assistant/shared";
import { AppCard } from "./common/AppCard.tsx";
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
      <AppCard
        role="status"
        tone="warning"
        icon={<TriangleAlert />}
        label="Worktree missing"
        actions={
          <Button
            variant="outline"
            size="xs"
            // Wraps on a narrow screen rather than running past the card.
            className="h-auto min-h-6 max-w-full py-0.5 text-left whitespace-normal"
            onClick={onAcknowledge}
          >
            Run in the app directory anyway
          </Button>
        }
      >
        <p>{WORKTREE_MISSING_BLOCKED_REASON}</p>
      </AppCard>
    </div>
  );
}
