import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

interface PopoverProps {
  /** Renders the trigger button content. */
  button: ReactNode;
  /** Panel contents; receives a close callback. */
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  placement?: "top" | "bottom" | "auto";
  className?: string;
  title?: string;
  disabled?: boolean;
}

interface PopoverPosition {
  top: number;
  left: number;
  minWidth: number;
}

function scrollBoundary(node: HTMLElement | null): DOMRect | null {
  for (let el = node?.parentElement; el; el = el.parentElement) {
    const style = window.getComputedStyle(el);
    const overflowY = style.overflowY;
    if (
      overflowY === "auto" ||
      overflowY === "scroll" ||
      overflowY === "hidden"
    ) {
      return el.getBoundingClientRect();
    }
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * @component Popover
 * @purpose Reusable click-to-open floating menu for compact selector/action controls.
 * @useWhen A small trigger needs an outside-click/Escape-dismissed menu that must escape clipped parents.
 * @intent Panels are portaled to document.body and fixed-positioned against the trigger so composer/chat overflow does not crop them.
 */
/**
 * @component Popover
 * @purpose Portal-based popover anchored to its trigger button, with viewport- and scroll-boundary-aware placement.
 * @useWhen A transient action/menu panel should float over content from a trigger (row actions, compact pickers).
 * @avoidWhen Modal flows or persistent panels; this is for dismissable anchored content only.
 */
export function Popover({
  button,
  children,
  align = "left",
  placement = "bottom",
  className,
  title,
  disabled = false,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const [resolvedPlacement, setResolvedPlacement] = useState<"top" | "bottom">(
    placement === "top" ? "top" : "bottom",
  );
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const anchor = ref.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!anchor || !panel) return;

      const gap = 8;
      const padding = 8;
      const boundary = scrollBoundary(ref.current);
      const boundaryTop = boundary ? Math.max(0, boundary.top) : 0;
      const boundaryBottom = boundary
        ? Math.min(window.innerHeight, boundary.bottom)
        : window.innerHeight;
      const spaceBelow = boundaryBottom - anchor.bottom;
      const spaceAbove = anchor.top - boundaryTop;
      const anchorCenter = anchor.top + anchor.height / 2;
      const lowerPartOfBoundary =
        anchorCenter > boundaryTop + (boundaryBottom - boundaryTop) * 0.6;
      const nextPlacement =
        placement === "auto"
          ? spaceAbove > spaceBelow &&
            (spaceBelow < panel.height + gap || lowerPartOfBoundary)
            ? "top"
            : "bottom"
          : placement === "top"
            ? "top"
            : "bottom";
      const desiredLeft =
        align === "right" ? anchor.right - panel.width : anchor.left;
      const maxLeft = Math.max(
        padding,
        window.innerWidth - panel.width - padding,
      );
      const left = clamp(desiredLeft, padding, maxLeft);
      const unclampedTop =
        nextPlacement === "top"
          ? anchor.top - panel.height - gap
          : anchor.bottom + gap;
      const maxTop = Math.max(
        padding,
        window.innerHeight - panel.height - padding,
      );
      const top = clamp(unclampedTop, padding, maxTop);

      setResolvedPlacement(nextPlacement);
      setPosition({ top, left, minWidth: anchor.width });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [align, open, placement]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || panelRef.current?.contains(target))
        return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        title={title}
        onClick={() => setOpen((o) => !o)}
        className={className}
        data-open={open}
        disabled={disabled}
      >
        {button}
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            // Above the modal layer (see ui-shell.md "Layers"): a popover
            // opened from inside a modal is portaled to the body as a SIBLING
            // of that modal, so a lower z-index paints it behind the modal's
            // own backdrop — open, invisible, and unclickable.
            className="fixed z-[80] min-w-[200px] overflow-hidden rounded-xl border border-line bg-panel p-1 shadow-2xl shadow-black/30"
            data-popover-panel
            data-placement={resolvedPlacement}
            style={{
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              minWidth: position?.minWidth,
              visibility: position ? "visible" : "hidden",
            }}
          >
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </div>
  );
}
