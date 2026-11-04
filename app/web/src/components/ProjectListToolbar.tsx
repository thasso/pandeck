import { memo, useMemo } from "react";
import type { ProjectRecord } from "@assistant/shared";
import {
  Activity,
  Archive,
  ArrowDownAZ,
  ChevronDown,
  Clock,
  FolderTree,
  GitBranch,
  type LucideIcon,
} from "lucide-react";
import {
  PROJECT_GROUP_BYS,
  projectFilterCount,
  type ProjectGroupBy,
  type ProjectListView,
  type ProjectWorktreeFilter,
} from "../lib/projectListView.ts";
import { Button } from "./ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { PROPERTY_TRIGGER, PropertyLabel } from "./common/PropertyList.tsx";
import { ListFilterPopover } from "./common/ListFilterPopover.tsx";
import { ListToolbar } from "./common/ListToolbar.tsx";
import {
  BacklogProjectFilterPicker,
  type BacklogProjectFilterOption,
} from "./BacklogFilters.tsx";
import { ALL_PROJECT_FILTER } from "../lib/backlogTreeModel.ts";

const GROUP_BY_META: Record<
  ProjectGroupBy,
  { label: string; Icon: LucideIcon; title: string }
> = {
  hierarchy: {
    label: "Hierarchy",
    Icon: FolderTree,
    title: "The projects as you arranged them; drag to reorder",
  },
  activity: {
    label: "By activity",
    Icon: Activity,
    title: "Running, or touched in the last day, first",
  },
  recent: {
    label: "Recent",
    Icon: Clock,
    title: "Latest session or git activity first",
  },
  name: {
    label: "A–Z",
    Icon: ArrowDownAZ,
    title: "Every project by name",
  },
};

const WORKTREE_FILTER_LABEL: Record<ProjectWorktreeFilter, string> = {
  all: "All worktrees",
  changes: "With changes",
  "pull-requests": "With pull requests",
};

/**
 * @component ProjectListToolbar
 * @purpose The Projects browser's header bar, in the Tasks and Pull Requests
 * bars' shape: the grouping as a quiet dropdown on the left, every filter
 * behind one button on the right whose badge counts the active ones.
 * @useWhen Above the Projects section's scroll container (`Sidebar.tsx`), for
 * the tree `ProjectTreePane` draws with the same view.
 */
export const ProjectListToolbar = memo(function ProjectListToolbar({
  view,
  projects,
  onChange,
}: {
  view: ProjectListView;
  projects: readonly ProjectRecord[];
  onChange: (patch: Partial<ProjectListView>) => void;
}) {
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const projectOptions = useMemo<BacklogProjectFilterOption[]>(
    () =>
      projects
        .map((project) => ({
          kind: "project" as const,
          projectId: project.id,
          label: project.name,
          known: true,
        }))
        .sort((a, b) =>
          a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
        ),
    [projects],
  );
  const meta = GROUP_BY_META[view.groupBy];
  const Icon = meta.Icon;
  return (
    <ListToolbar
      filter={
        <ListFilterPopover active={projectFilterCount(view)} label="Filters">
          <PropertyLabel>Project</PropertyLabel>
          <BacklogProjectFilterPicker
            filter={
              view.projectId === null
                ? ALL_PROJECT_FILTER
                : { kind: "project", projectId: view.projectId }
            }
            options={projectOptions}
            projectsById={projectsById}
            onChange={(filter) =>
              onChange({
                projectId: filter.kind === "project" ? filter.projectId : null,
              })
            }
            className={`${PROPERTY_TRIGGER} min-w-0 justify-start`}
          />

          <PropertyLabel>Archived</PropertyLabel>
          <Button
            variant="ghost"
            size="sm"
            className={`${PROPERTY_TRIGGER} justify-start`}
            aria-pressed={view.showArchived}
            onClick={() => onChange({ showArchived: !view.showArchived })}
          >
            <Archive className="text-muted-foreground" />
            <span className={view.showArchived ? "" : "text-muted-foreground"}>
              {view.showArchived ? "Shown" : "Hidden"}
            </span>
          </Button>

          <PropertyLabel>Worktrees</PropertyLabel>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Filter worktrees"
                  className={`${PROPERTY_TRIGGER} min-w-0 justify-start`}
                />
              }
            >
              <GitBranch className="text-muted-foreground" />
              <span
                className={`min-w-0 truncate ${view.worktrees === "all" ? "text-muted-foreground" : ""}`}
              >
                {WORKTREE_FILTER_LABEL[view.worktrees]}
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuRadioGroup
                value={view.worktrees}
                onValueChange={(next) =>
                  onChange({ worktrees: next as ProjectWorktreeFilter })
                }
              >
                {(
                  Object.keys(WORKTREE_FILTER_LABEL) as ProjectWorktreeFilter[]
                ).map((id) => (
                  <DropdownMenuRadioItem key={id} value={id}>
                    {WORKTREE_FILTER_LABEL[id]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </ListFilterPopover>
      }
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="min-w-0 gap-1.5 font-medium"
              aria-label={`Group projects: ${meta.label}`}
            />
          }
        >
          <Icon className="text-muted-foreground" />
          <span className="truncate">{meta.label}</span>
          <ChevronDown className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {PROJECT_GROUP_BYS.map((id) => {
            const item = GROUP_BY_META[id];
            const ItemIcon = item.Icon;
            return (
              <DropdownMenuItem
                key={id}
                aria-current={id === view.groupBy || undefined}
                className="items-start"
                onClick={() => onChange({ groupBy: id })}
              >
                <ItemIcon className="mt-0.5" />
                <span className="flex min-w-0 flex-col">
                  <span className={id === view.groupBy ? "font-medium" : ""}>
                    {item.label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {item.title}
                  </span>
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </ListToolbar>
  );
});
