import {
  CalendarClock,
  ChevronDown,
  FolderTree,
  Inbox,
  ListTree,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "./ui/button.tsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import type { ProjectRecord, TaskStatus } from "@assistant/shared";
import {
  BacklogProjectFilterControl,
  BacklogProjectFilterPicker,
  type BacklogProjectFilterOption,
} from "./BacklogFilters.tsx";
import { PROPERTY_TRIGGER, PropertyLabel } from "./TaskPlanningSection.tsx";
import { BacklogStatusFilter } from "./BacklogStatusFilter.tsx";
import {
  statusFilterActive,
  type BacklogDensity,
  type BacklogProjectFilter,
  type BacklogView,
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
  bar = false,
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
  /**
   * Drawn as a header bar above the host's scroll container rather than a row
   * inside it: hairline under, its own inset — as the Sessions bar.
   */
  bar?: boolean;
}) {
  const tight = density === "tight";
  const byProject = viewMode === "project";

  // The sidebar's header bar is ONE short line: the view as a dropdown on the
  // left, every filter behind one button on the right. The chips it replaces
  // wrapped onto two to four lines in the rail.
  if (bar && !hideProjectControls)
    return (
      <div className="flex h-10 items-center gap-1 border-b border-border bg-card px-1.5 sm:px-2">
        <BacklogViewMenu
          view={view}
          onChange={onViewChange}
          inboxWaiting={inboxWaiting}
        />
        <BacklogFilterPopover
          view={view}
          byProject={byProject}
          onViewModeChange={onViewModeChange}
          projectFilter={projectFilter}
          projectFilterOptions={projectFilterOptions}
          projectsById={projectsById}
          projectsLoaded={projectsLoaded}
          onProjectFilterChange={onProjectFilterChange}
          statuses={statuses}
          onStatusFilterChange={onStatusFilterChange}
        />
      </div>
    );

  return (
    <div
      className={`flex flex-wrap items-center gap-x-2 gap-y-1.5 ${bar ? "border-b border-border bg-card px-2 py-2 sm:px-3" : "px-1"} ${tight ? "text-xs" : "text-sm"} text-muted-foreground`}
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

/**
 * The view as a quiet dropdown: its icon and name on the bar, the three views
 * in the menu. Inbox's waiting dot rides on the trigger too, so work arriving
 * is visible from the other two views.
 */
function BacklogViewMenu({
  view,
  onChange,
  inboxWaiting,
}: {
  view: BacklogView;
  onChange: (view: BacklogView) => void;
  inboxWaiting: boolean;
}) {
  const meta = VIEW_META[view];
  const Icon = meta.Icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="min-w-0 gap-1.5 font-medium"
            aria-label={`Backlog view: ${meta.label}`}
          />
        }
      >
        <Icon className="text-muted-foreground" />
        <span className="truncate">{meta.label}</span>
        {inboxWaiting && view !== "inbox" ? (
          <span
            className="size-1.5 shrink-0 rounded-full bg-primary"
            aria-label="Tasks waiting in the Inbox"
          />
        ) : null}
        <ChevronDown className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuRadioGroup
          value={view}
          onValueChange={(value) => onChange(value as BacklogView)}
        >
          {(Object.keys(VIEW_META) as BacklogView[]).map((id) => {
            const item = VIEW_META[id];
            const ItemIcon = item.Icon;
            return (
              <DropdownMenuRadioItem
                key={id}
                value={id}
                className="items-start"
              >
                <ItemIcon className="mt-0.5" />
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-1.5">
                    {item.label}
                    {id === "inbox" && inboxWaiting ? (
                      <span
                        className="size-1.5 rounded-full bg-primary"
                        aria-label="Tasks waiting"
                      />
                    ) : null}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {item.title}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Every filter behind one button, its badge counting the active ones so a
 * filtered list never passes for the whole Backlog. Shows only what the view
 * honours: Inbox ignores status, and only the Backlog groups by Project.
 */
function BacklogFilterPopover({
  view,
  byProject,
  onViewModeChange,
  projectFilter,
  projectFilterOptions,
  projectsById,
  projectsLoaded,
  onProjectFilterChange,
  statuses,
  onStatusFilterChange,
}: {
  view: BacklogView;
  byProject: boolean;
  onViewModeChange: (mode: BacklogViewMode) => void;
  projectFilter: BacklogProjectFilter;
  projectFilterOptions: BacklogProjectFilterOption[];
  projectsById: Map<string, ProjectRecord>;
  projectsLoaded: boolean;
  onProjectFilterChange: (filter: BacklogProjectFilter) => void;
  statuses: Set<TaskStatus>;
  onStatusFilterChange: (next: TaskStatus[]) => void;
}) {
  const active =
    (projectFilter.kind !== "all" ? 1 : 0) +
    (view !== "inbox" && statusFilterActive(statuses) ? 1 : 0);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto gap-1 text-muted-foreground"
            aria-label={
              active ? `Filters (${active} active)` : "Filters and grouping"
            }
          />
        }
      >
        <SlidersHorizontal />
        {active ? (
          <span className="min-w-4 rounded-full bg-primary px-1 text-xs leading-4 font-medium text-primary-foreground tabular-nums">
            {active}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        {/* The inspector's property list: muted labels, quiet values. */}
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-y-1">
          <PropertyLabel>Project</PropertyLabel>
          <BacklogProjectFilterPicker
            filter={projectFilter}
            options={projectFilterOptions}
            projectsById={projectsById}
            onChange={onProjectFilterChange}
            disabled={!projectsLoaded}
            className={`${PROPERTY_TRIGGER} min-w-0 justify-start`}
          />
          {view !== "inbox" ? (
            <>
              <PropertyLabel>Status</PropertyLabel>
              <div className="px-1">
                <BacklogStatusFilter
                  statuses={statuses}
                  onChange={onStatusFilterChange}
                  options={view === "focus" ? FOCUS_STATUS_OPTIONS : undefined}
                />
              </div>
            </>
          ) : null}
          {view === "backlog" ? (
            <>
              <PropertyLabel>Group</PropertyLabel>
              <Button
                variant="ghost"
                size="sm"
                className={`${PROPERTY_TRIGGER} justify-start`}
                onClick={() =>
                  onViewModeChange(byProject ? "normal" : "project")
                }
                disabled={!projectsLoaded}
                aria-pressed={byProject}
              >
                <FolderTree className="text-muted-foreground" />
                <span className={byProject ? "" : "text-muted-foreground"}>
                  {byProject ? "By Project" : "None"}
                </span>
              </Button>
            </>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
