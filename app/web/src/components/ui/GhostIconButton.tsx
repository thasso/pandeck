import type { MouseEvent, ReactNode } from "react";
import { Spinner } from "./load.tsx";

/**
 * @component GhostIconButton
 * @purpose The standard small ghost icon button for inline actions: faint icon,
 * raised hover, no chrome until interacted with.
 * @useWhen An action sits next to or inside content (edit a field, start a
 * session from a row, copy a value) and must not compete with the content.
 * Prefer this over making the content itself clickable for edit-style actions.
 * @avoidWhen The action is a primary call-to-action; use ui/Button.
 * @intent One consistent size/interaction pattern for inline actions. Pass
 * `revealOnHover` (with a `group`/`group/row` ancestor) to keep the button
 * invisible until the row is hovered or the button is focused.
 */
export function GhostIconButton({
  icon,
  label,
  onClick,
  revealOnHover = false,
  danger = false,
  busy = false,
  disabled = false,
  className = "",
}: {
  icon: ReactNode;
  /** Accessible name; also used as the hover tooltip. */
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Hide until a `group`/`group/row` ancestor is hovered (or the button is focused). */
  revealOnHover?: boolean;
  /** Use the danger hover treatment (delete-style actions). */
  danger?: boolean;
  /**
   * The action this button started is running: the spinner takes the icon's
   * place and the button stops accepting clicks, exactly like `Button`'s
   * `busy` (R5). Nothing around it is blocked.
   */
  busy?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const reveal = revealOnHover
    ? "opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-hover/row:opacity-100"
    : "";
  const hover = danger
    ? "hover:bg-danger/10 hover:text-danger"
    : "hover:bg-raised hover:text-fg";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      aria-busy={busy || undefined}
      title={label}
      aria-label={label}
      className={`flex size-6 shrink-0 items-center justify-center rounded-md text-faint transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed ${hover} ${reveal} ${className}`}
    >
      {busy ? <Spinner size="sm" /> : icon}
    </button>
  );
}
