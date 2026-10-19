import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { RowDensity } from "../../lib/rowDensity.ts";
import { ListRow } from "./ListRow.tsx";

/** An in-list expansion, using the same geometry and type as compact rows. */
export function ListExpansionRow({
  rowId,
  label,
  accessibleLabel = label,
  count,
  expanded,
  density,
  tabbable = false,
  onToggle,
  onFocusSibling,
  children,
}: {
  rowId: string;
  label: string;
  accessibleLabel?: string;
  count?: number;
  expanded: boolean;
  density: RowDensity;
  /** For hosts without roving keyboard focus. */
  tabbable?: boolean;
  onToggle: () => void;
  onFocusSibling?: ((delta: 1 | -1) => void) | undefined;
  children?: ReactNode;
}) {
  return (
    <>
      <ListRow
        density={density}
        divider={false}
        render={<button type="button" />}
        data-session-row
        data-list-row-id={rowId}
        tabIndex={tabbable ? 0 : -1}
        ariaLabel={accessibleLabel}
        aria-expanded={expanded}
        onOpen={onToggle}
        onFocusSibling={onFocusSibling}
        className="border-t border-border/60"
        style={{ paddingLeft: "0.25rem" }}
        identity={
          <>
            <ChevronRight
              aria-hidden
              className={`size-4 shrink-0 text-muted-foreground ${expanded ? "rotate-90" : ""}`}
            />
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
              {label}
            </span>
          </>
        }
        trailing={count !== undefined ? (
          <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
        ) : undefined}
      />
      {expanded ? children : null}
    </>
  );
}
