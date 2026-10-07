type UnreadDotPlacement = "toolbar" | "avatar";

const placementClasses: Record<UnreadDotPlacement, string> = {
  toolbar: "right-1 top-1 size-1.5",
  avatar: "-right-0.5 -top-0.5 size-2.5 border-2 border-panel",
};

/**
 * @component UnreadDot
 * @purpose Tiny accent dot used to indicate unread or pending attention without showing a count.
 * @useWhen A compact icon, avatar, or toolbar action needs a binary "something needs attention" marker.
 * @avoidWhen The exact number, severity, or progress amount is essential to the user's next action; use local text or a richer badge near the content instead.
 * @intent Shared visual language for low-space unread indicators. Toolbar dots sit inside the top-right of a size-8 icon button (`right-1 top-1 size-1.5`); avatar dots sit just outside the avatar with a panel-colored border.
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
