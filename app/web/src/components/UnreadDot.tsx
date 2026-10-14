import type { ReactNode } from "react";

type UnreadDotPlacement = "toolbar" | "avatar" | "icon";

const placementClasses: Record<UnreadDotPlacement, string> = {
  toolbar: "right-1 top-1 size-1.5",
  avatar: "-right-0.5 -top-0.5 size-2.5 border-2 border-card",
  icon: "-right-0.5 -top-0.5 size-1.5",
};

/**
 * @component UnreadDot
 * @purpose Tiny accent dot used to indicate unread or pending attention without showing a count.
 * @useWhen A compact icon, avatar, or toolbar action needs a binary "something needs attention" marker.
 * @avoidWhen The exact number, severity, or progress amount is essential to the user's next action; use local text or a richer badge near the content instead.
 * @intent Shared visual language for low-space unread indicators. Toolbar dots sit inside a size-8 button; icon dots sit just outside the glyph; avatar dots add a panel-colored border.
 */
export function UnreadDot({
  title = "Unread",
  placement = "toolbar",
  className = "",
}: {
  title?: string;
  placement?: UnreadDotPlacement;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      title={title}
      className={`absolute z-20 rounded-full bg-primary ${placementClasses[placement]} ${className}`}
    />
  );
}

/** An icon-sized overlay: the marker never participates in slot sizing. */
export function UnreadIcon({
  icon,
  unread,
}: {
  icon: ReactNode;
  unread: boolean;
}) {
  return (
    <span className="relative inline-flex shrink-0">
      {icon}
      {unread ? <UnreadDot placement="icon" /> : null}
    </span>
  );
}
