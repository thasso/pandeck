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
  /** What the row's state asks for (a merged branch's Retire): marked out. */
  highlighted?: boolean;
};

/** At most two quick actions and an overflow menu, shared by all layouts. */
export function ListRowActions({
  actions,
  label = "More actions",
  alwaysVisible = false,
  menuOnly = false,
  onMenuIntent,
}: {
  actions: ListRowAction[];
  label?: string;
  alwaysVisible?: boolean;
  /** Every action in the menu behind one vertical ⋮, none direct. */
  menuOnly?: boolean;
  /** The menu is about to open (hover, focus or press): build its items now. */
  onMenuIntent?: (() => void) | undefined;
}) {
  if (actions.length === 0) return null;
  const direct = menuOnly
    ? []
    : actions.length <= 2
      ? actions
      : actions.filter((action) => action.primary).slice(0, 2);
  const overflow = actions.filter((action) => !direct.includes(action));
  return (
    <div
      className="list-row-actions flex shrink-0 items-stretch justify-end gap-1.5"
      role="group"
      aria-label="Item actions"
      data-always-visible={alwaysVisible || undefined}
      onPointerDown={(event) => {
        event.stopPropagation();
        onMenuIntent?.();
      }}
      onPointerEnter={onMenuIntent}
      onFocus={onMenuIntent}
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
          vertical={menuOnly}
          contentClassName="w-64 touch-ui:[&_[role=menuitem]]:min-h-11"
        >
          {overflow.map((action) => (
            <DropdownMenuItem
              key={action.id}
              disabled={action.disabled}
              className={`cursor-pointer ${action.highlighted ? "bg-primary/10 font-medium text-primary [&_svg]:text-primary" : ""}`}
              variant={
                action.variant === "destructive" ? "destructive" : "default"
              }
              onClick={action.onSelect}
              title={action.accessibleLabel}
            >
              {action.icon}
              {action.label}
              {action.highlighted ? (
                <span
                  aria-hidden
                  className="ml-auto size-1.5 shrink-0 rounded-full bg-primary"
                />
              ) : null}
            </DropdownMenuItem>
          ))}
        </OverflowMenu>
      ) : null}
    </div>
  );
}
