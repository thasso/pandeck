import { CalendarClock, FolderTree, Inbox, ListTree } from "lucide-react";
import { Button } from "./ui/button.tsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";
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
      className={`flex flex-wrap items-center gap-x-2 gap-y-1.5 px-1 ${tight ? "text-xs" : "text-sm"} text-muted-foreground`}
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
        <Button
          variant={byProject ? "secondary" : "outline"}
          size={tight ? "xs" : "sm"}
          className="ml-auto"
          onClick={() => onViewModeChange(byProject ? "normal" : "project")}
          disabled={!projectsLoaded}
          aria-pressed={byProject}
          title={
            byProject ? "Switch to the flat list" : "Group tasks by Project"
          }
        >
          <FolderTree />
          {tight ? "Project" : "By Project"}
        </Button>
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
    <ToggleGroup
      value={[view]}
      onValueChange={(values) => {
        const next = values[0] as BacklogView | undefined;
        if (next) onChange(next);
      }}
      variant="outline"
      size={tight ? "sm" : "default"}
      aria-label="Backlog view"
    >
      {(Object.keys(VIEW_META) as BacklogView[]).map((id) => {
        const meta = VIEW_META[id];
        const Icon = meta.Icon;
        return (
          <ToggleGroupItem key={id} value={id} title={meta.title}>
            <Icon />
            {meta.label}
            {id === "inbox" && inboxWaiting ? (
              <span
                className="size-1.5 shrink-0 rounded-full bg-primary"
                aria-label="Tasks waiting"
              />
            ) : null}
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}
