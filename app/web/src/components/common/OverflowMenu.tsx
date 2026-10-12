import type { ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { Button } from "../ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";

/**
 * @component OverflowMenu
 * @purpose The one "more actions" control: a ghost, icon-only `⋯` trigger and
 *   the `DropdownMenu` of secondary actions it opens.
 * @useWhen An action group has secondary actions that do not earn a visible
 *   button of their own: a card footer, a message's action row, a header.
 * @avoidWhen The action is the next step in the object's state — that stays a
 *   visible button — or the group has nothing secondary, which renders no
 *   trigger at all.
 * @intent Every overflow looks and sits the same, so a reader finds it without
 *   looking: always the horizontal ellipsis, always the LAST control of its
 *   group. `label` names what it holds ("More run actions") and is both the
 *   accessible name and the tooltip. A surface whose overflow is not a menu
 *   (a sheet, a flipped card) uses `IconButton` with the same `Ellipsis` icon
 *   in the same place.
 */
export function OverflowMenu({
  label,
  size = "icon-sm",
  disabled,
  side,
  align = "end",
  contentClassName = "w-56",
  children,
}: {
  label: string;
  /** Match the buttons beside it: `icon-xs` in a card footer. */
  size?: "icon-xs" | "icon-sm" | "icon" | "icon-lg";
  disabled?: boolean;
  side?: "top" | "bottom";
  /** The menu's edge against the trigger; `start` where the group is left-aligned. */
  align?: "start" | "end";
  contentClassName?: string;
  /** `DropdownMenuItem`s (and groups or separators). */
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size={size}
            aria-label={label}
            title={label}
            disabled={disabled}
          />
        }
      >
        <Ellipsis />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={side}
        align={align}
        className={contentClassName}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
