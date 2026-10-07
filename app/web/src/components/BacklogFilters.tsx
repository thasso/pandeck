import { FolderKanban, X } from "lucide-react";
import type { ProjectRecord } from "@assistant/shared";
import { Popover } from "./Popover.tsx";
import { projectColor, resolveProjectDisplay } from "../lib/projectDisplay.ts";
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
  const label = disabled ? "…" : filterLabel(filter, projectsById);
  return (
    <div className="inline-flex items-center gap-1">
      <Popover
        button={
          <span
            className={`inline-flex items-center gap-1 ${active ? "text-fg" : "text-muted-foreground"}`}
          >
            <FolderKanban size={compact ? 11 : 12} />
            <span className="max-w-[9rem] truncate">
              {compact ? label : `Project: ${label}`}
            </span>
          </span>
        }
        placement="auto"
        disabled={disabled}
        className={`rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${compact ? "px-1.5 py-0.5 text-xs" : "px-2 py-1 text-sm"} ${active ? "border-primary/60 bg-accent" : "border-line bg-panel hover:bg-raised hover:text-fg"}`}
        title="Filter Backlog by Project"
      >
        {(close) => (
          <div className="flex w-64 flex-col gap-1 p-1">
            <button
              type="button"
              onClick={() => {
                onChange(ALL_PROJECT_FILTER);
                close();
              }}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-raised ${filter.kind === "all" ? "font-medium text-fg" : "text-muted-foreground"}`}
              aria-pressed={filter.kind === "all"}
            >
              <span
                className="size-2 shrink-0 rounded-full bg-line-strong"
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">All projects</span>
              {filter.kind === "all" ? (
                <span className="text-xs text-faint">current</span>
              ) : null}
            </button>
            <div className="max-h-64 overflow-y-auto">
              {options.length === 0 ? (
                <div className="px-2 py-3 text-center text-sm text-faint">
                  No Projects in the registry or Backlog yet.
                </div>
              ) : (
                options.map((option) => {
                  const selected =
                    option.kind === "unassigned"
                      ? filter.kind === "unassigned"
                      : filter.kind === "project" &&
                        filter.projectId === option.projectId;
                  return (
                    <button
                      key={
                        option.kind === "unassigned"
                          ? "unassigned"
                          : option.projectId
                      }
                      type="button"
                      onClick={() => {
                        onChange(
                          option.kind === "unassigned"
                            ? { kind: "unassigned" }
                            : { kind: "project", projectId: option.projectId },
                        );
                        close();
                      }}
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-raised ${selected ? "font-medium text-fg" : "text-muted-foreground"}`}
                      aria-pressed={selected}
                    >
                      {option.kind === "project" ? (
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{
                            backgroundColor: projectColor(
                              projectsById.get(option.projectId) ??
                                option.projectId,
                            ).dot,
                          }}
                          aria-hidden
                        />
                      ) : (
                        <span
                          className="size-2 shrink-0 rounded-full bg-line-strong"
                          aria-hidden
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {option.label}
                      </span>
                      {option.kind === "project" && !option.known ? (
                        <span className="shrink-0 text-xs text-faint">
                          stale
                        </span>
                      ) : null}
                      {selected ? (
                        <span className="shrink-0 text-xs text-faint">
                          current
                        </span>
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}
      </Popover>
      {active ? (
        <button
          type="button"
          onClick={() => onChange(ALL_PROJECT_FILTER)}
          className="rounded-md p-1 text-faint hover:bg-panel hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          title="Clear Project filter"
          aria-label="Clear Project filter"
        >
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}
