import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

/** The band at either end of the scroller that drags the list along with it. */
const EDGE_BAND_PX = 56;
/** Scroll speed at the very edge of that band, per frame. */
const EDGE_SPEED_PX = 14;
/** Travel that separates a drag from a press resting on the grip. */
const TRAVEL_PX = 3;

/** The nearest ancestor that actually scrolls vertically, or null for the page. */
function scrollerFor(element: Element): HTMLElement | null {
  for (
    let node = element.parentElement;
    node && node !== document.body;
    node = node.parentElement
  ) {
    const overflow = getComputedStyle(node).overflowY;
    if (
      /(auto|scroll|overlay)/.test(overflow) &&
      node.scrollHeight > node.clientHeight
    )
      return node;
  }
  return null;
}

/**
 * Reorder a list by dragging a handle, with a pointer gesture rather than HTML5
 * drag-and-drop.
 *
 * Native `draggable` is mouse-only — a touch never produces `dragstart`, so a
 * phone cannot reorder at all — and it also cancels the drag in Chromium when
 * the dragged node is restyled or moved while the gesture runs, which is
 * exactly what reordering live does. Pointer events have neither problem and
 * cover mouse, touch and pen through one path.
 *
 * `listRef` goes on the element whose DIRECT children are the rows, in `items`
 * order: the drop target is hit-tested against those boxes, so a wrapper
 * between the list and its rows would misplace every move. Holding the pointer
 * at either end of the enclosing scroller pulls the list past the fold, which
 * on touch is the only way to reach a row off screen — the gesture owns the
 * finger, so nothing else can scroll there.
 *
 * `onReorder` runs per move with the arrangement under the pointer (the caller
 * holds it as a working copy so the list follows the finger) and must store
 * that exact array: `items` arriving as an array the gesture never handed out
 * is the list being replaced from outside, and the gesture retires rather than
 * saving over it.
 * `onCommit` runs once the gesture ends, and only when the order changed; it
 * is handed the item that moved, which is what an announcement needs.
 */
export function usePointerReorder<T>({
  items,
  keyOf,
  onReorder,
  onCommit,
}: {
  items: T[];
  keyOf: (item: T) => string;
  onReorder: (next: T[]) => void;
  onCommit: (next: T[], moved: T) => void;
}): {
  listRef: RefObject<HTMLUListElement | null>;
  /** The row being dragged, for the lifted styling; null between gestures. */
  draggingKey: string | null;
  handleProps: (index: number) => {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
    style: { touchAction: "none"; WebkitTouchCallout: "none" };
  };
} {
  const listRef = useRef<HTMLUListElement | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);

  // The gesture outlives any single render, and pointer moves arrive faster
  // than React commits, so everything it reads goes through a ref. `itemsRef`
  // is the arrangement the gesture is working on: each move advances it
  // immediately, ahead of the render that will catch up.
  const itemsRef = useRef(items);
  const keyOfRef = useRef(keyOf);
  keyOfRef.current = keyOf;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const dragRef = useRef<{ key: string; pointerId: number } | null>(null);
  const startItemsRef = useRef<T[]>(items);
  const startOrderRef = useRef<string>("");
  const pointerYRef = useRef(0);
  const startYRef = useRef(0);
  const travelledRef = useRef(false);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<number | null>(null);

  // Every array this gesture has handed out, plus the one it started from.
  // Provenance cannot be judged from a single identity: a render carrying the
  // array from BEFORE the move in flight is ordinary React, not an outside
  // edit, and retiring on that would drop a perfectly good drag.
  const mineRef = useRef<Set<T[]>>(new Set());

  if (!dragRef.current) itemsRef.current = items;
  else if (!mineRef.current.has(items)) {
    // Replaced from OUTSIDE the gesture (a settings echo, a refresh, a row
    // hidden elsewhere), and that list is authoritative: the arrangement under
    // the pointer is about a list that no longer exists, so the drag retires
    // here — without saving, and without a later release writing it back.
    dragRef.current = null;
    itemsRef.current = items;
    setDraggingKey(null);
  }

  const apply = useCallback((next: T[]) => {
    itemsRef.current = next;
    mineRef.current.add(next);
    onReorderRef.current(next);
  }, []);

  const move = useCallback((from: number, to: number): T[] | null => {
    const current = itemsRef.current;
    if (from < 0 || to < 0 || from >= current.length || to >= current.length)
      return null;
    if (from === to) return null;
    const next = [...current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    return next;
  }, []);

  /** The row whose box holds `clientY`; null in a gap, clamped past the ends. */
  const rowIndexAt = useCallback((clientY: number): number | null => {
    const rows = Array.from(listRef.current?.children ?? []);
    if (rows.length === 0) return null;
    const first = rows[0]!.getBoundingClientRect();
    if (clientY < first.top) return 0;
    const last = rows[rows.length - 1]!.getBoundingClientRect();
    if (clientY > last.bottom) return rows.length - 1;
    for (let i = 0; i < rows.length; i++) {
      const box = rows[i]!.getBoundingClientRect();
      if (clientY >= box.top && clientY <= box.bottom) return i;
    }
    return null;
  }, []);

  /** Put the dragged row where the pointer is now. Re-run after any scroll. */
  const steer = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    const from = itemsRef.current.findIndex(
      (item) => keyOfRef.current(item) === drag.key,
    );
    const to = rowIndexAt(pointerYRef.current);
    if (to === null) return;
    const next = move(from, to);
    if (next) apply(next);
  }, [apply, move, rowIndexAt]);

  const stopAutoScroll = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  useEffect(() => {
    if (!draggingKey) return;
    // Held at an edge, the scroller keeps moving frame by frame and the row is
    // re-placed after each step: without this a phone cannot reach any row off
    // screen, since the gesture has taken the finger away from scrolling.
    const scroll = () => {
      frameRef.current = requestAnimationFrame(scroll);
      // A press that has not moved is not a drag. Without this, a grip that
      // happens to sit in the edge band scrolls the list — and reorders the row
      // it belongs to — for as long as a finger rests on it.
      if (!travelledRef.current) return;
      const scroller = scrollerRef.current;
      const box = scroller?.getBoundingClientRect();
      const top = box ? box.top : 0;
      const bottom = box ? box.bottom : window.innerHeight;
      const y = pointerYRef.current;
      const past = y - (bottom - EDGE_BAND_PX);
      const before = top + EDGE_BAND_PX - y;
      const reach = past > 0 ? past : before > 0 ? -before : 0;
      if (reach === 0) return;
      const at = scroller ? scroller.scrollTop : window.scrollY;
      const max = scroller
        ? scroller.scrollHeight - scroller.clientHeight
        : document.documentElement.scrollHeight - window.innerHeight;
      const by =
        Math.sign(reach) *
        Math.ceil(Math.min(Math.abs(reach) / EDGE_BAND_PX, 1) * EDGE_SPEED_PX);
      const to = Math.max(0, Math.min(Math.max(max, 0), at + by));
      // Nothing to scroll (or already at the end) is the common case: the row
      // simply stops at the edge, and no scroll call is made.
      if (to === at) return;
      if (scroller) scroller.scrollTop = to;
      else window.scrollTo(window.scrollX, to);
      steer();
    };

    const finish = (mode: "commit" | "cancel", key: string) => {
      dragRef.current = null;
      stopAutoScroll();
      setDraggingKey(null);
      if (mode === "cancel") {
        // A cancelled pointer (a system gesture taking over, a phone call) is
        // not an arrangement anyone chose: put the list back rather than
        // leaving it showing an order that was never saved.
        apply(startItemsRef.current);
        return;
      }
      const order = itemsRef.current
        .map((item) => keyOfRef.current(item))
        .join("\n");
      const moved = itemsRef.current.find(
        (item) => keyOfRef.current(item) === key,
      );
      if (order !== startOrderRef.current && moved)
        onCommitRef.current(itemsRef.current, moved);
    };

    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      if (Math.abs(event.clientY - startYRef.current) > TRAVEL_PX)
        travelledRef.current = true;
      pointerYRef.current = event.clientY;
      // A mouse released outside the window delivers no `pointerup` at all; the
      // next move back over the page, with no button down, is the first news of
      // it. Without this the row would keep following an unpressed cursor.
      if (event.pointerType === "mouse" && event.buttons === 0) {
        finish("commit", drag.key);
        return;
      }
      steer();
    };
    const onEnd = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      finish(event.type === "pointerup" ? "commit" : "cancel", drag.key);
    };
    // A window losing focus mid-drag (alt-tab, the OS taking over) may send no
    // pointer event at all, and a gesture nobody can end is a stuck row.
    const onBlur = () => {
      const drag = dragRef.current;
      if (drag) finish("cancel", drag.key);
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    window.addEventListener("blur", onBlur);
    frameRef.current = requestAnimationFrame(scroll);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("blur", onBlur);
      stopAutoScroll();
    };
  }, [draggingKey, apply, steer, stopAutoScroll]);

  const handleProps = useCallback(
    (index: number) => ({
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        const item = itemsRef.current[index];
        // One gesture at a time: a second finger landing on another grip would
        // otherwise take the drag over and strand the first, whose release then
        // ends nothing. `isPrimary` keeps a multi-touch pinch out of it too.
        if (!item || dragRef.current || event.button !== 0 || !event.isPrimary)
          return;
        // Keeps the press from selecting the text it started on. Focus is left
        // alone: the grip is a real button that tabs and takes arrow keys, and
        // focusing it here would paint a keyboard ring through a mouse drag.
        event.preventDefault();
        dragRef.current = {
          key: keyOfRef.current(item),
          pointerId: event.pointerId,
        };
        pointerYRef.current = event.clientY;
        startYRef.current = event.clientY;
        travelledRef.current = false;
        mineRef.current = new Set([itemsRef.current]);
        scrollerRef.current = listRef.current
          ? scrollerFor(listRef.current)
          : null;
        startItemsRef.current = itemsRef.current;
        startOrderRef.current = itemsRef.current
          .map((entry) => keyOfRef.current(entry))
          .join("\n");
        setDraggingKey(keyOfRef.current(item));
      },
      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
        const item = itemsRef.current[index];
        if (!item) return;
        const delta =
          event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
        if (delta === 0) return;
        const next = move(index, index + delta);
        if (!next) return;
        // The page scrolls on arrows otherwise, dragging the row out of view.
        event.preventDefault();
        apply(next);
        onCommitRef.current(next, item);
      },
      // The handle alone opts out of panning, so the rest of the row still
      // scrolls the page; the callout is iOS's long-press menu, which would
      // otherwise interrupt a slow drag there.
      style: {
        touchAction: "none" as const,
        WebkitTouchCallout: "none" as const,
      },
    }),
    [apply, move],
  );

  return { listRef, draggingKey, handleProps };
}
