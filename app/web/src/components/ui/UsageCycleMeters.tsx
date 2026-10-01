import {
  formatUsageReset,
  usageIndicatorState,
  usageLevel,
  usageWindowPct,
  type UsageIndicator,
  type UsageIndicatorState,
  type UsageIndicatorWindow,
} from "@assistant/shared/usage";
import { Skeleton } from "./load.tsx";

/**
 * @component UsageCycleMeters
 * @purpose The fixed-height subscription-usage slot on a provider card: two
 * generic cycle rows — short (`5h`) and long (`wk`) — each a micro meter with
 * the exact number and the time left in the cycle right-aligned. Every provider
 * adapter maps its own windows into those two slots (or one, or none), so cards
 * stay comparable.
 * @useWhen A surface names one credential profile and has room for two lines
 * of secondary detail (the new-session provider cards).
 * @avoidWhen Anywhere the detail matters — per-model caps, credits and spend
 * controls belong to the Usage page, which reads the same server cache.
 * @intent Fill is USED, never remaining, and length + colour + the printed
 * number are redundant channels so the meaning survives without colour. The
 * slot keeps its height in every state (loading, stale, no plan limits), so a
 * card never reflows when numbers arrive. Nothing here depends on hover.
 */
export function UsageCycleMeters({
  indicator,
  now,
}: {
  /** Undefined while the account's first snapshot has not arrived. */
  indicator: UsageIndicator | undefined;
  /** Render clock, so staleness and window rollover advance without a push. */
  now: number;
}) {
  const state: UsageIndicatorState = indicator
    ? usageIndicatorState(indicator, now)
    : "unknown";
  // No indicator at all means the topic snapshot has not landed yet — that IS
  // pending, so it shimmers; once the server speaks, its own `refreshing` says
  // whether anything is actually being fetched.
  const pending = indicator ? indicator.refreshing : true;
  // A capability answer does not age: an API-key Claude account still has no
  // plan limits an hour later, so this line outranks staleness.
  const capability =
    indicator && !indicator.limitsAvailable
      ? indicator.provider === "claude"
        ? "no plan limits"
        : "sign in"
      : null;

  return (
    // `text-micro` sits here, not on the cells: the column widths below are in
    // `em`, so they scale with the user's text size instead of clipping.
    <span className="flex w-full flex-col gap-0.5 text-micro tabular-nums">
      <UsageCycleRow
        label="5h"
        title="Rolling 5-hour window"
        window={indicator?.short}
        state={state}
        refreshing={pending}
        now={now}
        reset="time"
        missingReason={capability ?? "no 5h limit"}
        hollow={capability !== null}
      />
      <UsageCycleRow
        label="wk"
        title="Weekly window"
        window={indicator?.long}
        state={state}
        refreshing={pending}
        now={now}
        reset="weekday"
        missingReason={capability ?? "no weekly limit"}
        hollow={capability !== null}
        // The account-level reason is printed once, on the first row; this row
        // still carries it in its title rather than saying "not reported".
        reasonInTitleOnly={capability !== null}
      />
    </span>
  );
}

/**
 * The row's fixed column widths, in `em` of the micro role. Every row of every
 * card uses exactly these, so meters start and end on the same x across the
 * whole provider strip and nothing moves when a state changes: the reading
 * column holds `⟳100%` and the reset column the widest countdown
 * `formatUsageReset` can produce (`9d 23h`). The reason cell spans both plus
 * the gap between them, which is why these are one shared constant.
 */
const COL = {
  label: "w-[1.5em]",
  reading: "w-[3.4em]",
  reset: "w-[4.2em]",
  reason: "w-[8.1em]",
  gap: "gap-x-[0.5em]",
};

function UsageCycleRow({
  label,
  title,
  window,
  state,
  refreshing,
  now,
  reset,
  missingReason,
  hollow,
  reasonInTitleOnly = false,
}: {
  label: string;
  title: string;
  window: UsageIndicatorWindow | null | undefined;
  state: UsageIndicatorState;
  /** A fetch for this account is in flight right now (server-pushed). */
  refreshing: boolean;
  now: number;
  /** The short cycle resets within the day, the long one on a weekday. */
  reset: "time" | "weekday";
  /** What the value slot says when there is no number: always a reason, never blank guessing. */
  missingReason: string;
  /** Draw the track without a fill — the account has no such limit to report. */
  hollow: boolean;
  /** Keep the reason out of the visible slot (already stated on the row above). */
  reasonInTitleOnly?: boolean;
}) {
  // `hollow` outranks any cached number: an account the provider says has no
  // plan limits must not render one it reported earlier.
  const pct =
    hollow || state === "unknown" ? null : usageWindowPct(window, now);
  // Three mutually exclusive readings, in this order: a stated reason there is
  // no meter, nothing known yet (the only one that shimmers), or a number.
  // Order matters — without a trustworthy snapshot an absent window means "not
  // fetched yet", NOT "this account has no such limit".
  const kind = hollow
    ? "reason"
    : state === "unknown"
      ? "unknown"
      : window === null
        ? "reason"
        : pct === null
          ? "unknown"
          : "meter";
  const stale = state === "stale" && kind === "meter";
  const reading =
    kind === "meter"
      ? `${Math.round(pct as number)}%`
      : kind === "reason"
        ? missingReason
        : "—";
  const resetLabel =
    kind === "meter" ? formatUsageReset(window?.resetsAt ?? null, now) : "";
  // The countdown is the estimate; the tooltip still names the wall clock the
  // cycle turns over on, which is what a user planning around it wants.
  const clock = resetLabel
    ? formatResetClock(window?.resetsAt ?? null, reset)
    : "";

  return (
    <span
      className={`flex w-full min-w-0 items-center ${COL.gap}`}
      title={`${title}: ${reading}${
        resetLabel
          ? ` · resets in ${resetLabel}${clock ? ` (${clock})` : ""}`
          : ""
      }`}
    >
      {/* Fixed label column so the rows line up across cards. */}
      <span className={`${COL.label} shrink-0 text-faint`}>{label}</span>
      <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-line">
        {kind === "meter" ? (
          <span
            className={`block h-full rounded-full ${meterFill(pct as number)} ${stale ? "opacity-50" : ""}`}
            style={{ width: `${pct as number}%` }}
          />
        ) : kind === "unknown" && refreshing ? (
          // The shimmer asserts "a fetch is running right now". Without it a
          // flat track + `—` says the honest other thing: nothing is known and
          // nothing is being done about it (an account in failure backoff).
          // A `span`: the row is phrasing content inside the card's button.
          <Skeleton as="span" className="block h-full w-full rounded-full" />
        ) : null}
      </span>
      {kind === "reason" ? (
        // One cell as wide as the reading and reset columns together: a reason
        // is prose, and splitting it across the number columns would either
        // truncate it or push the meter around.
        <span
          className={`${COL.reason} shrink-0 truncate text-right text-muted`}
        >
          {reasonInTitleOnly ? "" : reading}
        </span>
      ) : (
        <>
          <span className={`${COL.reading} shrink-0 text-right text-muted`}>
            {stale ? <span className="text-faint">⟳</span> : null}
            {reading}
          </span>
          {/* Reserved even when empty: a row without a countdown must not let
              the meter grow into the space the row beside it uses. */}
          <span className={`${COL.reset} shrink-0 text-right text-faint`}>
            {resetLabel}
          </span>
        </>
      )}
    </span>
  );
}

/** Green under 70, amber to 90, red above — the thresholds the Usage page uses. */
function meterFill(pct: number): string {
  const level = usageLevel(pct);
  if (level === "critical") return "bg-danger";
  if (level === "warn") return "bg-warning";
  return "bg-accent";
}

/** `14:00` for the short cycle, `Mon 00:00` for the long one — tooltip only. */
function formatResetClock(
  resetsAt: string | null,
  kind: "time" | "weekday",
): string {
  if (!resetsAt) return "";
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return "";
  const time = at.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return kind === "time"
    ? time
    : `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
}
