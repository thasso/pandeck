import { useMemo, useState } from "react";
import { FolderKanban, Search, X } from "lucide-react";
import type { ProjectRecord } from "@assistant/shared";
import { projectColor, projectDisplayKey } from "../lib/projectDisplay.ts";
import { Popover } from "./Popover.tsx";
import { ProjectBadge } from "./ProjectBadge.tsx";

/**
 * @component ProjectSelector
 * @purpose Compact Project select/clear popover backed by the local Project registry.
 * @useWhen A surface needs to assign or stage one primary Project id while preserving ProjectBadge fallback display for stale/archived ids.
 * @avoidWhen Browsing all Projects as a destination; use the Projects sidebar/detail surfaces instead.
 * @intent Controlled selector: callers own the current id and save/stage behavior. Offers active projects, can include archived projects when explicitly passed, and always lets users clear the selection.
 * @related ProjectBadge, projectDisplay helpers, TaskManagementPage Task project field, Composer standalone Project context picker.
 */
export function ProjectSelector({
  currentId,
  projects,
  projectsById,
  onChange,
  label = "Project",
  emptyLabel = "Add project",
  clearLabel = "Clear project",
  triggerTitle,
  includeCurrentWhenMissing = true,
  placement = "auto",
  className = "rounded-lg px-1.5 py-1 hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
}: {
  currentId: string | null | undefined;
  projects: ProjectRecord[];
  projectsById: Map<string, ProjectRecord>;
  onChange: (projectId: string) => void;
  label?: string | null;
  emptyLabel?: string;
  clearLabel?: string;
  triggerTitle?: string;
  includeCurrentWhenMissing?: boolean;
  placement?: "top" | "bottom" | "auto";
  className?: string;
}) {
  const [filter, setFilter] = useState("");
  const selectedId = currentId?.trim() || null;

  const filtered = useMemo(() => {
    const q = filter.toLowerCase().trim();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        (projectDisplayKey(p)?.toLowerCase().includes(q) ?? false),
    );
  }, [projects, filter]);

  const currentNotInList = Boolean(
    selectedId &&
    includeCurrentWhenMissing &&
    !projects.some((p) => p.id === selectedId),
  );
  const title =
    triggerTitle ?? (selectedId ? "Change project" : "Assign project");

  const triggerContent = selectedId ? (
    <ProjectBadge
      projectId={selectedId}
      projectsById={projectsById}
      size="md"
    />
  ) : (
    <span className="inline-flex items-center gap-1.5 text-sm text-faint hover:text-muted-foreground">
      <FolderKanban size={13} />
      {emptyLabel}
    </span>
  );

  return (
    <div className="flex items-center gap-2">
      {label ? (
        <span className="text-sm font-medium uppercase tracking-wide text-faint">
          {label}
        </span>
      ) : null}
      <div className="flex min-w-0 items-center gap-1">
        <Popover
          button={triggerContent}
          placement={placement}
          className={className}
          title={title}
        >
          {(close) => (
            <div className="flex w-64 flex-col gap-1 p-1">
              <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5">
                <Search size={13} className="shrink-0 text-faint" />
                <input
                  autoFocus
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter projects…"
                  className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-faint"
                />
              </div>
              {currentNotInList && selectedId ? (
                <div className="px-2 py-1">
                  <span className="text-sm text-faint">
                    Current (archived or stale)
                  </span>
                  <div className="mt-1">
                    <ProjectBadge
                      projectId={selectedId}
                      projectsById={projectsById}
                      size="sm"
                    />
                  </div>
                </div>
              ) : null}
              <div className="max-h-52 overflow-y-auto">
                {filtered.length === 0 && !currentNotInList ? (
                  <div className="px-2 py-3 text-center text-sm text-faint">
                    {projects.length === 0
                      ? "No projects in the registry yet."
                      : "No matches."}
                  </div>
                ) : (
                  filtered.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        onChange(p.id);
                        close();
                      }}
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-raised ${selectedId === p.id ? "font-medium text-fg" : "text-muted-foreground"}`}
                    >
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: projectColor(p).dot }}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      {projectDisplayKey(p) ? (
                        <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-xs font-medium tracking-wide text-faint">
                          {projectDisplayKey(p)}
                        </span>
                      ) : null}
                      {selectedId === p.id ? (
                        <span className="shrink-0 text-xs text-faint">
                          current
                        </span>
                      ) : null}
                    </button>
                  ))
                )}
              </div>
              {selectedId ? (
                <button
                  type="button"
                  onClick={() => {
                    onChange("");
                    close();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-faint hover:bg-raised hover:text-danger"
                >
                  <X size={13} />
                  {clearLabel}
                </button>
              ) : null}
            </div>
          )}
        </Popover>
      </div>
    </div>
  );
}
