import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Keeps keyboard focus in step with a one-line wrapping row.
 *
 * Inbox card rows show an item whole or not at all: the row is one line tall,
 * wraps, and hides its overflow, so whatever does not fit drops onto a hidden
 * second line. CSS cannot tell which children wrapped, so a clipped button
 * would still take Tab focus and be operated invisibly. This marks every child
 * that landed below the first line `inert` and clears it once the child fits
 * again, including when only a child's own size changed. The card's own
 * accessible name still states what those items said.
 */
export function useInertOverflow<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  // Every commit: a child that appeared, vanished or changed width may wrap.
  // The observer then covers what changes WITHOUT a commit: the row being
  // resized (rail drag) and a child growing inside a row that keeps its box —
  // a text-scale change resizes every label at the same rail width, and a
  // memoized card does not re-render for it.
  useLayoutEffect(() => {
    const row = ref.current;
    markOverflow(row);
    if (!row || typeof ResizeObserver === "undefined") return;
    const observer = (observerRef.current ??= new ResizeObserver(() =>
      markOverflow(ref.current),
    ));
    observer.disconnect();
    observer.observe(row);
    for (const child of Array.from(row.children)) observer.observe(child);
  });
  useLayoutEffect(() => () => observerRef.current?.disconnect(), []);
  return ref;
}

function markOverflow(row: HTMLElement | null) {
  // No layout yet (detached, display:none, or a DOM without layout): leave
  // every child reachable rather than guess.
  if (!row || row.clientHeight === 0) return;
  const bottom = row.getBoundingClientRect().top + row.clientHeight;
  for (const child of Array.from(row.children)) {
    if (!(child instanceof HTMLElement)) continue;
    child.inert = child.getBoundingClientRect().top >= bottom - 1;
  }
}
