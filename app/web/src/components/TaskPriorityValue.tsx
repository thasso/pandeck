import {
  SignalHigh,
  SignalLow,
  SignalMedium,
  TriangleAlert,
} from "lucide-react";
import type { TaskPriority } from "@assistant/shared";

const PRIORITY_DISPLAY: Record<
  TaskPriority,
  { Icon: typeof SignalLow; tone: string }
> = {
  low: { Icon: SignalLow, tone: "text-muted-foreground" },
  normal: { Icon: SignalMedium, tone: "text-muted-foreground" },
  high: { Icon: SignalHigh, tone: "text-warning" },
  urgent: { Icon: TriangleAlert, tone: "text-destructive" },
};

/** Shared priority icon and name for inspector choices and Task row badges. */
export function TaskPriorityValue({
  priority,
  compact = false,
}: {
  priority: TaskPriority;
  compact?: boolean;
}) {
  const { Icon, tone } = PRIORITY_DISPLAY[priority];
  return (
    <span
      className={`inline-flex min-w-0 items-center ${compact ? "gap-1" : "gap-2"}`}
    >
      <Icon
        className={`${compact ? "size-3" : "size-4"} shrink-0 ${tone}`}
        aria-hidden
      />
      <span className="capitalize">{priority}</span>
    </span>
  );
}
