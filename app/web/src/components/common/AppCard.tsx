import type { CSSProperties, ReactNode } from "react";
import { Card, CardContent, CardFooter, CardHeader } from "../ui/card.tsx";

export type AppCardTone =
  "neutral" | "info" | "warning" | "success" | "destructive";

const HEADER_TONE: Record<AppCardTone, string> = {
  neutral: "bg-muted/50 text-muted-foreground",
  info: "bg-primary/10 text-primary",
  warning: "bg-warning-soft text-warning",
  success: "bg-success-soft text-success",
  destructive: "bg-destructive/10 text-destructive",
};

/**
 * @component AppCard
 * @purpose The one card the app shows an object or event in: a 32px header row
 *   naming WHAT it is (icon, label, tinted by tone, status on the right), the
 *   content — the object itself — and an optional 32px footer row holding its
 *   actions, right-aligned.
 * @useWhen A transcript result (commit, approval, workflow run), a notice that
 *   asks for a decision (a Task suggestion), or one item of a card list.
 * @avoidWhen A page or settings section that only groups rows (no kind, no
 *   actions), or side activity, which stays a one-line row.
 * @intent The header is the card's KIND, never its subject: the subject leads
 *   the content, so every card reads the same way top to bottom. Buttons live
 *   in the footer only — the header carries state (tone, `status`) — so a
 *   reader always finds what they can do in the same place. Forms belong in the
 *   content; the footer holds the buttons that submit them, and the few
 *   per-click settings a button reads (a merge method) sit beside it in
 *   `options` rather than up in the content, where they read as information.
 */
export function AppCard({
  tone = "neutral",
  icon,
  label,
  status,
  actions,
  footerStart,
  options,
  flush = false,
  className = "",
  contentClassName = "",
  style,
  role,
  children,
}: {
  tone?: AppCardTone;
  icon?: ReactNode;
  /** What kind of card this is ("Commit", "Approval needed", "Suggestion"). */
  label: ReactNode;
  /**
   * State on the header's right: a badge, a hash, a count. Never a button,
   * but the object's own identifier may be the link to it (a pull request
   * number opening the pull request). Several elements line up on the one
   * row, separated by "·".
   */
  status?: ReactNode;
  /** The footer's buttons, right-aligned. No actions, no footer. */
  actions?: ReactNode;
  /** Quiet text at the footer's left, beside the actions (a time, a hint). */
  footerStart?: ReactNode;
  /**
   * Controls at the footer's left that configure its buttons (a merge
   * method, a checkbox). They wrap above the buttons on a narrow screen.
   */
  options?: ReactNode;
  /** Content edge to edge, for a table or a list that draws its own rows. */
  flush?: boolean;
  className?: string;
  contentClassName?: string;
  /** For a card sized against something other than its column (a wide table). */
  style?: CSSProperties;
  role?: string;
  children?: ReactNode;
}) {
  const hasFooter = Boolean(actions || footerStart || options);
  return (
    <Card
      size="sm"
      role={role}
      style={style}
      // A real border, not the Card's outside ring: transcript rows clip
      // paint to their box, which cut a full-width card's side edges.
      className={`my-1.5 gap-0 border border-foreground/10 py-0 ring-0 ${className}`}
    >
      <CardHeader
        className={`flex h-8 items-center gap-1.5 border-b py-0 text-xs font-medium [.border-b]:pb-0 [&_svg]:size-3.5 ${HEADER_TONE[tone]}`}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {status ? (
          <span className="app-card-status flex max-w-3/5 min-w-0 items-center justify-end gap-1 overflow-hidden whitespace-nowrap">
            {status}
          </span>
        ) : null}
      </CardHeader>
      {children ? (
        <CardContent
          className={`flex flex-col gap-2 ${flush ? "px-0 py-0" : "py-3"} ${contentClassName}`}
        >
          {children}
        </CardContent>
      ) : null}
      {hasFooter ? (
        <CardFooter className="min-h-8 flex-wrap gap-1 py-1">
          {options ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              {options}
            </div>
          ) : null}
          {footerStart ? (
            <span className="min-w-0 flex-1 text-xs text-muted-foreground">
              {footerStart}
            </span>
          ) : null}
          <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
            {actions}
          </span>
        </CardFooter>
      ) : null}
    </Card>
  );
}
