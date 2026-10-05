import type { BroadcastTopic } from "@assistant/shared";
import type { SidebarSection } from "../hooks/useSidebarSection.ts";

/** The routes whose main pane reads a domain list, by name (`useSessionRouting.ts`). */
type RouteName = string;

export interface TopicSurface {
  /** Whether the sidebar's object browser is actually on screen. */
  sidebarVisible: boolean;
  /** The SELECTED section, which survives navigating away from the browser. */
  sidebarSection: SidebarSection;
  routeName: RouteName;
  /** A staged-session sheet's Task field is expanded and rendering its picker. */
  taskPickerOpen?: boolean;
  /** The workflow start sheet is open and reads usage plus worktree branches. */
  workflowStartOpen?: boolean;
  /** The Projects route has a selected document (the index does not). */
  projectSelected?: boolean;
  /** The session inspector is rendering its skills list. */
  sessionInspectorVisible?: boolean;
  /** The session inspector is on screen for a persisted session. */
  backgroundInspectorVisible?: boolean;
  /** The composer's background ledge is expanded and listing rows. */
  backgroundLedgeOpen?: boolean;
  /**
   * The settings section the main pane is RENDERING, when the route is
   * `/settings/:section`. The Skills section subscribes because subscribing
   * rescans the library on the server.
   */
  settingsSection?: string | undefined;
}

/**
 * Which domain lists this browser is showing (`BroadcastTopic`).
 *
 * A connection receives a list's broadcasts only while it declares it, so this
 * decides what a browser pays for. Two rules, and the second one is the easy
 * mistake: the main pane's ROUTE always counts, while the selected SECTION
 * counts only when the browser is visible. Section selection deliberately
 * survives navigating to an object (ui-shell.md), so a phone that opened a Task
 * and went back to a conversation still has `tasks` selected while rendering no
 * sidebar — subscribing on that would keep the large Task broadcasts flowing
 * into exactly the surface this is meant to keep quiet.
 *
 * A route-only Task detail reads Tasks, Projects and Workflow Runs but no
 * Worktree projection. A visible Sessions browser reads Workflow Runs alone. A visible Tasks sidebar retains Worktrees because its
 * comfortable/Focus rows render hosting and dirty-worktree facts. Project, Pull
 * Request and Worktree surfaces retain the same wider union — a pull request is
 * shown WITH the checkout, sessions and Tasks it is joined to, and those joins
 * arrive as ids the client resolves against exactly those lists. Staged-session
 * routes are the
 * deliberate exception: `/sessions/create` needs projects/worktrees for its
 * visible quick start, while either it or `/sessions` adds Tasks only while the
 * staged-context Task picker is expanded. Session inspector surfaces also
 * subscribe to the skills library while they render its loaded/unloaded list.
 */
export function topicsForSurface({
  sidebarVisible,
  sidebarSection,
  routeName,
  taskPickerOpen = false,
  workflowStartOpen = false,
  projectSelected = false,
  sessionInspectorVisible = false,
  backgroundInspectorVisible = false,
  backgroundLedgeOpen = false,
  settingsSection,
}: TopicSurface): BroadcastTopic[] {
  const topics = new Set<BroadcastTopic>();
  const shownSection = sidebarVisible ? sidebarSection : null;
  const taskSurface = shownSection === "tasks" || routeName === "tasks";
  const projectBrowser = shownSection === "projects";
  // Pull Requests resolves its local joins — the worktree behind a PR, the
  // sessions in it, the Tasks it implements — against the same three lists, and
  // the worktree DETAIL route is now the only worktree surface left.
  const worktreeSurface =
    shownSection === "pull-requests" ||
    routeName === "pullRequests" ||
    routeName === "worktrees";
  const selectedProjectSurface = routeName === "projects" && projectSelected;
  const projectIndexSurface = routeName === "projects" && !projectSelected;
  if (taskSurface || worktreeSurface || selectedProjectSurface) {
    topics.add("tasks");
    topics.add("projects");
    topics.add("workflow");
  }
  // A VISIBLE Sessions browser shows live Workflow Runs as items of its own
  // ([Task-676](pa://task/676)), so it holds the run topic and nothing else:
  // the run summaries and their cards are what those items are made of, while
  // the Task titles beside them stay a best-effort join on whatever Backlog
  // rows this tab already has. Subscribing to Tasks here would put the large
  // Backlog broadcasts on the session list to spell out a name.
  if (shownSection === "sessions") topics.add("workflow");
  if (projectBrowser || projectIndexSurface) topics.add("projects");
  if (
    shownSection === "tasks" ||
    projectBrowser ||
    projectIndexSurface ||
    worktreeSurface ||
    selectedProjectSurface ||
    workflowStartOpen
  )
    topics.add("worktrees");
  if (routeName === "new") {
    topics.add("projects");
    topics.add("worktrees");
    topics.add("workflow");
  }
  if (taskPickerOpen && (routeName === "new" || routeName === "sessions"))
    topics.add("tasks");
  if (shownSection === "knowledge" || routeName === "knowledge")
    topics.add("knowledge");
  // The settings BROWSER lists sections without reading any of them, so the
  // rendered section is the only thing that counts here. The session inspector
  // also reads the library to distinguish loaded from unloaded skills.
  if (
    (routeName === "settings" && settingsSection === "skills") ||
    sessionInspectorVisible
  )
    topics.add("skills");
  // Usage rides on the surfaces that show account meters — the new-session
  // provider cards, the Usage page, and the workflow start sheet's runtime
  // rows. Subscribing is what makes the server refresh at all
  // (`docs/usage.md`), so no other surface should carry it.
  if (routeName === "new" || routeName === "usage" || workflowStartOpen)
    topics.add("usage");
  // The background registry is held by its OWN route, by the one inspector
  // section that renders rows, and by the composer's ledge while it is OPEN —
  // never by the session list, which carries its own per-session
  // `backgroundActivity` projection and needs no registry at all. The ledge's
  // collapsed line reads that projection, so it subscribes only once expanded.
  if (
    routeName === "backgroundTasks" ||
    backgroundInspectorVisible ||
    backgroundLedgeOpen
  )
    topics.add("background");

  return [...topics];
}

/**
 * Whether the session inspector's Background work section holds the registry
 * topic. All four inputs must hold; each one rules out a different way of
 * paying for a snapshot that renders nothing.
 *
 * Deliberately NOT a function of `SessionListItem.backgroundActivity` or of
 * rows this tab already happens to hold. A cold direct load of a session whose
 * background work has all FINISHED has neither — activity is only present while
 * something is nonterminal — so gating on either makes the section's Recent list
 * depend on this browser having watched the work end. The user would open the
 * same session twice and see two different histories.
 *
 * `sessionExists` is the input that must NOT be dropped for looking redundant.
 * A route id is whatever is in the address bar: any nonempty string parses as a
 * session route, so `/sessions/does-not-exist` would otherwise subscribe and be
 * handed the entire global snapshot for a session that was never real. An id
 * being present and an id being a SESSION are different questions, and ONLY the
 * authoritative session list answers the second. The loaded session does NOT:
 * the server answers a view of an unknown id with a placeholder carrying that
 * same id, so reading it re-opens exactly this hole.
 *
 * The cost of a legitimate subscribe is one registry snapshot per inspected
 * session rather than per inspected session that happens to be busy. That
 * snapshot is not bounded by this decision and never was
 * (`backgroundWorkRegistry.ts` sends every live row): subscribing less often
 * reduces how OFTEN it is paid, never its size.
 */
export function backgroundInspectorSubscribes(input: {
  routeName: RouteName;
  /** The session the route addresses; absent for a draft or a non-session route. */
  sessionId?: string | undefined;
  /**
   * That id is in the authoritative session LIST — the only membership answer.
   * Never derive this from the loaded session, which the server also populates
   * for an id that does not exist. A bad or stale deep link fails here rather
   * than at the server.
   */
  sessionExists: boolean;
  /** The inspector is actually on screen (a phone hides it behind the composer). */
  inspectorVisible: boolean;
}): boolean {
  return (
    input.inspectorVisible &&
    input.routeName === "session" &&
    Boolean(input.sessionId) &&
    input.sessionExists
  );
}
