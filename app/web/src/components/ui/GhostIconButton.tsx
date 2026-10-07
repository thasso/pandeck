import type { MouseEvent, ReactNode } from "react";
import { cn } from "cn";

import { Button } from "./button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";

/**
 * @component GhostIconButton
 * @purpose The standard small ghost icon button for inline actions: shadcn's
 * ghost `Button` at `icon-xs`, labelled by a tooltip.
 * @useWhen An action sits next to or inside content (edit a field, start a
 * session from a row, copy a value) and must not compete with the content.
 * @avoidWhen The action is a primary call-to-action; use ui/button.
 * @intent Pass `revealOnHover` (with a `group`/`group/row` ancestor) to keep
 * the button invisible until the row is hovered or the button is focused.
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
  /** Accessible name; also used as the tooltip. */
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Hide until a `group`/`group/row` ancestor is hovered (or the button is focused). */
  revealOnHover?: boolean;
  /** Use the destructive hover treatment (delete-style actions). */
  danger?: boolean;
  /** The action this button started is running (R5): spinner, no clicks. */
  busy?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onClick}
            busy={busy}
            disabled={disabled}
            aria-label={label}
            className={cn(
              "text-muted-foreground",
              danger && "hover:bg-destructive/10 hover:text-destructive",
              revealOnHover &&
                "opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-hover/row:opacity-100",
              className,
            )}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
