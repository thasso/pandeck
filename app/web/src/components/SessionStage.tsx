import type { NewSessionNarration } from "../lib/newSessionShell.ts";
import { ErrorNote, Skeleton, Spinner } from "./common/load.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.tsx";
import { Item } from "./ui/item.tsx";

/**
 * The chrome the chat stage draws while what it shows is not yet the live
 * transcript (`app/web/docs/loading-states.md` § The app shell).
 *
 * The first two are alternatives, never both: either the stage has nothing to
 * show and `PendingSessionPanel` stands in for the transcript (an in-app
 * switch, a chat this browser has never opened), or a cached transcript from
 * the boot route is on screen and `SessionRefreshMark` says a fresher one is on
 * its way. `SessionBootstrapNarration` is the third case — a session that does
 * not exist yet — and it sits UNDER the prompt it belongs to rather than in
 * place of it. One narration per source, in all three.
 */

export function PendingSessionPanel({ title }: { title: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-hidden bg-background">
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-4 py-6">
        {/* The card announces (its own heading names the session); the bars are
            `Skeleton`s standing in for the transcript's first lines, so they
            pulse like every other placeholder in the app rather than sitting
            there as three dead rules. */}
        <Card role="status">
          <CardHeader className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-primary">
              <Spinner size="md" />
            </div>
            <div className="min-w-0">
              <CardTitle className="truncate">Opening {title}</CardTitle>
              <div className="mt-0.5 text-sm text-muted-foreground">
                Keeping the app shell stable while the transcript catches up.
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <Skeleton className="h-3 w-2/3 rounded-full" />
            <Skeleton className="h-3 w-11/12 rounded-full" />
            <Skeleton className="h-3 w-3/4 rounded-full" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * What stands in for the transcript when the session a route names CANNOT be
 * opened (the server said so): the same card frame as `PendingSessionPanel`,
 * so the shell does not jump, but an alert with the reason instead of a status
 * with a spinner and placeholder rows — nothing is on its way.
 */
export function UnavailableSessionPanel({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-hidden bg-background">
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-4 py-6">
        <Card>
          <CardHeader>
            <CardTitle className="truncate">Can't open {title}</CardTitle>
          </CardHeader>
          <CardContent>
            <ErrorNote message={message} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * The bootstrap line of a session that does not exist yet: the first prompt is
 * on screen, the server is still making the session behind it (a worktree
 * checkout, the engine, the prompt itself), and this says so in place rather
 * than leaving the prompt alone under a still page.
 *
 * It sits between the transcript and the composer — the transcript's own top
 * edge is hit-tested for the reader's row, and nothing may stack over it — and
 * it is the surface's ONE narration for that source: while the
 * worktree-provisioning card is on screen the host renders none of this, and a
 * failure keeps the prompt and offers the retry HERE, instead of dropping the
 * user back to an empty new-session page. What stands down for the same reason
 * is `newSessionShell.ownsFailure`, the staged send's claim: the announcement
 * is suppressed because this surface renders the failure (`docs/messaging.md`).
 */
export function SessionBootstrapNarration({
  narration,
  onRetry,
}: {
  narration: NewSessionNarration;
  /** Re-issues the held first send; omitted when it is no longer at hand. */
  onRetry?: (() => void) | undefined;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-2">
      {narration.kind === "failed" ? (
        <ErrorNote
          message={
            <>
              <span className="font-medium">{narration.label}</span> —{" "}
              {narration.detail}
            </>
          }
          onRetry={onRetry}
          retryLabel="Retry send"
        />
      ) : (
        <Item variant="outline" size="sm" role="status">
          <Spinner size="sm" />
          <span>{narration.label}</span>
        </Item>
      )}
    </div>
  );
}

/**
 * The cached-paint refresh affordance: a reload landed on this session's URL,
 * its last transcript is already readable, and the authoritative one is being
 * fetched. This is R2's `RefreshIndicator` contract in the floating geometry the
 * transcript needs — it may not sit in a header, because the transcript's top
 * edge is hit-tested for the reader's row.
 *
 * It reads at body size on panel contrast: it is the ONE thing telling the
 * reader that what they are looking at is not current, so it has to be legible
 * on a phone at arm's length rather than a grey whisper.
 */
export function SessionRefreshMark() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-20 z-20 flex justify-center px-3">
      <Card size="sm" role="status">
        <CardContent className="flex items-center gap-2">
          <Spinner size="sm" />
          Updating session…
        </CardContent>
      </Card>
    </div>
  );
}
