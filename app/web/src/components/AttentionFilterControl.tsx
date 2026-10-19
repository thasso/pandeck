import { useMemo } from "react";
import {
  Archive,
  Bell,
  Check,
  Circle,
  CircleHelp,
  FolderTree,
  ListFilter,
  Activity,
} from "lucide-react";
import type {
  ProjectRecord,
  SessionListItem,
  WorkflowRunSummary,
  WorktreeRecord,
} from "@assistant/shared";
import {
  ATTENTION_FILTER_STATUSES,
  attentionFilterCount,
  attentionProjectsBySession,
  DEFAULT_ATTENTION_FILTERS,
  type AttentionFilters,
  type AttentionFilterStatus,
} from "../lib/attentionFilters.ts";
import {
  BacklogProjectFilterPicker,
  buildBacklogProjectFilterOptions,
} from "./BacklogFilters.tsx";
import { ListFilterPopover } from "./common/ListFilterPopover.tsx";
import { PROPERTY_TRIGGER, PropertyLabel } from "./common/PropertyList.tsx";
import { Button } from "./ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";

const STATUS_META = {
  "needs-you": {
    label: "Needs you",
    Icon: CircleHelp,
    title: "Questions, approvals and decisions waiting for you",
  },
  attention: {
    label: "Updates / issues",
    Icon: Bell,
    title: "Unread replies, failures, interruptions or stalled work",
  },
  working: {
    label: "Working",
    Icon: Activity,
    title: "Work currently running",
  },
  active: {
    label: "Idle",
    Icon: Circle,
    title: "Unsettled work that is currently idle",
  },
  settled: { label: "Settled", Icon: Check, title: "Work you have put down" },
  archived: {
    label: "Archived",
    Icon: Archive,
    title: "Archived sessions, loaded when the shelf opens",
  },
} as const;

/** Attention uses the same filter panel and Project picker as Tasks. */
export function AttentionFilterControl({
  filters,
  onChange,
  projects,
  projectsLoaded,
  sessions,
  worktrees,
  workflowRuns,
}: {
  filters: AttentionFilters;
  onChange: (filters: AttentionFilters) => void;
  projects: ProjectRecord[];
  projectsLoaded: boolean;
  sessions: SessionListItem[];
  worktrees: WorktreeRecord[] | null;
  workflowRuns: WorkflowRunSummary[] | null;
}) {
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const options = useMemo(() => {
    const sessionProjects = attentionProjectsBySession(sessions, worktrees);
    const ids = [
      ...sessionProjects.values(),
      ...(workflowRuns ?? []).map((run) => run.projectId),
      null,
    ];
    return buildBacklogProjectFilterOptions(
      ids.map((projectId) => ({ projectId: projectId ?? "" })),
      projects,
      projectsById,
    );
  }, [sessions, worktrees, workflowRuns, projects, projectsById]);
  const active = attentionFilterCount(filters);
  const chosen = ATTENTION_FILTER_STATUSES.filter((status) =>
    filters.statuses.includes(status),
  );
  const filteredStatus =
    chosen.length > 0 && chosen.length < ATTENTION_FILTER_STATUSES.length;
  const selectStatus = (status: AttentionFilterStatus, checked: boolean) =>
    onChange({
      ...filters,
      statuses: checked
        ? [...chosen, status]
        : chosen.filter((item) => item !== status),
    });
  return (
    <ListFilterPopover active={active} label="Attention filters">
      <PropertyLabel>Project</PropertyLabel>
      <BacklogProjectFilterPicker
        filter={filters.project}
        options={options}
        projectsById={projectsById}
        disabled={!projectsLoaded || worktrees === null}
        onChange={(project) => onChange({ ...filters, project })}
        className={`${PROPERTY_TRIGGER} min-w-0 justify-start`}
      />
      <PropertyLabel>Status</PropertyLabel>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              aria-label="Filter by status"
              className={`${PROPERTY_TRIGGER} min-w-0 cursor-pointer justify-start`}
            />
          }
        >
          <ListFilter className="shrink-0 text-muted-foreground" />
          <span
            className={`min-w-0 truncate ${filteredStatus ? "" : "text-muted-foreground"}`}
          >
            {filteredStatus
              ? chosen.map((status) => STATUS_META[status].label).join(", ")
              : "All statuses"}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {ATTENTION_FILTER_STATUSES.map((status) => {
            const { label, Icon, title } = STATUS_META[status];
            return (
              <DropdownMenuCheckboxItem
                key={status}
                checked={chosen.includes(status)}
                closeOnClick={false}
                onCheckedChange={(checked) => selectStatus(status, checked)}
                title={title}
                className="cursor-pointer touch-ui:min-h-11"
              >
                <Icon aria-hidden />
                {label}
              </DropdownMenuCheckboxItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <PropertyLabel>Group</PropertyLabel>
      <Button
        variant="ghost"
        size="sm"
        className={`${PROPERTY_TRIGGER} cursor-pointer justify-start`}
        disabled={!projectsLoaded || worktrees === null}
        aria-pressed={Boolean(filters.byProject)}
        onClick={() => onChange({ ...filters, byProject: !filters.byProject })}
      >
        <FolderTree className="text-muted-foreground" />
        <span className={filters.byProject ? "" : "text-muted-foreground"}>
          {filters.byProject ? "By Project" : "None"}
        </span>
      </Button>
      {active ? (
        <Button
          variant="ghost"
          size="sm"
          className="col-span-2 cursor-pointer justify-start"
          onClick={() =>
            onChange({
              ...DEFAULT_ATTENTION_FILTERS,
              byProject: Boolean(filters.byProject),
            })
          }
        >
          Clear filters
        </Button>
      ) : null}
    </ListFilterPopover>
  );
}
