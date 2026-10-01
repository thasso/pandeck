/**
 * Pure sizing math for the AppShell side panels. Kept framework-free so the
 * clamp behavior is unit-testable and reusable by anything that needs to
 * mirror the shell's effective panel widths.
 */

/** Minimum width the main pane keeps when side panels grow. */
export const MAIN_MIN_WIDTH = 360;

/** Current viewport width with an SSR-safe fallback. */
export function viewportWidth(): number {
  return typeof window === "undefined" ? 1024 : window.innerWidth;
}

/**
 * Largest width a side panel may take: everything except the main pane's
 * minimum and any width already reserved by the opposite panel. Never below
 * the panel's own minimum, so a too-small viewport degrades predictably.
 */
export function maxPanelWidth(
  minWidth: number,
  viewport: number,
  reservedWidth = 0,
): number {
  return Math.max(minWidth, viewport - reservedWidth - MAIN_MIN_WIDTH);
}

/** Clamp a requested panel width into [minWidth, maxPanelWidth]. */
export function clampPanelWidth(
  width: number,
  minWidth: number,
  viewport: number,
  reservedWidth = 0,
): number {
  return Math.min(
    Math.max(Math.round(width), minWidth),
    maxPanelWidth(minWidth, viewport, reservedWidth),
  );
}
