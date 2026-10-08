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
export function useInertOverflow<T extends HTMLElement>(
  options: {
    /**
     * Before anything is dropped, try the row's compact form: the row carries
     * `data-signals-compact` (its badges drop their labels, `index.css`)
     * exactly while the full form would wrap an item away. Without it a badge
     * vanished at widths where its icon alone still fitted.
     */
    compact?: boolean;
  } = {},
): RefObject<T | null> {
  const { compact = false } = options;
  const ref = useRef<T | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  // Every commit: a child that appeared, vanished or changed width may wrap.
  // The observer then covers what changes WITHOUT a commit: the row being
  // resized (rail drag) and a child growing inside a row that keeps its box —
  // a text-scale change resizes every label at the same rail width, and a
  // memoized card does not re-render for it.
  useLayoutEffect(() => {
    const row = ref.current;
    fit(row, compact);
    if (!row || typeof ResizeObserver === "undefined") return;
    const observer = (observerRef.current ??= new ResizeObserver(() =>
      fit(ref.current, compact),
    ));
    observer.disconnect();
    observer.observe(row);
    for (const child of Array.from(row.children)) observer.observe(child);
  });
  useLayoutEffect(() => () => observerRef.current?.disconnect(), []);
  return ref;
}

function fit(row: HTMLElement | null, compact: boolean) {
  // No layout yet (detached, display:none, or a DOM without layout): leave
  // every child reachable rather than guess.
  if (!row || row.clientHeight === 0) return;
  if (compact) {
    // Measured in the full form every time, so a row that has grown back
    // wide enough gets its labels back. Both writes land before paint, and
    // the badges do not animate their size (`index.css`), so what is measured
    // is the form itself, never a frame of a transition between the two.
    row.removeAttribute("data-signals-compact");
    const compactNow = wrapped(row).some(Boolean);
    if (compactNow) row.setAttribute("data-signals-compact", "");
  }
  const marks = wrapped(row);
  Array.from(row.children).forEach((child, index) => {
    if (child instanceof HTMLElement) child.inert = marks[index] ?? false;
  });
}

/** Per child: whether it landed below the row's one visible line. */
function wrapped(row: HTMLElement): boolean[] {
  const bottom = row.getBoundingClientRect().top + row.clientHeight;
  return Array.from(row.children).map(
    (child) =>
      child instanceof HTMLElement &&
      child.getBoundingClientRect().top >= bottom - 1,
  );
}
