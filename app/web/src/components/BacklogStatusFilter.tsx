import { CheckCircle2, Circle, CircleDot, ListFilter } from "lucide-react";
import type { TaskStatus } from "@assistant/shared";
import { ALL_STATUSES } from "../lib/backlogTreeModel.ts";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";
import { Button } from "./ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { TaskStatusIcon } from "./TaskStatusIcon.tsx";

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
      multiple
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

/**
 * The status filter as a property value, like the Project filter beside it: a
 * quiet trigger naming what is shown ("All statuses", or the chosen ones), and
 * a menu of checkable statuses that stays open while you pick. Empty or every
 * option checked means no filter.
 */
export function BacklogStatusFilterPicker({
  statuses,
  onChange,
  options = ALL_STATUSES,
  className,
}: {
  statuses: Set<TaskStatus>;
  onChange: (next: TaskStatus[]) => void;
  options?: readonly TaskStatus[] | undefined;
  className?: string | undefined;
}) {
  const chosen = options.filter((status) => statuses.has(status));
  const filtered = chosen.length > 0 && chosen.length < options.length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label="Filter by status"
            className={className}
          />
        }
      >
        {filtered ? (
          <>
            <span className="flex shrink-0 items-center gap-0.5">
              {chosen.map((status) => (
                <TaskStatusIcon key={status} status={status} size={14} />
              ))}
            </span>
            <span className="min-w-0 truncate">
              {chosen.map((status) => META[status].label).join(", ")}
            </span>
          </>
        ) : (
          <>
            <ListFilter className="text-muted-foreground" />
            <span className="text-muted-foreground">All statuses</span>
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {options.map((status) => (
          <DropdownMenuCheckboxItem
            key={status}
            checked={statuses.has(status)}
            closeOnClick={false}
            onCheckedChange={(checked) =>
              onChange(
                checked
                  ? [...chosen, status]
                  : chosen.filter((item) => item !== status),
              )
            }
          >
            <TaskStatusIcon status={status} size={14} />
            {META[status].label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
