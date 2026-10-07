import { useState } from "react";
import { Check, FolderKanban } from "lucide-react";
import type { ProjectRecord } from "@assistant/shared";
import { projectColor, projectDisplayKey } from "../lib/projectDisplay.ts";
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
import { ProjectBadge } from "./ProjectBadge.tsx";

/**
 * @component ProjectSelector
 * @purpose Compact Project select/clear picker backed by the local Project registry.
 * @useWhen A surface needs to assign or stage one primary Project id.
 * @avoidWhen Browsing all Projects as a destination; use the Projects surfaces.
 * @intent Controlled selector. Offers active Projects and preserves stale/archived selections for display.
 * @related ProjectBadge, projectDisplay helpers, TaskManagementPage, Composer
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
    <div className="flex min-w-0 items-center gap-2">
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
            <ProjectBadge
              projectId={selectedId}
              projectsById={projectsById}
              size="md"
            />
          ) : (
            <>
              <FolderKanban />
              {emptyLabel}
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
                    <ProjectBadge
                      projectId={selectedId}
                      projectsById={projectsById}
                      size="sm"
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
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: projectColor(project).dot }}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {project.name}
                    </span>
                    {projectDisplayKey(project) ? (
                      <span className="text-xs text-muted-foreground">
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
