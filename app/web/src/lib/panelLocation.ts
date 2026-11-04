import type { WorktreeView } from "../hooks/useSessionRouting.ts";

/**
 * Where inside a worktree a right panel is looking. The same four coordinates
 * the `/worktrees/:id` route carries in its URL, held as panel state instead:
 * the panel reads a worktree BESIDE whatever the main pane is on, so the URL
 * keeps naming the main pane's object. Kept in `sessionStorage`, so a reload
 * reopens the panel where it was.
 */
export interface PanelLocation {
  view: WorktreeView;
  path?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/** The most worktrees the Worktree panel remembers a location for. */
const MAX_REMEMBERED_WORKTREES = 20;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function decodePanelLocation(value: unknown): PanelLocation | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.view !== "files" && record.view !== "changes") return null;
  return {
    view: record.view,
    path: optionalString(record.path),
    from: optionalString(record.from),
    to: optionalString(record.to),
  };
}

export function decodeStoredPanelLocation(raw: string): PanelLocation | null {
  return decodePanelLocation(JSON.parse(raw));
}

/** Locations by worktree id, oldest first. */
export type PanelLocations = Record<string, PanelLocation>;

export function decodeStoredPanelLocations(raw: string): PanelLocations | null {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) return null;
  const locations: PanelLocations = {};
  for (const [id, stored] of Object.entries(value)) {
    const location = decodePanelLocation(stored);
    if (location) locations[id] = location;
  }
  return locations;
}

/** `locations` with `id` moved to `location`, newest last, the oldest dropped past the cap. */
export function withPanelLocation(
  locations: PanelLocations,
  id: string,
  location: PanelLocation,
): PanelLocations {
  const entries = Object.entries(locations).filter(([key]) => key !== id);
  entries.push([id, location]);
  return Object.fromEntries(entries.slice(-MAX_REMEMBERED_WORKTREES));
}
