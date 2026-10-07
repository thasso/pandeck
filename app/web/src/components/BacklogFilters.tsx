import { FolderKanban, X } from "lucide-react";
import type { ProjectRecord } from "@assistant/shared";
import { IconButton } from "./common/IconButton.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "./ui/select.tsx";
import { resolveProjectDisplay } from "../lib/projectDisplay.ts";
import type { Task } from "../lib/backlogTree.ts";
import {
  ALL_PROJECT_FILTER,
  projectIdForFilter,
  type BacklogProjectFilter,
} from "../lib/backlogTreeModel.ts";

export type BacklogProjectFilterOption =
  | { kind: "project"; projectId: string; label: string; known: boolean }
  | { kind: "unassigned"; label: string };

/** Build the Project-filter popover options from the Backlog + registry. */
export function buildBacklogProjectFilterOptions(
  items: Task[],
  projects: ProjectRecord[],
  projectsById: Map<string, ProjectRecord>,
): BacklogProjectFilterOption[] {
  const seenProjectIds = new Set<string>();
  let hasUnassigned = false;
  for (const item of items) {
    const projectId = projectIdForFilter(item);
    if (projectId) seenProjectIds.add(projectId);
    else hasUnassigned = true;
  }

  const options: BacklogProjectFilterOption[] = projects.map((project) => ({
    kind: "project",
    projectId: project.id,
    label: project.name,
    known: true,
  }));
  const offeredIds = new Set(projects.map((project) => project.id));
  for (const projectId of seenProjectIds) {
    if (offeredIds.has(projectId)) continue;
    const display = resolveProjectDisplay(projectId, projectsById);
    options.push({
      kind: "project",
      projectId,
      label: display.known
        ? display.label
        : `Unknown project: ${display.label || projectId}`,
      known: display.known,
    });
  }

  options.sort((a, b) => {
    if (a.kind !== "project" || b.kind !== "project")
      return a.kind === "project" ? -1 : 1;
    const byKnown = Number(b.known) - Number(a.known);
    if (byKnown !== 0) return byKnown;
    return (
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) ||
      a.projectId.localeCompare(b.projectId)
    );
  });
  if (hasUnassigned || items.length === 0)
    options.push({ kind: "unassigned", label: "Unassigned" });
  return options;
}

function filterLabel(
  filter: BacklogProjectFilter,
  projectsById: Map<string, ProjectRecord>,
): string {
  if (filter.kind === "all") return "All";
  if (filter.kind === "unassigned") return "Unassigned";
  return (
    resolveProjectDisplay(filter.projectId, projectsById).label ||
    filter.projectId
  );
}

/**
 * Project-filter popover for the Backlog. `compact` renders a slimmer trigger
 * (icon + short label) for the sidebar; the popover menu is identical.
 */
export function BacklogProjectFilterControl({
  filter,
  options,
  projectsById,
  onChange,
  compact = false,
  disabled = false,
}: {
  filter: BacklogProjectFilter;
  options: BacklogProjectFilterOption[];
  projectsById: Map<string, ProjectRecord>;
  onChange: (filter: BacklogProjectFilter) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const active = !disabled && filter.kind !== "all";
  const value =
    filter.kind === "project" ? `project:${filter.projectId}` : filter.kind;
  const label = disabled ? "…" : filterLabel(filter, projectsById);
  const handleChange = (next: string | null) => {
    if (next === "all") onChange(ALL_PROJECT_FILTER);
    else if (next === "unassigned") onChange({ kind: "unassigned" });
    else if (next?.startsWith("project:"))
      onChange({ kind: "project", projectId: next.slice(8) });
  };
  return (
    <div className="inline-flex items-center gap-1">
      <Select value={value} onValueChange={handleChange} disabled={disabled}>
        <SelectTrigger
          size={compact ? "sm" : "default"}
          aria-label="Filter Backlog by Project"
        >
          <FolderKanban />
          <span className="max-w-36 truncate">
            {compact ? label : `Project: ${label}`}
          </span>
        </SelectTrigger>
        <SelectContent align="start">
          <SelectItem value="all">All projects</SelectItem>
          {options.map((option) => (
            <SelectItem
              key={
                option.kind === "unassigned" ? "unassigned" : option.projectId
              }
              value={
                option.kind === "unassigned"
                  ? "unassigned"
                  : `project:${option.projectId}`
              }
            >
              {option.label}
              {option.kind === "project" && !option.known ? " (stale)" : ""}
            </SelectItem>
          ))}
          {options.length === 0 ? (
            <SelectItem value="empty" disabled>
              No Projects in the registry or Backlog yet.
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
      {active ? (
        <IconButton
          label="Clear Project filter"
          size="icon-xs"
          onClick={() => onChange(ALL_PROJECT_FILTER)}
        >
          <X />
        </IconButton>
      ) : null}
    </div>
  );
}
