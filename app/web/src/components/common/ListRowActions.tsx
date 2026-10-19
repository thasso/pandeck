import type { ReactNode } from "react";
import { IconButton } from "./IconButton.tsx";
import { OverflowMenu } from "./OverflowMenu.tsx";
import { DropdownMenuItem } from "../ui/dropdown-menu.tsx";

export type ListRowAction = {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  /** A quick action that remains direct when more than two actions exist. */
  primary?: boolean;
  accessibleLabel?: string;
  disabled?: boolean;
  /** Only destructive actions may depart from the shared neutral style. */
  variant?: "destructive";
};

/** At most two quick actions and an overflow menu, shared by all layouts. */
export function ListRowActions({
  actions,
  label = "More actions",
  alwaysVisible = false,
}: {
  actions: ListRowAction[];
  label?: string;
  alwaysVisible?: boolean;
}) {
  if (actions.length === 0) return null;
  const direct =
    actions.length <= 2
      ? actions
      : actions.filter((action) => action.primary).slice(0, 2);
  const overflow = actions.filter((action) => !direct.includes(action));
  return (
    <div
      className="list-row-actions flex shrink-0 items-stretch justify-end gap-1.5"
      role="group"
      aria-label="Item actions"
      data-always-visible={alwaysVisible || undefined}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {direct.map((action) => (
        <IconButton
          key={action.id}
          size="list-action"
          label={action.accessibleLabel ?? action.label}
          title={action.accessibleLabel ?? action.label}
          variant={action.variant ?? "ghost"}
          disabled={action.disabled}
          onClick={action.onSelect}
        >
          {action.icon}
        </IconButton>
      ))}
      {overflow.length ? (
        <OverflowMenu
          label={label}
          size="icon-list-overflow"
          contentClassName="w-64 touch-ui:[&_[role=menuitem]]:min-h-11"
        >
          {overflow.map((action) => (
            <DropdownMenuItem
              key={action.id}
              disabled={action.disabled}
              className="cursor-pointer"
              variant={
                action.variant === "destructive" ? "destructive" : "default"
              }
              onClick={action.onSelect}
              title={action.accessibleLabel}
            >
              {action.icon}
              {action.label}
            </DropdownMenuItem>
          ))}
        </OverflowMenu>
      ) : null}
    </div>
  );
}
