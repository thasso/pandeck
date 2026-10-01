import type { KeyboardEvent } from "react";

/**
 * Keep a Tab press inside a portaled surface. A modal painted over the page is
 * a sibling of everything else in the DOM, so without this the next Tab walks
 * out of it into the transcript underneath, and the next Escape reaches
 * whatever lives there instead of the surface. Called from the surface's own
 * `onKeyDown` for `Tab`: forward from the last control wraps to the first, and
 * backward from the first control — or from the surface itself, which is
 * "before the first" — wraps to the last. Any other position is left to the
 * browser's normal order within the surface.
 */
export function wrapTabWithin(
  event: KeyboardEvent,
  surface: HTMLElement | null,
  focusable: string,
): void {
  if (event.key !== "Tab" || !surface) return;
  const controls = [...surface.querySelectorAll<HTMLElement>(focusable)];
  const first = controls[0];
  const last = controls.at(-1);
  if (!first || !last) return;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === surface)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
