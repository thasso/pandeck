import {
  Check,
  CheckCheck,
  CircleCheck,
  CircleHelp,
  CircleStop,
  ListChecks,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  SessionInboxStatus,
  SessionStatusBadge as SessionStatusBadgeModel,
  SessionStatusTone,
} from "../lib/sessionInbox.ts";
import { Spinner } from "./ui/load.tsx";

/** Badge colors shared by full session cards and their compact child rows. */
export const SESSION_BADGE_TONE: Record<SessionStatusTone, string> = {
  accent: "bg-accent-soft text-accent",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  success: "bg-success-soft text-success",
  muted: "bg-line text-muted",
};

const STATUS_ICON: Partial<Record<SessionInboxStatus, LucideIcon>> = {
  question: CircleHelp,
  approval: CircleCheck,
  "task-choice": ListChecks,
  failed: X,
  interrupted: CircleStop,
  unread: Check,
  quiet: CheckCheck,
};

/**
 * @component SessionStatusIcon
 * @purpose The fixed, non-colour shape for one session inbox state.
 * @useWhen A session state must survive an icon-only compact treatment.
 * @avoidWhen The full status sentence is needed; pair the glyph with the badge
 * label or the row's accessible name.
 * @intent Approval and completed response use distinct shapes, while Running
 * keeps the shared spinner but never a ticking text label.
 * @related SessionStatusBadge, ActiveSessionCard, ClusterChildRow
 */
export function SessionStatusIcon({
  status,
  // Even, like the spinner's 10px: an odd glyph in the 20px icon-only circle
  // sits on a half pixel and renders visibly off-centre.
  size = 12,
}: {
  status: SessionInboxStatus;
  size?: number;
}) {
  if (status === "running") return <Spinner size="xs" className="shrink-0" />;
  const Icon = STATUS_ICON[status];
  return Icon ? <Icon size={size} className="shrink-0" aria-hidden /> : null;
}

/**
 * @component SessionStatusBadge
 * @purpose The shared coloured state marker for session cards and child rows.
 * @useWhen Rendering `sessionStatusBadge` on an attention card or compact peer.
 * @avoidWhen Rendering prose status detail or pull-request delivery state.
 * @intent Full cards keep the word until their status-row container is narrow;
 * child rows ask for icon-only explicitly. The accessible name never changes.
 * @related SessionStatusIcon, ActiveSessionCard, ClusterChildRow
 */
export function SessionStatusBadge({
  badge,
  status,
  display = "responsive",
}: {
  badge: SessionStatusBadgeModel;
  status: SessionInboxStatus;
  /** `slot` is the 16px circle that stands in for a card's leading type icon. */
  display?: "responsive" | "icon-only" | "slot";
}) {
  const iconOnly = display !== "responsive";
  return (
    <span
      role="img"
      aria-label={badge.label}
      title={badge.label}
      data-session-status-badge={display}
      className={`flex shrink-0 items-center justify-center rounded-full font-medium ${
        display === "slot"
          ? "size-4"
          : iconOnly
            ? "size-5"
            : "gap-1 px-1.5 py-px"
      } ${SESSION_BADGE_TONE[badge.tone]}`}
    >
      <SessionStatusIcon status={status} size={display === "slot" ? 10 : 12} />
      {iconOnly ? null : (
        <span className="session-status-badge-label">{badge.label}</span>
      )}
    </span>
  );
}
