import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import type {
  ProjectRecord,
  PullRequestInventoryItem,
  SessionListItem,
  WorkflowRunCard,
  WorkflowRunSummary,
  WorktreeGitStatus,
  WorktreeRecord,
} from "@assistant/shared";
import { isShelvedSession } from "@assistant/shared";
import { PullRequestBrowser } from "./PullRequestBrowser.tsx";
import type { PullRequestTarget } from "../lib/pullRequestInbox.ts";
import { SessionInbox } from "./SessionInbox.tsx";
import { BacklogList } from "./BacklogList.tsx";
import { ProjectTreePane } from "./ProjectTreePane.tsx";
import { KnowledgeBrowser } from "./KnowledgeBrowser.tsx";
import { navigableSettingsGroups } from "./settingsSections.tsx";
import { PRIMARY_NAV_SLOTS } from "./primaryNavSections.tsx";
import {
  NAV_CARD_INSET,
  PrimaryNav,
  type PrimaryNavSection,
} from "./shell/PrimaryNav.tsx";
import type { Task, TaskPlacement } from "../lib/backlogTree.ts";
import type { AssistantActions } from "../hooks/useAssistant.ts";
import type { BacklogState } from "../hooks/useBacklog.ts";
import { SIDEBAR_BACKLOG_DENSITY } from "../lib/backlogTreeModel.ts";
import type { LoadState } from "../lib/loadState.ts";
import type { WorktreeHostingMap } from "../lib/worktreeHosting.ts";
import type { DirtyWorktrees } from "../lib/worktreeDirty.ts";
import {
  NO_WORKTREE_STATUSES,
  rowWorktreeStatus,
} from "../lib/worktreeRowStatuses.ts";
import type { WorkflowIndicators } from "../lib/workflowIndicator.ts";
import { useListScroll } from "../hooks/useListScroll.ts";
import { useWorktreeWatches } from "../hooks/useWorktreeWatches.ts";
import { usePerfRenderCount } from "../lib/perfStats.ts";
import type { Prefs } from "../hooks/usePrefs.ts";
import type { SettingsSection } from "../hooks/useSessionRouting.ts";
import {
  isNavAction,
  type NavAction,
  type NavSlot,
  type SidebarSection,
} from "../hooks/useSidebarSection.ts";

interface Props {
  sessions: SessionListItem[];
  archivedSessionCount: number;
  archivedSessionsLoaded: boolean;
  currentId: string | undefined;
  /** The viewed session after the app-level read dwell has elapsed. */
  readCurrentId: string | undefined;
  onSelect: (id: string) => void;
  /** Archive (archived=true) or restore (archived=false) a session. */
  onArchive: (id: string, archived: boolean) => void;
  /**
   * Settle a session out of the Sessions inbox working set (`settled=true`) or
   * bring it back. Distinct from archive: the session stays in the list.
   */
  onSettleSession: (id: string, settled: boolean) => void;
  /** Rename a session from the inbox card's overflow menu. The caller prompts. */
  onRenameSession: (id: string) => void;
  /** Delete a session from the focused row (`#` / Delete). The caller confirms. */
  onDeleteSession: (id: string) => void;
  /** Fetch archived session rows when the archived section is expanded. */
  onLoadArchivedSessions: () => void;
  /**
   * Bumping this token moves keyboard focus into the session list (active row
   * if any, otherwise the first row). Used when the user opens the Sessions
   * surface via the header Sessions button.
   */
  focusToken?: number;
  /** The selected primary section; owned by the app shell (useSidebarSection). */
  section: SidebarSection;
  /** User selected a primary section. */
  onSectionChange: (section: SidebarSection) => void;
  /**
   * User picked one of the app-level actions that share the navigation bar with
   * the sections (New Session, the Personal Assistant, Usage). They just navigate;
   * the sidebar itself does not change (ui-shell.md).
   */
  onNavAction: (action: NavAction) => void;
  /** Open the background-work registry from the inbox's global running line. */
  onOpenBackgroundTasks: () => void;
  /** Configured name of the singleton Personal Assistant, used as its slot label. */
  assistantLabel: string;
  /** Mobile (single-pane) layout: the sidebar renders as a full-screen overlay. */
  mobile: boolean;
  /** Open a calendar view for today from the minimal calendar browser. */
  onOpenCalendarView: (view: "month" | "week" | "day") => void;
  /** Hover "+" on task rows: start a session with that task as context. */
  /** Hover "+" on project rows: start a session with that project as context. */
  onStartSessionForProject: (id: string) => void;
  /** Whether each cached-capable list answered in this socket episode. */
  tasksFresh: boolean;
  projectsFresh: boolean;
  worktreesFresh: boolean;
  /** Task id currently open in the Task detail route, for highlighting. */
  selectedTaskId?: string | null;
  /** Fetch the Backlog list when no active topic subscription owns the read. */
  onLoadBacklog: () => void;
  /** A fresh tasks/projects/worktrees subscription is already reading these slots. */
  domainListsSubscribed?: boolean;
  /** Open a Task's detail (navigates to the Task detail route). */
  onOpenTask: (id: string) => void;
  /** A Task row's gutter action: open the session its work happens in. */
  onOpenSessionForTask: (sessionId: string) => void;
  /** Follow one of the links a Task row's second line draws (`TaskRowBody`). */
  onNavigate: (path: string) => void;
  /** …or start one, for a Task that has none yet. */
  onStartSessionForTask: (taskId: string, title: string) => void;
  /** Advance a Task's status (task → doing → done → task). */
  onCycleTaskStatus: (item: Task) => void;
  /** Persist a Backlog reorder (drag-and-drop in the Tasks section). */
  onReorderTasks: (orderedIds: string[], placements: TaskPlacement[]) => void;
  /** Project registry records for the Projects section. */
  projects: ProjectRecord[];
  /** Whether the Projects list has been fetched at least once. */
  projectsLoaded: boolean;
  projectMutations?: Record<string, LoadState<true>>;
  /** Project id currently open in the Project detail route, for highlighting. */
  selectedProjectId?: string | null;
  /** Fetch the Project registry list (called when the Projects section is shown and unloaded). */
  onLoadProjects: () => void;
  /** Persist a Project reorder/nesting change. */
  onReorderProjects: (
    orderedIds: string[],
    placements: { id: string; parentId?: string | null }[],
  ) => void;
  /** Open a Project's detail route. */
  onOpenProject: (id: string) => void;
  /** All known worktrees; null until first fetched. */
  worktrees: WorktreeRecord[] | null;
  /** Live git status per worktree id: what THIS socket episode observed. */
  worktreeStatuses: Record<string, WorktreeGitStatus>;
  /**
   * What git last said about each worktree, from the shell cache. Read by the
   * Projects tree's rows ALONE, so they paint at their real height on a cold
   * open; no surface that decides an ACTION from a status may read it
   * (`lib/worktreeRowStatuses.ts`).
   */
  lastKnownWorktreeStatuses?: Record<string, WorktreeGitStatus>;
  /**
   * The app's per-worktree PR/CI projection (`hooks/useWorktreeHosting.ts`): a
   * `comfortable` Task row states it as one delivery chip. It is app state
   * rather than this browser's own fetch — two pollers for one projection would
   * double the provider traffic and let the surfaces disagree.
   */
  worktreeHosting: WorktreeHostingMap;
  /**
   * The worktrees with uncommitted changes (`hooks/useDirtyWorktrees.ts`), for
   * the dirty dot on a two-line Task row. A DERIVED slice rather than the
   * statuses record this component already takes for its other browsers: those
   * re-render with the sidebar, while the Backlog under it is memoized and must
   * not repaint 226 rows every time a watcher reports a file count.
   */
  dirtyWorktrees: DirtyWorktrees;
  /** Active/paused Workflow Run markers per Task. */
  workflowIndicators: WorkflowIndicators;
  /**
   * Every Workflow Run, for the Sessions inbox's run items; null before the
   * first snapshot. The Backlog's own rows read the narrower
   * {@link Props.workflowIndicators} instead, which is what keeps 226 memoized
   * Task rows off every run broadcast.
   */
  workflowRuns: WorkflowRunSummary[] | null;
  /** The recipe projections by run id, as the server broadcasts them. */
  workflowCards: Record<string, WorkflowRunCard>;
  /** Open one Workflow Run on its Task, anchored at that run's own card. */
  onOpenWorkflowRun: (taskId: string, runId: string) => void;
  /** Settle one Workflow Run out of the Sessions inbox working set. */
  onSettleWorkflowRun: (runId: string, throughRevision: number) => void;
  /** The app's pull-request inventory (`hooks/usePullRequestInventory.ts`). */
  pullRequestInventory: LoadState<PullRequestInventoryItem[]>;
  /** Retry that read, behind the browser's inline failure. */
  onReloadPullRequests: () => void;
  /** The pull request open in the detail route, for highlighting. */
  selectedPullRequest?: PullRequestTarget | null;
  /** Open one pull request's detail route. */
  onOpenPullRequest: (target: PullRequestTarget) => void;
  /** Worktree id currently open in the detail route, for highlighting. */
  selectedWorktreeId?: string | null;
  /** Knowledge entry id currently open in the Knowledge route, for highlighting. */
  selectedKnowledgeEntryId?: string | null;
  /** Folder path of a path-addressed (invalid) Knowledge entry open in the route. */
  selectedKnowledgeEntryPath?: string | null;
  /** Tree path of a non-entry Knowledge file (asset/loose) open in the route. */
  selectedKnowledgeFilePath?: string | null;
  /** Open a Knowledge entry detail route. */
  onOpenKnowledgeEntry: (entryId: string) => void;
  /** Open an invalid Knowledge entry (no `kb.id`) by folder path. */
  onOpenInvalidKnowledgeEntry?: (path: string) => void;
  /** Open a non-entry Knowledge file (entry asset or loose file) by tree path. */
  onOpenKnowledgeFile?: (path: string) => void;
  /** Newest committed KB change heard about, so the tree refetches instead of going stale. */
  knowledgeChangedAt?: number;
  /** Fetch the worktree list (called when a section that joins worktrees is shown). */
  onLoadWorktrees: () => void;
  /** Open a worktree's detail route. */
  onOpenWorktree: (id: string) => void;
  /** Hover "+" on worktree rows: start a session executing in that worktree. */
  onStartSessionInWorktree: (id: string) => void;
  /** Settings section currently active, for highlighting in the settings list. */
  activeSection?: SettingsSection | null;
  /** Called when a settings section is selected from the sidebar. */
  onOpenSection?: (section: SettingsSection) => void;
  /** The Backlog slices the Tasks section's shared list/controls read. */
  state: BacklogState;
  actions: AssistantActions;
  prefs: Prefs;
  onUpdatePrefs: (patch: Partial<Prefs>) => void;
}

/**
 * Minimal calendar browser: the calendar's sidebar shape is not designed yet
 * (ui-shell.md allows shipping a minimal browser), so it only offers today's
 * views.
 */
function CalendarBrowser({
  onOpenView,
}: {
  onOpenView: (view: "month" | "week" | "day") => void;
}) {
  const views = [
    { id: "month" as const, label: "Month view" },
    { id: "week" as const, label: "Week view" },
    { id: "day" as const, label: "Today" },
  ];
  return (
    <div className="flex flex-col gap-0.5">
      {views.map((view) => (
        <button
          key={view.id}
          type="button"
          onClick={() => onOpenView(view.id)}
          className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-caption font-medium text-muted transition-colors hover:bg-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">
            <CalendarDays size={15} />
          </span>
          {view.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Which worktrees the visible browser needs live git status for: every listed
 * worktree in the Projects browser, and only the ones the Sessions inbox's own
 * cards reference. Sorted so the set has a stable identity.
 *
 * The Pull Requests browser is absent on purpose: its rows say only THAT a
 * local checkout exists, which is on the inventory already. The detail page is
 * what states that checkout's dirt and drift, and App holds the one watch it
 * needs beside the route that opened it.
 *
 * The Backlog is absent on purpose. Its Task rows carry a dirty marker too, but
 * the SAME rows are also on a project page, which this component never renders
 * — so App holds those watches beside the projection they belong with
 * (`hooks/useWorktreeWatches.ts`), and a phone with the sidebar closed keeps
 * them.
 */
export function sidebarWorktreeWatchIds(
  section: SidebarSection,
  sessions: SessionListItem[],
  visibleProjectWorktreeIds: string[],
): string[] {
  if (section === "projects") return visibleProjectWorktreeIds;
  if (section !== "sessions") return [];
  const ids = new Set<string>();
  for (const session of sessions) {
    if (!session.archived && session.worktreeId && !isShelvedSession(session)) {
      ids.add(session.worktreeId);
    }
  }
  return [...ids].sort();
}

function SettingsSectionList({
  activeSection,
  onOpenSection,
}: {
  activeSection?: SettingsSection | null | undefined;
  onOpenSection?: ((section: SettingsSection) => void) | undefined;
}) {
  return (
    <div className="flex flex-col gap-4">
      {navigableSettingsGroups().map((group) => (
        <section key={group.id} aria-labelledby={`settings-group-${group.id}`}>
          <h2
            id={`settings-group-${group.id}`}
            className="px-2.5 pb-1 text-micro font-semibold uppercase tracking-wide text-faint"
          >
            {group.label}
          </h2>
          <div className="flex flex-col gap-0.5">
            {group.sections.map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => onOpenSection?.(section.id)}
                className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  activeSection === section.id
                    ? "bg-accent-soft text-fg"
                    : "text-muted hover:bg-raised hover:text-fg"
                }`}
              >
                <span
                  className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${activeSection === section.id ? "bg-surface text-accent" : "bg-raised text-muted"}`}
                >
                  {section.icon}
                </span>
                <span className="text-caption font-medium">
                  {section.label}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * @component Sidebar
 * @purpose Global left navigation surface, split per app/web/docs/ui-shell.md into
 * the selected section's object browser and, pinned below it, the primary
 * navigation bar (Sessions/Tasks/Worktrees/Projects/Knowledge/Calendar/Settings).
 * @useWhen The app shell needs the left navigation rail (desktop inline panel or mobile full-screen overlay).
 * @avoidWhen Showing active-session context; use the session inspector for that. Not a layout decoration — it is a destination surface.
 * @intent Single scroll owner for the browser zone, which takes all the height the
 * nav bar does not need; the bar sits at the bottom so it is thumb-reachable on
 * mobile. Section selection is owned by the app shell (useSidebarSection) and
 * decoupled from the route; this component only renders and reports selection.
 * @perf Memoized, and it must stay that way: this is the left pane of EVERY
 * screen, so without it the Backlog's ~220 rows and every other browser
 * re-render on each streamed transcript token. That only holds while its props
 * are referentially stable — App keeps its handlers `useCallback`ed and hands
 * over the narrow `BacklogState` instead of the whole `UIState`.
 */
function SidebarImpl({
  sessions,
  archivedSessionCount,
  archivedSessionsLoaded,
  currentId,
  readCurrentId,
  onSelect,
  onArchive,
  onSettleSession,
  onRenameSession,
  onDeleteSession,
  onLoadArchivedSessions,
  focusToken,
  section,
  onSectionChange,
  onNavAction,
  onOpenBackgroundTasks,
  assistantLabel,
  mobile,
  onOpenCalendarView,
  onStartSessionForProject,
  tasksFresh,
  projectsFresh,
  worktreesFresh,
  selectedTaskId,
  onLoadBacklog,
  domainListsSubscribed = false,
  onOpenTask,
  onOpenSessionForTask,
  onStartSessionForTask,
  onNavigate,
  projects,
  projectsLoaded,
  projectMutations = {},
  selectedProjectId,
  onLoadProjects,
  onReorderProjects,
  onOpenProject,
  worktrees,
  worktreeStatuses,
  lastKnownWorktreeStatuses = NO_WORKTREE_STATUSES,
  worktreeHosting,
  dirtyWorktrees,
  workflowIndicators,
  workflowRuns,
  workflowCards,
  onOpenWorkflowRun,
  onSettleWorkflowRun,
  pullRequestInventory,
  onReloadPullRequests,
  selectedPullRequest,
  onOpenPullRequest,
  selectedWorktreeId,
  selectedKnowledgeEntryId,
  selectedKnowledgeEntryPath,
  selectedKnowledgeFilePath,
  onOpenKnowledgeEntry,
  onOpenInvalidKnowledgeEntry,
  onOpenKnowledgeFile,
  knowledgeChangedAt,
  onLoadWorktrees,
  onOpenWorktree,
  onStartSessionInWorktree,
  activeSection,
  onOpenSection,
  state,
  actions,
  prefs,
  onUpdatePrefs,
}: Props) {
  usePerfRenderCount("Sidebar");
  const containerRef = useRef<HTMLElement | null>(null);
  // One scroll container serves every browser, so the reading position is
  // remembered PER SECTION: switching sections would otherwise open the next one
  // at the offset the last one was left at, and on a phone the whole sidebar is
  // unmounted the moment an object screen opens.
  const browserScrollRef = useListScroll({ listKey: `sidebar:${section}` });

  // Fetch Backlog Tasks, Projects, or Worktrees the first time the matching
  // section is shown. The Projects browser also embeds worktrees, so it needs
  // the worktree list and live statuses too, and the Sessions inbox joins both
  // to resolve each card's Project/Worktree metadata without per-card requests.
  const requestedLists = useRef({
    tasks: false,
    projects: false,
    worktrees: false,
  });
  useEffect(() => {
    if (!state.connected) {
      requestedLists.current = {
        tasks: false,
        projects: false,
        worktrees: false,
      };
      return;
    }
    // A fresh topic subscription is the read and will replace cached lists in
    // place; sending these one-off commands too would duplicate the payloads.
    if (domainListsSubscribed) return;
    // The Sessions inbox joins Tasks too (a card names the ONE Task it
    // belongs to), so it takes the same one-off load — not a subscription.
    // The Pull Requests browser resolves its Task joins against the same list,
    // so it takes the same ONE-OFF load the Tasks and Sessions sections make.
    if (
      (section === "tasks" ||
        section === "sessions" ||
        section === "pull-requests") &&
      !tasksFresh &&
      !requestedLists.current.tasks
    ) {
      requestedLists.current.tasks = true;
      onLoadBacklog();
    }
    if (
      (section === "tasks" ||
        section === "projects" ||
        section === "pull-requests" ||
        section === "sessions") &&
      !projectsFresh &&
      !requestedLists.current.projects
    ) {
      requestedLists.current.projects = true;
      onLoadProjects();
    }
    if (
      (section === "projects" ||
        section === "pull-requests" ||
        section === "sessions") &&
      !worktreesFresh &&
      !requestedLists.current.worktrees
    ) {
      requestedLists.current.worktrees = true;
      onLoadWorktrees();
    }
  }, [
    section,
    state.connected,
    domainListsSubscribed,
    tasksFresh,
    onLoadBacklog,
    projectsFresh,
    onLoadProjects,
    worktreesFresh,
    onLoadWorktrees,
  ]);

  const activeProjects = useMemo(
    () => projects.filter((project) => project.status !== "archived"),
    [projects],
  );
  const [visibleProjectWorktreeIds, setVisibleProjectWorktreeIds] = useState<
    string[]
  >([]);
  // `ProjectTreePane` rebuilds this list on every tree rebuild, so a list
  // rebroadcast hands back the same ids in a fresh array. Keep the PREVIOUS
  // array when the ids are unchanged: React then bails out of the re-render
  // entirely, and the set below stays referentially stable for its consumers.
  const onVisibleProjectWorktreeIds = useCallback((ids: string[]) => {
    setVisibleProjectWorktreeIds((current) =>
      current.length === ids.length && current.every((id, i) => id === ids[i])
        ? current
        : ids,
    );
  }, []);
  const visibleProjectWorktreeSet = useMemo(
    () => new Set(visibleProjectWorktreeIds),
    [visibleProjectWorktreeIds],
  );
  const projectSessionCache = useRef<{
    key: string;
    value: SessionListItem[];
  }>({ key: "", value: [] });
  const activeProjectIds = new Set(activeProjects.map((project) => project.id));
  const projectWorktrees = (worktrees ?? []).filter((worktree) =>
    activeProjectIds.has(worktree.projectId),
  );
  const projectWorktreeIds = new Set(
    projectWorktrees.map((worktree) => worktree.id),
  );
  const projectSessionIds = new Set(
    projectWorktrees.flatMap((worktree) => worktree.sessionIds),
  );
  const projectSessions = sessions.filter(
    (session) =>
      projectSessionIds.has(session.id) ||
      (session.projectId && activeProjectIds.has(session.projectId)) ||
      (session.worktreeId && projectWorktreeIds.has(session.worktreeId)),
  );
  const projectSessionKey = JSON.stringify(projectSessions);
  if (projectSessionCache.current.key !== projectSessionKey)
    projectSessionCache.current = {
      key: projectSessionKey,
      value: projectSessions,
    };
  const projectStatusCache = useRef<{
    key: string;
    value: Record<string, WorktreeGitStatus>;
  }>({ key: "", value: {} });
  // The one place in this file the remembered statuses are read: a tree row
  // falls back to what git last said until its own watch answers, so a cold
  // Projects tab does not grow row by row (`lib/worktreeRowStatuses.ts`).
  const projectRowStatus = (id: string) =>
    rowWorktreeStatus(worktreeStatuses, lastKnownWorktreeStatuses, id);
  const projectStatusKey = (worktrees ?? [])
    .filter((worktree) => visibleProjectWorktreeSet.has(worktree.id))
    .map((worktree) => [worktree.id, projectRowStatus(worktree.id)] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, status]) => `${id}:${JSON.stringify(status ?? null)}`)
    .join("|");
  if (projectStatusCache.current.key !== projectStatusKey) {
    projectStatusCache.current = {
      key: projectStatusKey,
      value: Object.fromEntries(
        (worktrees ?? [])
          .filter((worktree) => visibleProjectWorktreeSet.has(worktree.id))
          .flatMap((worktree) => {
            const status = projectRowStatus(worktree.id);
            return status ? [[worktree.id, status] as const] : [];
          }),
      ),
    };
  }

  // While the Projects or Worktrees browser is visible, subscribe to every
  // listed worktree so dirty-file indicators stay current instead of only
  // updating for the currently open worktree detail page. The Sessions inbox
  // watches only the DISTINCT worktrees its unsettled working-set cards
  // reference. Settled history renders compact rows with no dirty marker and
  // must not turn every reconnect into one forced git scan per old worktree.
  useWorktreeWatches({
    ids: sidebarWorktreeWatchIds(section, sessions, visibleProjectWorktreeIds),
    connected: state.connected,
    actions,
  });

  useEffect(() => {
    if (focusToken === undefined || section !== "sessions") return;
    const container = containerRef.current;
    if (!container) return;
    // Prefer the active row so keyboard users land on what they were viewing.
    const active = container.querySelector<HTMLElement>(
      '[data-session-row][data-session-row-active="true"]',
    );
    const target =
      active ?? container.querySelector<HTMLElement>("[data-session-row]");
    if (target) target.focus({ preventScroll: false });
  }, [focusToken, section]);

  // Sections and actions are one flat, user-ordered row: same slot width, same
  // treatment. Only the handler differs, and only the assistant's label is dynamic.
  const navSlots: Array<PrimaryNavSection<NavSlot>> = prefs.navSlots.map(
    (id) => ({
      id,
      ...PRIMARY_NAV_SLOTS[id],
      ...(id === "assistant" ? { label: assistantLabel } : {}),
    }),
  );

  return (
    // `relative` because on a phone the nav bar is a `BottomCard` positioned in
    // this box rather than a row in this column, and the browser then has to keep
    // its own last rows clear of it.
    <aside
      ref={containerRef}
      className="relative flex h-full w-full shrink-0 flex-col overflow-hidden border-line bg-panel sm:border-r"
    >
      {/* The shared inset every browser reads its first row in — except at the
          TOP for a browser that draws a header bar there. That bar owns the
          panel's top edge: it is sticky, and a sticky box cannot claim an edge
          this container has padded away (Chromium clamps `top-0` to the content
          box, and a negative margin on the bar does not move it). The padding
          would then be an 8px strip above a pinned bar for rows to scroll
          through, and a band the bar's own contents sit low in. */}
      <div
        ref={browserScrollRef}
        className={`min-h-0 flex-1 overflow-y-auto px-1 pb-2 sm:px-2 ${
          section === "sessions" ? "" : "pt-2"
        }`}
        style={mobile ? { paddingBottom: NAV_CARD_INSET } : undefined}
      >
        {section === "settings" ? (
          <SettingsSectionList
            activeSection={activeSection}
            onOpenSection={onOpenSection}
          />
        ) : section === "tasks" ? (
          <BacklogList
            state={state}
            actions={actions}
            prefs={prefs}
            onUpdatePrefs={onUpdatePrefs}
            selectedId={selectedTaskId ?? null}
            onOpenTask={onOpenTask}
            onOpenSession={onOpenSessionForTask}
            onStartSessionForTask={onStartSessionForTask}
            onNavigate={onNavigate}
            hosting={worktreeHosting}
            dirtyWorktrees={dirtyWorktrees}
            workflowIndicators={workflowIndicators}
            // The same two-line row on a phone and on the rail: this aside is
            // never short of HEIGHT, and a single line there spent a narrow
            // column on the id and the project chip
            // (`SIDEBAR_BACKLOG_DENSITY`). App asks the same question of the
            // same predicate (`taskRowsHaveMeta`) before polling or watching
            // for what those rows state.
            density={SIDEBAR_BACKLOG_DENSITY}
            // The filters are a row of chips, so what they are short of is
            // WIDTH: on the rail they wrap into four lines at page sizing and
            // two at the rail's own, above rows that are two-line either way.
            toolbarDensity={mobile ? "comfortable" : "tight"}
          />
        ) : section === "projects" ? (
          <ProjectTreePane
            projects={activeProjects}
            selectedId={selectedProjectId}
            loading={!projectsLoaded}
            reorderState={projectMutations["registry:reorder"]}
            relationsLoading={worktrees === null}
            sessions={projectSessionCache.current.value}
            currentSessionId={currentId}
            worktrees={worktrees}
            worktreeStatuses={projectStatusCache.current.value}
            selectedWorktreeId={selectedWorktreeId}
            onReorder={onReorderProjects}
            onOpenProject={onOpenProject}
            onOpenSession={onSelect}
            onArchiveSession={onArchive}
            onOpenWorktree={onOpenWorktree}
            onStartSession={onStartSessionForProject}
            onStartSessionInWorktree={onStartSessionInWorktree}
            onVisibleWorktreeIdsChange={onVisibleProjectWorktreeIds}
          />
        ) : section === "pull-requests" ? (
          <PullRequestBrowser
            inventory={pullRequestInventory}
            onReload={onReloadPullRequests}
            projects={projects}
            selected={selectedPullRequest}
            onOpen={onOpenPullRequest}
            // The host's call, as everywhere else: a phone screen gets
            // thumb-sized rows, the rail keeps its tight ones.
            density={mobile ? "comfortable" : "tight"}
          />
        ) : section === "knowledge" ? (
          <KnowledgeBrowser
            selectedEntryId={selectedKnowledgeEntryId}
            selectedEntryPath={selectedKnowledgeEntryPath}
            selectedFilePath={selectedKnowledgeFilePath}
            onOpenEntry={onOpenKnowledgeEntry}
            onOpenInvalidEntry={onOpenInvalidKnowledgeEntry}
            onOpenFile={onOpenKnowledgeFile}
            changedAt={knowledgeChangedAt}
          />
        ) : section === "calendar" ? (
          <CalendarBrowser onOpenView={onOpenCalendarView} />
        ) : (
          <SessionInbox
            sessions={sessions}
            archivedSessionCount={archivedSessionCount}
            archivedSessionsLoaded={archivedSessionsLoaded}
            currentId={currentId}
            readCurrentId={readCurrentId}
            projects={projects}
            worktrees={worktrees}
            tasks={state.taskList?.items ?? []}
            workflowRuns={workflowRuns}
            workflowCards={workflowCards}
            worktreeStatuses={worktreeStatuses}
            animateListChanges={prefs.animateListChanges}
            // The host's call, like the Backlog toolbar's: a phone screen gets
            // thumb-sized rows, the rail keeps its tight ones.
            density={mobile ? "comfortable" : "tight"}
            onSelect={onSelect}
            onSettle={onSettleSession}
            onArchive={onArchive}
            onDeleteSession={onDeleteSession}
            onRenameSession={onRenameSession}
            onLoadArchivedSessions={onLoadArchivedSessions}
            onOpenBackgroundTasks={onOpenBackgroundTasks}
            onOpenProject={onOpenProject}
            onOpenTask={onOpenTask}
            onOpenWorkflowRun={onOpenWorkflowRun}
            onSettleWorkflowRun={onSettleWorkflowRun}
            onOpenWorktree={onOpenWorktree}
          />
        )}
      </div>

      <PrimaryNav
        sections={navSlots}
        activeId={section}
        onSelect={(id) =>
          isNavAction(id) ? onNavAction(id) : onSectionChange(id)
        }
        mobile={mobile}
        onCustomizeOrder={
          onOpenSection ? () => onOpenSection("appearance") : undefined
        }
      />
    </aside>
  );
}

export const Sidebar = memo(SidebarImpl);
