import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
  BOTTOM_SHEET_BOTTOM_PADDING_CLASS,
  BOTTOM_SHEET_GUTTER,
  BOTTOM_SHEET_MAX_HEIGHT_CLASS,
  BOTTOM_SHEET_SURFACE_CLASS,
} from "./bottomSheet.ts";

/**
 * @component Sheet
 * @purpose Modal sheet anchored to a viewport edge for content-heavy transient
 * surfaces on small screens (thread lists, pickers, option panels, header menus).
 * @useWhen A mobile surface needs more room than a Popover and should read as
 * a dismissable layer over the current page.
 * @avoidWhen Desktop-first anchored menus (Popover) or composer-local panels
 * (ChatDockPanel); this covers the full viewport width.
 * @intent Portaled fixed overlay with a backdrop, rounded sheet, title bar with a
 * close button, and Escape/backdrop dismissal. `side` decides which edge it grows
 * from: `bottom` (the default, thumb-reachable, safe-area padded) or `top`, which
 * drops out of a header — pass that header's bottom edge as `offsetTop` so the
 * sheet hangs off it instead of covering it.
 */
export function Sheet({
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
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const top = side === "top";

  return createPortal(
    <div
      className={`fixed inset-0 z-[70] flex flex-col bg-black/40 ${top ? "justify-start" : `justify-end ${BOTTOM_SHEET_GUTTER}`}`}
      style={top ? { paddingTop: offsetTop } : undefined}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        // A bottom sheet wears the shared bottom-sheet card (ui/bottomSheet.ts) so
        // every surface rising from that edge reads as the same object; a top sheet
        // is its mirror image, hanging off the header it drops out of.
        className={`flex flex-col ${
          top
            ? "rounded-b-2xl border-b border-line bg-panel pb-1 shadow-2xl"
            : `${BOTTOM_SHEET_SURFACE_CLASS} ${BOTTOM_SHEET_MAX_HEIGHT_CLASS} ${BOTTOM_SHEET_BOTTOM_PADDING_CLASS}`
        }`}
        // A top sheet's cap must account for the header it hangs off, or tall
        // content would run past the bottom edge of the viewport.
        style={top ? { maxHeight: `calc(85vh - ${offsetTop}px)` } : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <div className="min-w-0 flex-1 truncate text-body font-semibold text-fg">
            {title}
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            aria-label="Close"
            className="flex size-7 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raised hover:text-fg"
          >
            <X size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
