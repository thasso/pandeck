import { X } from "lucide-react";
import type { ProjectRecord } from "@assistant/shared";
import { projectColor, resolveProjectDisplay } from "../lib/projectDisplay.ts";
import { Badge } from "./ui/badge.tsx";
import { IconButton } from "./common/IconButton.tsx";

/** Compact Project identity, with an optional clear action for editable surfaces. */
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

  return (
    <Badge
      variant={known ? "secondary" : "outline"}
      className={
        size === "md" ? "h-7 gap-1.5 px-2.5" : "max-w-full gap-1 px-1.5"
      }
      style={known ? { backgroundColor: colors.soft } : undefined}
      title={known ? label : `Unknown project: ${projectId}`}
    >
      <span
        className={
          size === "md"
            ? "size-2 shrink-0 rounded-full"
            : "size-1.5 shrink-0 rounded-full"
        }
        style={{ backgroundColor: colors.dot }}
        aria-hidden="true"
      />
      <span className="max-w-full truncate font-medium tracking-wide">
        {size === "sm" ? shortLabel : label}
      </span>
      {onClear ? (
        <IconButton
          type="button"
          size="icon-xs"
          label="Remove project"
          onClick={(event) => {
            event.stopPropagation();
            onClear();
          }}
        >
          <X />
        </IconButton>
      ) : null}
    </Badge>
  );
}
