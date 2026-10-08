import { useState } from "react";
import { Check, FolderKanban, X } from "lucide-react";
import type { ProjectRecord } from "@assistant/shared";
import {
  projectColor,
  projectDisplayKey,
  resolveProjectDisplay,
} from "../lib/projectDisplay.ts";
import { Button } from "./ui/button.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "./ui/command.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";

/**
 * @component ProjectSelector
 * @purpose Compact Project select/clear picker backed by the local Project registry.
 * @useWhen A surface needs to assign or stage one primary Project id.
 * @avoidWhen Browsing all Projects as a destination; use the Projects surfaces.
 * @intent Controlled selector. Offers active Projects and preserves stale/archived selections for display.
 * @related projectDisplay helpers, TaskManagementPage, Composer
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
  defaultOpen = false,
  className,
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
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const selectedId = currentId?.trim() || null;
  const currentNotInList = Boolean(
    selectedId &&
    includeCurrentWhenMissing &&
    !projects.some((project) => project.id === selectedId),
  );
  const title =
    triggerTitle ?? (selectedId ? "Change project" : "Assign project");

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {label ? (
        <span className="text-sm font-medium text-muted-foreground">
          {label}
        </span>
      ) : null}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className={className}
              title={title}
              aria-label={title}
            />
          }
        >
          {selectedId ? (
            <ProjectValue projectId={selectedId} projectsById={projectsById} />
          ) : (
            <>
              <FolderKanban className="text-muted-foreground" />
              <span className="text-muted-foreground">{emptyLabel}</span>
            </>
          )}
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side={placement === "top" ? "top" : "bottom"}
          className="w-64 p-0"
        >
          <Command>
            <CommandInput placeholder="Filter projects…" />
            <CommandList>
              <CommandEmpty>
                {projects.length === 0
                  ? "No projects in the registry yet."
                  : "No matches."}
              </CommandEmpty>
              {currentNotInList && selectedId ? (
                <CommandGroup heading="Current (archived or stale)">
                  <CommandItem
                    value={`${selectedId} ${projectsById.get(selectedId)?.name ?? ""}`}
                    disabled
                  >
                    <ProjectValue
                      projectId={selectedId}
                      projectsById={projectsById}
                    />
                  </CommandItem>
                </CommandGroup>
              ) : null}
              <CommandGroup>
                {projects.map((project) => (
                  <CommandItem
                    key={project.id}
                    value={`${project.name} ${project.id} ${projectDisplayKey(project) ?? ""}`}
                    onSelect={() => {
                      onChange(project.id);
                      setOpen(false);
                    }}
                  >
                    <FolderKanban
                      style={{ color: projectColor(project).dot }}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {project.name}
                    </span>
                    {projectDisplayKey(project) ? (
                      <span className="font-mono text-xs text-muted-foreground">
                        {projectDisplayKey(project)}
                      </span>
                    ) : null}
                    {selectedId === project.id ? (
                      <Check aria-label="Current" />
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
              {selectedId ? (
                <>
                  <CommandSeparator />
                  <CommandGroup>
                    <CommandItem
                      value={clearLabel}
                      onSelect={() => {
                        onChange("");
                        setOpen(false);
                      }}
                    >
                      <X aria-hidden="true" />
                      {clearLabel}
                    </CommandItem>
                  </CommandGroup>
                </>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * The assigned Project as the task page names it: its icon in its colour, the
 * key, and the full name after it, muted, shortening first.
 */
function ProjectValue({
  projectId,
  projectsById,
}: {
  projectId: string;
  projectsById: Map<string, ProjectRecord>;
}) {
  const project = projectsById.get(projectId);
  const { label, shortLabel, known } = resolveProjectDisplay(
    projectId,
    projectsById,
  );
  return (
    <>
      <FolderKanban
        style={
          known ? { color: projectColor(project ?? projectId).dot } : undefined
        }
        className={known ? undefined : "text-muted-foreground"}
        aria-hidden="true"
      />
      <span className="min-w-0 truncate">
        {shortLabel}
        {known && label !== shortLabel ? (
          <span className="text-muted-foreground"> · {label}</span>
        ) : null}
      </span>
    </>
  );
}
