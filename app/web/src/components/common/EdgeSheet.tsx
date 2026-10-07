import type { ReactNode } from "react";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../ui/sheet.tsx";

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
export function EdgeSheet({
  open,
  title,
  onClose,
  side = "bottom",
  offsetTop = 0,
  children,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  side?: "bottom" | "top";
  /** Distance from the viewport top for `side="top"`; ignored otherwise. */
  offsetTop?: number;
  children: ReactNode;
}) {
  const top = side === "top";
  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent
        side={side}
        className={
          top
            ? "gap-0 rounded-b-xl"
            : "max-h-[85vh] gap-0 rounded-t-xl pb-[var(--app-safe-area-bottom)]"
        }
        style={
          top
            ? { top: offsetTop, maxHeight: `calc(85vh - ${offsetTop}px)` }
            : undefined
        }
      >
        <SheetHeader className="border-b pr-12">
          <SheetTitle className="truncate">{title}</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
