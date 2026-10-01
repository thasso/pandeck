/**
 * Shared terminal/failure vocabulary for normalized Git hosting check rows.
 * Both provider rollups and agent-facing projections use these predicates so a
 * row cannot be called failed in one payload while its aggregate calls it green.
 */
const TERMINAL_CHECK_STATES = new Set([
  "success",
  "failure",
  "error",
  "warning",
  "neutral",
  "skipped",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
  "completed",
]);

const FAILED_CHECK_STATES = new Set([
  "failure",
  "error",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
]);

function normalized(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

export function isTerminalGitCheckStatus(
  value: string | null | undefined,
): boolean {
  return TERMINAL_CHECK_STATES.has(normalized(value));
}

export function isFailedGitCheckStatus(
  value: string | null | undefined,
): boolean {
  return FAILED_CHECK_STATES.has(normalized(value));
}
