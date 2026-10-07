import {
  CircleDashed,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestCreate,
  GitPullRequestDraft,
  MessageSquareWarning,
  OctagonX,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { SessionListItem } from "@assistant/shared";
import {
  sessionDelivery,
  type SessionDeliveryState,
} from "../lib/sessionDelivery.ts";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "./common/load.tsx";
import { TONE_BADGE, TONE_TEXT } from "./common/statusBadge.ts";

/**
 * A SHAPE per state, not a tint per state. On a one-line row the glyph is the
 * whole indicator, so a mark that varied only in colour said nothing at all to
 * a reader with a colour-vision deficiency — the accessible name carried the
 * state and the screen carried none of it. The tone now rides on top of a glyph
 * that already differs, which is the direction that degrades safely.
 *
 * The problem states leave the pull-request family deliberately: an alarm shape
 * is what reads at 11px, and every host also names the state in words.
 *
 * `choosing-task` stays IN the family for the opposite reason. It is the one
 * state that is also a question for you, so the obvious glyph is the
 * `CircleHelp` a row already renders one item away for `awaitingInput` — and
 * two identical accent circles side by side say "something is asking" twice
 * without saying which. The pull-request-with-a-plus keeps it a statement about
 * the pull request that does not exist yet; its tone and its name carry that
 * you are the one holding it up.
 *
 * `creating` is absent on purpose: it is the one state that is not a shape but
 * an ACT under way — the pull request is being opened right now — so it draws
 * the app's `Spinner` (Task-391). What sat here before was the spinner's own
 * glyph held STILL: to a reader who knows it, a dead spinner is the one thing
 * a mark for work in progress must never say.
 */
const STATE_ICON: Record<
  Exclude<SessionDeliveryState, "creating">,
  LucideIcon
> = {
  "choosing-task": GitPullRequestCreate,
  failed: OctagonX,
  // The pull request itself, in red: the thing that is wrong is the PR.
  "ci-failed": GitPullRequest,
  conflicts: TriangleAlert,
  "review-requested": MessageSquareWarning,
  "ci-pending": CircleDashed,
  merged: GitMerge,
  draft: GitPullRequestDraft,
  open: GitPullRequest,
  closed: GitPullRequestClosed,
};

/**
 * @component SessionDeliveryMark
 * @purpose The ONE indicator that a session owns a `/pr` card, and what that
 * pull request is asking for (`lib/sessionDelivery.ts`).
 * @useWhen Rendering a session in any list — the Sessions inbox's cards and
 * shelf rows, and the compact rows nested under a Project or a Worktree.
 * @avoidWhen Inside a session; the transcript carries the live card itself,
 * which says all of this and acts on it.
 * @intent One component at two widths so a phone and a desktop cannot state
 * different things: a `chip` where there is room for the state in words, a
 * `glyph` on a one-line row, where the SHAPE carries it and the words move into
 * the accessible name. It is deliberately NOT a link: the card lives in the
 * session, so the ROW is what opens it, and a second target inside the row
 * would compete with the one that already leads there.
 * @related lib/sessionDelivery.ts, ActiveSessionCard, SessionRow, InboxShelfRow
 */
export function SessionDeliveryMark({
  session,
  variant = "chip",
  showNumber = false,
}: {
  session: Pick<SessionListItem, "pullRequest">;
  /** Append the pull request's number; it survives the icon-only collapse. */
  showNumber?: boolean;
  /** `chip` states the state in words; `glyph` is icon-only; `responsive` yields to a narrow card container. */
  variant?: "chip" | "glyph" | "responsive";
}) {
  const delivery = sessionDelivery(session);
  if (!delivery) return null;
  const Icon =
    delivery.state === "creating" ? null : STATE_ICON[delivery.state];

  if (variant === "glyph") {
    return (
      <span
        className={`flex size-4 shrink-0 items-center justify-center ${TONE_TEXT[delivery.tone]}`}
        title={delivery.title}
        aria-label={`Pull request: ${delivery.title}`}
        role="img"
      >
        {Icon ? <Icon size={11} /> : <Spinner size="xs" />}
      </span>
    );
  }

  const number = showNumber ? session.pullRequest?.number : undefined;
  // "PR #322" already names the number; with the number shown, the label
  // would say it twice.
  const labelIsNumber =
    number !== undefined && delivery.label.includes(`#${number}`);
  return (
    <Badge
      variant={TONE_BADGE[delivery.tone]}
      className={
        // The square collapse would clip the number, so a numbered mark only
        // hides its label.
        variant === "responsive" && number === undefined
          ? "session-status-responsive-badge"
          : undefined
      }
      title={delivery.title}
      aria-label={`Pull request: ${delivery.title}`}
      role="img"
    >
      {Icon ? <Icon aria-hidden /> : <Spinner size="xs" />}
      {labelIsNumber ? null : (
        <span
          className={
            variant === "responsive" ? "session-status-badge-label" : undefined
          }
        >
          {delivery.label}
        </span>
      )}
      {number !== undefined ? (
        <span className="tabular-nums">#{number}</span>
      ) : null}
    </Badge>
  );
}
