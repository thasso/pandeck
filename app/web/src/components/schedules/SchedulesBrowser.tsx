import { useMemo } from "react";
import { TriangleAlert } from "lucide-react";
import type { ScheduleSummary } from "@assistant/shared/schedules";
import { ListRow } from "../common/ListRow.tsx";
import { EmptyBox, ErrorNote, PaneLoading } from "../common/load.tsx";
import type { RowDensity } from "../../lib/rowDensity.ts";
import { visibleSchedules } from "../../lib/schedules.ts";
import { scheduleNextLabel } from "./SchedulesPage.tsx";

/**
 * @component SchedulesBrowser
 * @purpose The Schedules section's browser: the active Schedules, each with
 *   its next due time and a marker when its last occurrence failed (U2).
 * @useWhen The sidebar's Schedules section.
 * @intent Minimal on purpose: on/off, delete, Pause all and the Done filter
 *   live on the page. The host's scroll container keeps position by row id.
 */
export function SchedulesBrowser({
  schedules,
  answered,
  listError,
  onRetry,
  selectedId,
  density,
  onOpen,
}: {
  schedules: readonly ScheduleSummary[];
  answered: boolean;
  listError: string | null;
  onRetry: () => void;
  selectedId: string | null;
  density: RowDensity;
  onOpen: (id: string) => void;
}) {
  const rows = useMemo(
    () => visibleSchedules(schedules, "active"),
    [schedules],
  );
  return (
    <div className="flex flex-col gap-2">
      {listError ? <ErrorNote message={listError} onRetry={onRetry} /> : null}
      {!answered ? (
        listError ? null : (
          <PaneLoading className="flex-none p-3" />
        )
      ) : rows.length === 0 ? (
        <EmptyBox>
          No Schedules. Agents create them for their sessions.
        </EmptyBox>
      ) : (
        <div className="flex flex-col">
          {rows.map((schedule) => {
            const failed = schedule.lastOccurrence?.state === "failed";
            return (
              <ListRow
                key={schedule.id}
                density={density}
                active={schedule.id === selectedId}
                aria-current={schedule.id === selectedId ? "page" : undefined}
                rowProps={{ "data-list-row-id": schedule.id }}
                onOpen={() => onOpen(schedule.id)}
                leading={
                  failed ? (
                    <TriangleAlert
                      className="size-3.5 text-destructive"
                      aria-hidden
                    />
                  ) : undefined
                }
                title={
                  <span className="truncate">
                    {schedule.name}
                    {failed ? <span className="sr-only"> failed</span> : null}
                  </span>
                }
                trailing={
                  <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                    {scheduleNextLabel(schedule)}
                  </span>
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
