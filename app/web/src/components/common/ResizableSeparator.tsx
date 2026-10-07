import {
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

export const RESIZE_KEYBOARD_STEP = 16;

export interface ResizeDragOptions {
  /** Receives the pointer's viewport X coordinate for each drag move/end. */
  onResize: (
    clientX: number,
    event: PointerEvent | ReactPointerEvent<HTMLDivElement>,
  ) => void;
  cursor?: string;
}

export interface ResizeDragState {
  resizing: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

/**
 * @component ResizableSeparator
 * @purpose Shared vertical resize separator/handle for pane and local rail resizing.
 * @useWhen A layout split needs mouse/pointer resizing plus optional keyboard support.
 * @avoidWhen Reordering items or dragging content; this is only for resizing adjacent panes.
 * @intent Mirrors the app shell's proven behavior: pointer capture, window-level
 * move/up/cancel listeners, body col-resize cursor, disabled text selection, and
 * explicit focus after pointer down so keyboard resizing remains available.
 */
export function useResizeDrag({
  onResize,
  cursor = "col-resize",
}: ResizeDragOptions): ResizeDragState {
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    if (!resizing) return;
    const { body } = document;
    const previousCursor = body.style.cursor;
    const previousUserSelect = body.style.userSelect;
    body.style.cursor = cursor;
    body.style.userSelect = "none";
    return () => {
      body.style.cursor = previousCursor;
      body.style.userSelect = previousUserSelect;
    };
  }, [cursor, resizing]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      handle.setPointerCapture(pointerId);
      // preventDefault suppresses implicit focus in some browsers; focus the
      // handle explicitly so keyboard resizing works immediately after a drag.
      handle.focus({ preventScroll: true });
      setResizing(true);
      onResize(event.clientX, event);

      const onPointerMove = (moveEvent: PointerEvent) =>
        onResize(moveEvent.clientX, moveEvent);
      const stopResize = (upEvent: PointerEvent) => {
        onResize(upEvent.clientX, upEvent);
        setResizing(false);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", stopResize);
        window.removeEventListener("pointercancel", stopResize);
        if (handle.hasPointerCapture(pointerId))
          handle.releasePointerCapture(pointerId);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", stopResize);
      window.addEventListener("pointercancel", stopResize);
    },
    [onResize],
  );

  return { resizing, onPointerDown };
}

export interface ResizableSeparatorProps {
  label: string;
  min: number;
  max: number;
  value: number;
  resizing: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  /** Which edge of the resized panel the separator overlays. */
  edge?: "left" | "right";
  title?: string;
  className?: string;
  indicatorClassName?: string;
}

export function ResizableSeparator({
  label,
  min,
  max,
  value,
  resizing,
  onPointerDown,
  onKeyDown,
  edge = "right",
  title,
  className = "",
  indicatorClassName = "",
}: ResizableSeparatorProps) {
  return (
    <div
      role="separator"
      aria-label={`Resize ${label}`}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      title={title ?? `Drag to resize ${label}`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={`group absolute inset-y-0 z-20 flex w-2 cursor-col-resize touch-none justify-center outline-none ${edge === "right" ? "-right-1" : "-left-1"} ${className}`}
    >
      <span
        className={`my-2 w-px rounded-full transition-colors ${
          resizing
            ? "bg-primary"
            : "bg-transparent group-hover:bg-primary/70 group-focus-visible:bg-primary"
        } ${indicatorClassName}`}
      />
    </div>
  );
}
