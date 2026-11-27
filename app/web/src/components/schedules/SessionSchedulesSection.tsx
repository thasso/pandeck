import { useEffect, useId, useMemo } from "react";
import { CalendarClock } from "lucide-react";
import type { ScheduleSummary } from "@assistant/shared/schedules";
import { InspectorSection } from "../shell/Inspector.tsx";
import { ListRow } from "../common/ListRow.tsx";
import { ErrorNote } from "../common/load.tsx";
import { Switch } from "../ui/switch.tsx";
import { schedulePath } from "../../hooks/useSessionRouting.ts";
import {
  scheduleMutationKey,
  type ScheduleAttempt,
} from "../../hooks/useAssistant.ts";
import { isPending, type LoadState } from "../../lib/loadState.ts";
import {
  describeScheduleTiming,
  scheduleFailureReason,
  scheduleNextLabel,
} from "../../lib/schedules.ts";
import { openInApp } from "./scheduleLinks.ts";
import { useOnScreen } from "../shell/onScreen.tsx";
import { useScheduleOutcomes } from "./useScheduleOutcomes.ts";

/**
 * @component SessionSchedulesSection
 * @purpose The session inspector's Schedules (AC11): each Schedule targeting
 *   this session, its name linked to the detail, its timing and next
 *   occurrence, and its on/off switch.
 * @useWhen The session inspector, only when the session has Schedules.
 * @intent The switch is the page's own write (`setScheduleEnabled`, keyed
 *   `<id>:enabled`), so its outcome follows the same ownership rule
 *   (`useScheduleOutcomes`): shown here only if this section sent it or
 *   reopened while it was pending, and claimed as this surface's own, so a
 *   page open beside it neither overwrites nor steals the claim. Claims hold
 *   only while the rows are on screen: a shut panel, another tab or a folded
 *   section claims nothing, and its refusal is announced.
 */
export function SessionSchedulesSection({
  sessionId,
  schedules,
  ...rows
}: {
  sessionId: string;
  /** This session's Schedules (`schedulesForSession`), non-empty. */
  schedules: readonly ScheduleSummary[];
  mutations: Record<string, LoadState<true>>;
  attempts: Record<string, ScheduleAttempt>;
  onSetEnabled: (id: string, enabled: boolean) => void;
  onOpen: (path: string) => void;
  /** This surface's rendered, VISIBLE control keys; `[]` when hidden or gone. */
  onClaimControls: (keys: readonly string[]) => void;
}) {
  return (
    <InspectorSection
      id="schedules"
      storageScope={`session:${sessionId}`}
      title="Schedules"
      icon={<CalendarClock size={13} />}
      summary={`${schedules.length}`}
    >
      {/* Inside the collapsible body, so a collapsed section unmounts its
          switches and with them its claims. */}
      <SessionScheduleRows schedules={schedules} {...rows} />
    </InspectorSection>
  );
}

/**
 * The rows and the outcomes they own. The panel and tab around the inspector
 * keep it mounted while hidden, so ownership follows `useOnScreen`, not
 * mounting: hidden, it claims nothing and a refusal is announced.
 */
function SessionScheduleRows({
  schedules,
  mutations,
  attempts,
  onSetEnabled,
  onOpen,
  onClaimControls,
}: {
  schedules: readonly ScheduleSummary[];
  mutations: Record<string, LoadState<true>>;
  attempts: Record<string, ScheduleAttempt>;
  onSetEnabled: (id: string, enabled: boolean) => void;
  onOpen: (path: string) => void;
  onClaimControls: (keys: readonly string[]) => void;
}) {
  const onScreen = useOnScreen();
  const outcomes = useScheduleOutcomes(
    useMemo(
      () => schedules.map((row) => scheduleMutationKey(row.id, "enabled")),
      [schedules],
    ),
    mutations,
    onScreen,
  );
  const { claims, own, errorFor } = outcomes;
  useEffect(() => onClaimControls(claims), [claims, onClaimControls]);
  useEffect(() => () => onClaimControls([]), [onClaimControls]);
  const flip = (id: string, enabled: boolean) => {
    own(scheduleMutationKey(id, "enabled"));
    onSetEnabled(id, enabled);
  };
  return (
    <div className="-mx-3">
      {schedules.map((schedule) => {
        const key = scheduleMutationKey(schedule.id, "enabled");
        const attempt = attempts[key];
        return (
          <SessionScheduleRow
            key={schedule.id}
            schedule={schedule}
            pending={mutations[key] !== undefined && isPending(mutations[key])}
            error={errorFor(key)}
            retryEnabled={
              attempt?.kind === "enabled" ? attempt.enabled : !schedule.enabled
            }
            onSetEnabled={flip}
            onOpen={onOpen}
          />
        );
      })}
    </div>
  );
}

function SessionScheduleRow({
  schedule,
  pending,
  error,
  retryEnabled,
  onSetEnabled,
  onOpen,
}: {
  schedule: ScheduleSummary;
  pending: boolean;
  error: string | undefined;
  /** What the refused write asked for: Try again repeats it. */
  retryEnabled: boolean;
  onSetEnabled: (id: string, enabled: boolean) => void;
  onOpen: (path: string) => void;
}) {
  const nameId = useId();
  const href = schedulePath(schedule.id);
  return (
    <ListRow
      interaction="content"
      rowProps={{ "data-list-row-id": schedule.id }}
    >
      <div className="flex w-full min-w-0 flex-col gap-1 py-1">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <a
            id={nameId}
            href={href}
            onClick={(event) => openInApp(event, href, onOpen)}
            className="min-w-0 flex-1 truncate font-medium hover:underline"
          >
            {schedule.name}
          </a>
          <Switch
            size="sm"
            aria-labelledby={nameId}
            checked={schedule.enabled}
            disabled={pending}
            aria-busy={pending || undefined}
            onCheckedChange={(checked) => onSetEnabled(schedule.id, checked)}
          />
        </div>
        <div className="flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="truncate">
            {describeScheduleTiming(schedule.timing)}
          </span>
          <span className="shrink-0 tabular-nums">
            {scheduleNextLabel(schedule)}
          </span>
        </div>
        {error ? (
          <ErrorNote
            message={`Couldn't save: ${scheduleFailureReason(error)}`}
            onRetry={() => onSetEnabled(schedule.id, retryEnabled)}
            retryLabel="Try again"
          />
        ) : null}
      </div>
    </ListRow>
  );
}
