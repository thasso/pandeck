import {
  SCHEDULE_WEEKDAYS,
  type ScheduleTimingInput,
  type ScheduleWeekday,
} from "@assistant/shared/schedules";
import { Input } from "../ui/input.tsx";
import { Label } from "../ui/label.tsx";
import { NativeSelect, NativeSelectOption } from "../ui/native-select.tsx";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group.tsx";

type Kind = ScheduleTimingInput["kind"];

const KIND_LABEL: Record<Kind, string> = {
  once: "Once",
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Weekly",
  monthly: "Monthly",
};

const DAY_LABEL: Record<ScheduleWeekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

/**
 * The timing as another kind, keeping what carries over: the time always,
 * the repeat window between repeating kinds. A field the new kind needs and
 * the old one lacked starts empty, so Save stays off until it is filled.
 */
function withScheduleKind(
  timing: ScheduleTimingInput,
  kind: Kind,
): ScheduleTimingInput {
  if (kind === timing.kind) return timing;
  const { time } = timing;
  if (kind === "once") return { kind, time, date: "" };
  const window = {
    ...(timing.kind !== "once" && timing.startsOn
      ? { startsOn: timing.startsOn }
      : {}),
    ...(timing.kind !== "once" && timing.endsOn
      ? { endsOn: timing.endsOn }
      : {}),
  };
  if (kind === "weekly") return { kind, time, days: [], ...window };
  if (kind === "monthly") return { kind, time, day: 1, ...window };
  return { kind, time, ...window };
}

/**
 * @component ScheduleTimingFields
 * @purpose Edit a Schedule's timing in its own wall time (`docs/schedules.md`,
 *   Timing): kind, date or days, time, and the repeat window.
 * @useWhen The Schedule detail's Timing section.
 * @intent Controlled and zone-free: the zone is fixed at creation and shown
 *   read-only by the page (R2). The page renders why a changed value cannot
 *   be saved and passes that note's id as `describedBy`, so the group is
 *   announced invalid together with its reason (AC8).
 */
export function ScheduleTimingFields({
  value,
  invalid,
  describedBy,
  onChange,
}: {
  value: ScheduleTimingInput;
  invalid: boolean;
  /** The id of the page's note saying why the value is invalid. */
  describedBy?: string | undefined;
  onChange: (next: ScheduleTimingInput) => void;
}) {
  const field = "flex flex-col gap-1.5";
  return (
    <fieldset
      aria-labelledby="schedule-timing"
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
    >
      <div className={field}>
        <Label htmlFor="schedule-timing-kind">Repeats</Label>
        <NativeSelect
          id="schedule-timing-kind"
          value={value.kind}
          onChange={(event) =>
            onChange(withScheduleKind(value, event.target.value as Kind))
          }
        >
          {(Object.keys(KIND_LABEL) as Kind[]).map((kind) => (
            <NativeSelectOption key={kind} value={kind}>
              {KIND_LABEL[kind]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {value.kind === "once" ? (
        <div className={field}>
          <Label htmlFor="schedule-timing-date">Date</Label>
          <Input
            id="schedule-timing-date"
            type="date"
            value={value.date}
            onChange={(event) =>
              onChange({ ...value, date: event.target.value })
            }
          />
        </div>
      ) : null}
      <div className={field}>
        <Label htmlFor="schedule-timing-time">Time</Label>
        <Input
          id="schedule-timing-time"
          type="time"
          value={value.time}
          onChange={(event) => onChange({ ...value, time: event.target.value })}
        />
      </div>
      {value.kind === "weekly" ? (
        <div className={`${field} sm:col-span-2`}>
          <Label id="schedule-timing-days">Days</Label>
          <ToggleGroup
            aria-labelledby="schedule-timing-days"
            multiple
            size="sm"
            variant="outline"
            value={value.days}
            onValueChange={(next) =>
              onChange({
                ...value,
                days: SCHEDULE_WEEKDAYS.filter((day) =>
                  (next as string[]).includes(day),
                ),
              })
            }
          >
            {SCHEDULE_WEEKDAYS.map((day) => (
              <ToggleGroupItem key={day} value={day}>
                {DAY_LABEL[day]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      ) : null}
      {value.kind === "monthly" ? (
        <div className={field}>
          <Label htmlFor="schedule-timing-day">Day of month</Label>
          <Input
            id="schedule-timing-day"
            type="number"
            min={1}
            max={31}
            step={1}
            value={Number.isFinite(value.day) ? String(value.day) : ""}
            // A cleared field is no day, not day 0: it stays empty and invalid.
            onChange={(event) =>
              onChange({
                ...value,
                day:
                  event.target.value === ""
                    ? Number.NaN
                    : Number(event.target.value),
              })
            }
          />
        </div>
      ) : null}
      {value.kind !== "once" ? (
        <>
          <div className={field}>
            <Label htmlFor="schedule-timing-starts">Starts on</Label>
            <Input
              id="schedule-timing-starts"
              type="date"
              value={value.startsOn ?? ""}
              onChange={(event) => {
                const { startsOn: _drop, ...rest } = value;
                onChange(
                  event.target.value
                    ? { ...rest, startsOn: event.target.value }
                    : rest,
                );
              }}
            />
          </div>
          <div className={field}>
            <Label htmlFor="schedule-timing-ends">Ends on</Label>
            <Input
              id="schedule-timing-ends"
              type="date"
              value={value.endsOn ?? ""}
              onChange={(event) => {
                const { endsOn: _drop, ...rest } = value;
                onChange(
                  event.target.value
                    ? { ...rest, endsOn: event.target.value }
                    : rest,
                );
              }}
            />
          </div>
        </>
      ) : null}
    </fieldset>
  );
}
