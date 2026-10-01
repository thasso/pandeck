import { useCallback, useState } from "react";
import type { Route } from "./useSessionRouting.ts";
import { SESSIONS_PATH } from "../lib/sessionRoutes.ts";

/** The sidebar's primary sections (one object projection or system area each). */
export type SidebarSection =
  | "sessions"
  | "tasks"
  | "projects"
  | "pull-requests"
  | "knowledge"
  | "calendar"
  | "settings";

const SIDEBAR_SECTION_KEY = "assistant.sidebarSection.v1";
/** Settings is a transient system area and is not restored across reloads. */
const PERSISTED_SECTIONS: readonly SidebarSection[] = [
  "sessions",
  "tasks",
  "projects",
  "pull-requests",
  "knowledge",
  "calendar",
];

/**
 * App-level ACTIONS that share the navigation bar with the sections. They open
 * exactly one surface each and have nothing to browse alongside it, so they are
 * not sections — but they are navigation, and the bar is where navigation lives
 * (app/web/docs/ui-shell.md). Ordering them among the sections is the user's call.
 */
const NAV_ACTIONS = [
  "new-session",
  "assistant",
  "usage",
  "background-tasks",
] as const;
export type NavAction = (typeof NAV_ACTIONS)[number];

/** One slot of the navigation bar: a section to browse, or an action to run. */
export type NavSlot = SidebarSection | NavAction;

export function isNavAction(id: NavSlot): id is NavAction {
  return (NAV_ACTIONS as readonly string[]).includes(id);
}

/**
 * Default order of the sidebar's primary-navigation bar, front (always visible)
 * to back (first to fold into More). The two actions used constantly lead, then
 * the real object browsers; Calendar sits behind them because its browser is
 * still a placeholder view list, and Settings/Usage/Background come last. Users
 * reorder this in Settings → Appearance.
 */
export const DEFAULT_NAV_SLOTS: readonly NavSlot[] = [
  "new-session",
  "assistant",
  "sessions",
  "tasks",
  "pull-requests",
  "projects",
  "knowledge",
  "calendar",
  "settings",
  "usage",
  "background-tasks",
];

/**
 * Slots a stored order may still name under an OLD id, mapped to what replaced
 * them. Renaming a slot is not the same as removing one: a user who put
 * Worktrees third has arranged their bar, and Pull Requests took that section's
 * place rather than appearing beside it. Dropping the entry would silently move
 * the replacement to its default position — and on a phone, possibly behind the
 * fold — which reads as the section having gone missing.
 */
const RENAMED_NAV_SLOTS: Record<string, NavSlot> = {
  worktrees: "pull-requests",
};

/**
 * Coerce a stored nav order to a complete, duplicate-free list: a renamed slot
 * keeps its POSITION, genuinely unknown ids are dropped so a corrupted value
 * cannot hide the navigation, and a slot the user has never seen is inserted
 * where the DEFAULT order wants it rather than appended — appending would bury
 * a newly added action behind More on a phone, where it reads as missing rather
 * than as new.
 */
export function normalizeNavSlots(value: unknown): NavSlot[] {
  const known = new Set<NavSlot>(DEFAULT_NAV_SLOTS);
  const stored = Array.isArray(value) ? value : [];
  const order: NavSlot[] = [];
  for (const entry of stored) {
    const slot =
      typeof entry === "string" && RENAMED_NAV_SLOTS[entry]
        ? RENAMED_NAV_SLOTS[entry]
        : (entry as NavSlot);
    if (known.has(slot) && !order.includes(slot)) order.push(slot);
  }
  DEFAULT_NAV_SLOTS.forEach((slot, index) => {
    if (!order.includes(slot))
      order.splice(Math.min(index, order.length), 0, slot);
  });
  return order;
}

function loadSidebarSection(): SidebarSection | null {
  try {
    const value = window.sessionStorage.getItem(SIDEBAR_SECTION_KEY);
    return PERSISTED_SECTIONS.includes(value as SidebarSection)
      ? (value as SidebarSection)
      : null;
  } catch {
    return null;
  }
}

/**
 * The canonical sidebar section for a route — every object type has exactly
 * one canonical sidebar location (app/web/docs/ui-shell.md). Action surfaces
 * without a section (Usage, the Personal Assistant, a new session) fall through
 * to Sessions.
 */
export function canonicalSidebarSection(route: Route): SidebarSection {
  switch (route.name) {
    case "tasks":
      return "tasks";
    case "projects":
      return "projects";
    case "pullRequests":
      return "pull-requests";
    // A worktree's canonical browse location is its Project page now; the
    // section that used to list them is gone.
    case "worktrees":
      return "projects";
    case "calendar":
      return "calendar";
    case "knowledge":
      return "knowledge";
    case "settings":
      return "settings";
    default:
      return "sessions";
  }
}

/**
 * The section's index route — the section addressed with no object. On small
 * screens this is the section's browser screen, and it is where an object
 * screen's back control goes (app/web/docs/ui-shell.md, Small Screens).
 */
export function sectionIndexPath(section: SidebarSection): string {
  return section === "sessions" ? SESSIONS_PATH : `/${section}`;
}

/**
 * Per-browser-tab persisted sidebar section selection. The section is shell UI
 * state decoupled from the route (ui-shell.md navigation rules): content links never move it.
 * `initial` supplies the canonical section for the entry route and applies only
 * when nothing is persisted yet (deep link with no prior sidebar state).
 */
export function useSidebarSection(
  initial: () => SidebarSection,
): [SidebarSection, (section: SidebarSection) => void] {
  const [section, setSection] = useState<SidebarSection>(
    () => loadSidebarSection() ?? initial(),
  );
  const set = useCallback((next: SidebarSection) => {
    setSection(next);
    if (!PERSISTED_SECTIONS.includes(next)) return;
    try {
      window.sessionStorage.setItem(SIDEBAR_SECTION_KEY, next);
    } catch {
      // Best-effort; the selection still applies for this session.
    }
  }, []);
  return [section, set];
}
