import { createContext, useContext, useState, type ReactNode } from "react";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../ui/sheet.tsx";
import { BOTTOM_SHEET_BOTTOM_PADDING_CLASS } from "./bottomSheet.ts";

/**
 * @component EdgeSheet
 * @purpose Modal sheet anchored to a viewport edge for content-heavy transient
 * surfaces on small screens (thread lists, pickers, option panels, header menus).
 * @useWhen A mobile surface needs more room than a Popover and should read as
 * a dismissable layer over the current page.
 * @avoidWhen Desktop-first anchored menus (Popover); this covers the full
 * viewport width.
 * @intent A controlled shadcn `Sheet` with a title bar. `side` decides which
 * edge it grows from: `bottom` (the default, thumb-reachable, safe-area padded)
 * or `top`, which drops out of a header — pass that header's bottom edge as
 * `offsetTop` so the sheet hangs off it instead of covering it.
 */
const EdgeSheetContainerContext = createContext<HTMLElement | null>(null);

/**
 * Binds every EdgeSheet inside it to this box instead of the viewport: a
 * sheet opened in a desktop pane (the main pane, a side panel) covers that
 * pane, not the whole window. `bound={false}` keeps the box but lets its
 * sheets cover the viewport (a phone), without remounting what it holds.
 */
export function EdgeSheetContainer({
  className,
  bound = true,
  children,
}: {
  className?: string;
  bound?: boolean;
  children: ReactNode;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setElement} className={`relative ${className ?? ""}`}>
      <EdgeSheetContainerContext.Provider value={bound ? element : null}>
        {children}
      </EdgeSheetContainerContext.Provider>
    </div>
  );
}

export function EdgeSheet({
  open,
  title,
  onClose,
  side = "bottom",
  offsetTop = 0,
  flush = false,
  children,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  side?: "bottom" | "top";
  /** Distance from the viewport top for `side="top"`; ignored otherwise. */
  offsetTop?: number;
  /**
   * No body padding: the content runs edge to edge, so a sticky band pins
   * flush under the title bar instead of a padding's height below it.
   */
  flush?: boolean;
  children: ReactNode;
}) {
  const top = side === "top";
  const container = useContext(EdgeSheetContainerContext);
  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent
        side={side}
        container={container ?? undefined}
        // A top sheet opens over a blurred backdrop, so it is a card of its
        // own — inset from the edges and the header it hangs off, rounded on
        // every corner — not a drawer glued to the title bar.
        className={
          top
            ? "gap-0 overflow-hidden rounded-xl border"
            : `${container ? "max-h-[85%]" : "max-h-[85vh]"} gap-0 rounded-t-xl ${BOTTOM_SHEET_BOTTOM_PADDING_CLASS}`
        }
        style={
          top
            ? {
                top: offsetTop + 8,
                // Inset from both edges (the side's own inset-x-0 yields).
                left: 8,
                right: 8,
                maxHeight: `calc(85vh - ${offsetTop + 8}px)`,
              }
            : undefined
        }
      >
        <SheetHeader className="border-b pr-12">
          <SheetTitle className="truncate">{title}</SheetTitle>
        </SheetHeader>
        <div className={`min-h-0 flex-1 overflow-y-auto ${flush ? "" : "p-2"}`}>
          {children}
        </div>
      </SheetContent>
    </Sheet>
  );
}
