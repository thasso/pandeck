import type { ReactNode } from "react";
import { OverflowMenu } from "../components/common/OverflowMenu.tsx";
import { Button } from "../components/ui/button.tsx";
import { DropdownMenuItem } from "../components/ui/dropdown-menu.tsx";

export interface GatewayRowAction {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

/**
 * One row of a gateway list. Left: title and subtitle. Right, centred on the
 * row: status, at most one labelled next-step action (filled when the row's
 * state asks for it), and the ⋯ menu holding every other action; destructive
 * actions only ever live in the menu.
 */
export function GatewayRow({
  title,
  subtitle,
  status,
  primary,
  primaryEmphasis = false,
  menu,
  menuLabel,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  status?: ReactNode;
  primary?: GatewayRowAction | undefined;
  /** The row's state asks for the primary action: show it filled. */
  primaryEmphasis?: boolean;
  menu: GatewayRowAction[];
  menuLabel: string;
}) {
  return (
    <div
      role="listitem"
      className="flex items-center gap-4 border-b border-border/60 py-3 last:border-b-0"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{title}</span>
        {subtitle ? (
          <span className="truncate text-xs text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </div>
      {status ? (
        <div className="flex shrink-0 items-center">{status}</div>
      ) : null}
      <div className="flex shrink-0 items-center gap-1">
        {primary ? (
          <Button
            variant={primaryEmphasis ? "default" : "outline"}
            size="sm"
            disabled={primary.disabled}
            onClick={primary.onSelect}
          >
            {primary.icon}
            {primary.label}
          </Button>
        ) : null}
        {menu.length ? (
          <OverflowMenu label={menuLabel} size="icon-sm">
            {menu.map((action) => (
              <DropdownMenuItem
                key={action.id}
                disabled={action.disabled}
                variant={action.destructive ? "destructive" : "default"}
                className="cursor-pointer"
                onClick={action.onSelect}
              >
                {action.icon}
                {action.label}
              </DropdownMenuItem>
            ))}
          </OverflowMenu>
        ) : null}
      </div>
    </div>
  );
}
