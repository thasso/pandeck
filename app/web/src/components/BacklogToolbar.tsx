import { CalendarClock, FolderTree, Inbox, ListTree } from "lucide-react";
import type { ProjectRecord, TaskStatus } from "@assistant/shared";
import {
  BacklogProjectFilterControl,
  type BacklogProjectFilterOption,
} from "./BacklogFilters.tsx";
import { BacklogStatusFilter } from "./BacklogStatusFilter.tsx";
import type {
  BacklogDensity,
  BacklogProjectFilter,
  BacklogView,
} from "../lib/backlogTreeModel.ts";
import type { BacklogViewMode } from "../hooks/useBacklog.ts";

/**
 * Shared Backlog controls: the view switcher, the Project filter, status chips,
 * and (in the tree view only) the Normal/By-Project toggle. `density` follows the
 * rows: `tight` renders a slimmer row for the sidebar rail, `comfortable` the
 * roomier one a page (or a phone screen, where these chips are tap targets) gets.
 * `hideProjectControls` drops the project filter and view toggle for surfaces
 * already scoped to one project (the project inspector).
 *
 * It carries NO open/done counts: they were full-Backlog totals that filters
 * did not change (which needed a tooltip to explain), and a number nobody acts
 * on is not worth the row's leading position.
 */
export function BacklogToolbar({
  density,
  view,
  onViewChange,
  viewMode,
  onViewModeChange,
  projectFilter,
  projectFilterOptions,
  projectsById,
  projectsLoaded = true,
  onProjectFilterChange,
  statuses,
  onStatusFilterChange,
  inboxWaiting = false,
  hideProjectControls = false,
}: {
  /** How much room the surface gives a row; see `BacklogDensity`. */
  density: BacklogDensity;
  view: BacklogView;
  onViewChange: (view: BacklogView) => void;
  viewMode: BacklogViewMode;
  onViewModeChange: (mode: BacklogViewMode) => void;
  projectFilter: BacklogProjectFilter;
  projectFilterOptions: BacklogProjectFilterOption[];
  projectsById: Map<string, ProjectRecord>;
  projectsLoaded?: boolean;
  onProjectFilterChange: (filter: BacklogProjectFilter) => void;
  statuses: Set<TaskStatus>;
  onStatusFilterChange: (next: TaskStatus[]) => void;
  /** Anything waiting in the Inbox — drives that chip's attention dot. */
  inboxWaiting?: boolean;
  hideProjectControls?: boolean;
}) {
  const tight = density === "tight";
  const byProject = viewMode === "project";

  return (
    <div
      className={`flex flex-wrap items-center gap-x-2 gap-y-1.5 px-1 ${tight ? "text-micro" : "text-caption"} text-muted`}
    >
      {!hideProjectControls && (
        <BacklogViewSwitcher
          view={view}
          onChange={onViewChange}
          tight={tight}
          inboxWaiting={inboxWaiting}
        />
      )}
      {!hideProjectControls && (
        <BacklogProjectFilterControl
          filter={projectFilter}
          options={projectFilterOptions}
          projectsById={projectsById}
          onChange={onProjectFilterChange}
          compact={tight}
          disabled={!projectsLoaded}
        />
      )}
      {/* A status control appears only where it does something. Focus filters
          done out unconditionally so it offers the other two; the Inbox ignores
          status entirely (its own rules cover it), and rendering dead chips
          there would silently rewrite the filter the NEXT view honours. */}
      {view !== "inbox" && (
        <BacklogStatusFilter
          statuses={statuses}
          onChange={onStatusFilterChange}
          compact={tight}
          options={view === "focus" ? FOCUS_STATUS_OPTIONS : undefined}
        />
      )}
      {!hideProjectControls && view === "backlog" && (
        <button
          type="button"
          onClick={() => onViewModeChange(byProject ? "normal" : "project")}
          disabled={!projectsLoaded}
          aria-pressed={byProject}
          title={
            byProject ? "Switch to the flat list" : "Group tasks by Project"
          }
          className={`ml-auto inline-flex items-center gap-1.5 rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${tight ? "px-1.5 py-0.5 text-micro" : "px-2 py-1 text-caption"} ${byProject ? "border-accent/60 bg-accent-soft text-fg" : "border-line bg-panel text-faint hover:bg-raised hover:text-muted"}`}
        >
          <FolderTree
            size={tight ? 11 : 12}
            className={byProject ? "text-accent" : ""}
          />
          {tight ? "Project" : "By Project"}
        </button>
      )}
    </div>
  );
}

/** Focus never shows a done Task, so it never offers that chip. Exported so the
 *  list filters through exactly the options the toolbar renders. */
export const FOCUS_STATUS_OPTIONS: readonly TaskStatus[] = ["todo", "doing"];

const VIEW_META: Record<
  BacklogView,
  { label: string; Icon: typeof ListTree; title: string }
> = {
  backlog: {
    label: "Backlog",
    Icon: ListTree,
    title: "The full Backlog: your hierarchy, in the order you arranged it",
  },
  focus: {
    label: "Focus",
    Icon: CalendarClock,
    title: "What to work on: grouped by when it is due, sorted by priority",
  },
  inbox: {
    label: "Inbox",
    Icon: Inbox,
    title: "Tasks that arrived on their own and still need a decision",
  },
};

/**
 * Which Backlog view is on screen, as one segmented control in the slot the
 * open/done counts used to hold.
 *
 * It is a switcher rather than a sort dropdown because the two views differ in
 * more than order: the Backlog is hand-arranged and drag-editable, and Focus
 * sorts itself. A control that only said "sort by…" would promise that dragging
 * still means something in both.
 */
function BacklogViewSwitcher({
  view,
  onChange,
  tight,
  inboxWaiting,
}: {
  view: BacklogView;
  onChange: (view: BacklogView) => void;
  tight: boolean;
  inboxWaiting: boolean;
}) {
  return (
    <div
      className="inline-flex items-center gap-1"
      role="group"
      aria-label="Backlog view"
    >
      {(Object.keys(VIEW_META) as BacklogView[]).map((id) => {
        const meta = VIEW_META[id];
        const active = view === id;
        const Icon = meta.Icon;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            aria-pressed={active}
            title={meta.title}
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${tight ? "px-1.5 py-0.5 text-micro" : "px-2 py-1 text-caption"} ${active ? "border-accent/60 bg-accent-soft text-fg" : "border-line bg-panel text-faint hover:bg-raised hover:text-muted"}`}
          >
            <Icon
              size={tight ? 11 : 12}
              className={active ? "text-accent" : ""}
            />
            {meta.label}
            {/* A DOT, not a count: what matters is whether anything is waiting,
                and the counts this toolbar used to lead with were exactly the
                numbers nobody acted on. */}
            {id === "inbox" && inboxWaiting ? (
              <span
                className="size-1.5 shrink-0 rounded-full bg-accent"
                aria-label="Tasks waiting"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
