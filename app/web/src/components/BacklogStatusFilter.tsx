import { CheckCircle2, Circle, CircleDot } from "lucide-react";
import type { TaskStatus } from "@assistant/shared";
import { ALL_STATUSES } from "../lib/backlogTreeModel.ts";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";

const META: Record<TaskStatus, { label: string; Icon: typeof Circle }> = {
  todo: { label: "To do", Icon: Circle },
  doing: { label: "In progress", Icon: CircleDot },
  done: { label: "Done", Icon: CheckCircle2 },
};

/** Multi-select status filter; empty or all-selected means no filter. */
export function BacklogStatusFilter({
  statuses,
  onChange,
  compact = false,
  options = ALL_STATUSES,
}: {
  statuses: Set<TaskStatus>;
  onChange: (next: TaskStatus[]) => void;
  compact?: boolean;
  options?: readonly TaskStatus[] | undefined;
}) {
  return (
    <ToggleGroup
      value={[...statuses]}
      onValueChange={(values) => onChange(values as TaskStatus[])}
      variant="outline"
      size={compact ? "sm" : "default"}
      aria-label="Filter by status"
    >
      {options.map((status) => {
        const { label, Icon } = META[status];
        return (
          <ToggleGroupItem key={status} value={status} aria-label={label}>
            <Icon />
            {compact ? null : label}
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}
