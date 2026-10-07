import { X } from "lucide-react";
import type { ProjectRecord } from "@assistant/shared";
import { projectColor, resolveProjectDisplay } from "../lib/projectDisplay.ts";
import { DASHED_EDGE } from "./common/load.tsx";

/**
 * @component ProjectBadge
 * @purpose Compact chip showing a Project's short key (falling back to the resolved name/raw id) with a Project color dot. Optional clear button for editable surfaces like Task detail.
 * @useWhen Any surface that needs to display a Task's (or future Session's) project link: Backlog list rows, sidebar Backlog rows, Task detail metadata, and future Project-context Session headers.
 * @avoidWhen Rendering a full project selector; use the ProjectSelector (Popover-based) in TaskDetailPanel for that.
 * @intent Color uses the registry record's explicit color when present, otherwise a deterministic project.id fallback. Unknown/stale ids render with muted styling. Size "sm" is for compact rows; "md" is for detail headers. Non-interactive by default; pass onClear to show a dismiss button.
 * @related lib/projectDisplay.ts, TaskManagementPage.tsx (ProjectSelector)
 */
export function ProjectBadge({
  projectId,
  projectsById,
  size = "sm",
  onClear,
}: {
  projectId: string;
  projectsById: Map<string, ProjectRecord>;
  size?: "sm" | "md";
  onClear?: () => void;
}) {
  const project = projectsById.get(projectId);
  const { label, shortLabel, known } = resolveProjectDisplay(
    projectId,
    projectsById,
  );
  const colors = projectColor(project ?? projectId);

  if (size === "sm") {
    return (
      <span
        className={`inline-flex min-w-0 shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-xs ${known ? "text-muted-foreground" : `border ${DASHED_EDGE} border-line text-faint`}`}
        style={known ? { backgroundColor: colors.soft } : undefined}
        title={known ? label : `Unknown project: ${projectId}`}
      >
        <span
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: colors.dot }}
          aria-hidden
        />
        <span className="max-w-[4rem] truncate font-medium tracking-wide">
          {shortLabel}
        </span>
        {onClear ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            className="ml-0.5 shrink-0 rounded-full p-px text-faint hover:text-danger focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
            title="Remove project"
            aria-label="Remove project"
          >
            <X size={9} />
          </button>
        ) : null}
      </span>
    );
  }

  // md
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-sm ${known ? "text-muted-foreground" : `border ${DASHED_EDGE} border-line text-faint`}`}
      style={known ? { backgroundColor: colors.soft } : undefined}
      title={known ? label : `Unknown project: ${projectId}`}
    >
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: colors.dot }}
        aria-hidden
      />
      <span className="min-w-0 truncate font-medium tracking-wide">
        {shortLabel}
      </span>
      {onClear ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          className="ml-0.5 shrink-0 rounded-full p-0.5 text-faint hover:text-danger focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
          title="Remove project"
          aria-label="Remove project"
        >
          <X size={11} />
        </button>
      ) : null}
    </span>
  );
}
