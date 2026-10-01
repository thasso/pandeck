/**
 * Presentation of the mobile object dock — the small-screen form of the right
 * object panel (app/web/docs/ui-shell.md, Small Screens).
 *
 * The bottom edge of a phone screen is ONE slot, and this decides who owns it:
 *
 * - `hidden` — no main-pane object to inspect (a browser screen), or the host
 *   supplies no peek row because something else owns the row (the composer on
 *   session screens, which carries the dock's handle inside its compact bar).
 * - `peek`   — a resting, NON-modal bar: the page scrolls behind it.
 * - `expanded` — the sheet, modal over the page.
 */
export type DockMode = "hidden" | "peek" | "expanded";

export function dockMode(input: {
  /** Mobile (single-pane) layout mode; the dock is a small-screen surface only. */
  mobile: boolean;
  /** The browser fills the screen, so there is no main-pane object to inspect. */
  browserScreen: boolean;
  /** The user opened the inspector (`inspectorOpen` on mobile means expanded). */
  expanded: boolean;
  /** Whether the host supplied a peek row for this screen. */
  hasPeek: boolean;
}): DockMode {
  if (!input.mobile) return "hidden";
  // Expansion outranks the missing peek row: a session screen has no peek of its
  // own (the composer's compact bar carries the handle) but still opens the sheet.
  if (input.browserScreen) return "hidden";
  if (input.expanded) return "expanded";
  return input.hasPeek ? "peek" : "hidden";
}
