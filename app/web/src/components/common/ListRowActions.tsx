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

/** Compact row actions with a separated, labeled touch presentation. */
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
  const direct = actions.length <= 2 ? actions : actions.filter((action) => action.primary);
  const overflow = actions.length <= 2 ? [] : actions.filter((action) => !action.primary);
  return (
    <div
      className="list-row-actions flex min-w-0 flex-1 items-center justify-end gap-1.5 touch-ui:flex-wrap touch-ui:gap-3"
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
          className="touch-ui:min-w-28 touch-ui:flex-1"
          onClick={action.onSelect}
        >
          {action.icon}
          <span className="hidden min-w-0 whitespace-normal touch-ui:inline">{action.label}</span>
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
              variant={action.variant === "destructive" ? "destructive" : "default"}
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
