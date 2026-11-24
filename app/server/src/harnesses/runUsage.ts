/**
 * How a run's engine counts usage, read off the engine its `run.started`
 * marker recorded (`RunEngine`, `session/log/rawEntry.ts`). Imports nothing,
 * so offline readers of a session's log (the session audit) may use it.
 */
/**
 * Whether the run a `run.started` marker opened ran on an engine that reports
 * usage as its RUNNING native total (Claude: its record's total, which a
 * switched-to binding writes over the usage before it) rather than run by run
 * (pi). Undefined when the marker names no engine (an older log).
 */
export function runReportsRunningUsageTotal(marker: {
  engine?: unknown;
}): boolean | undefined {
  const engine = marker.engine;
  if (typeof engine !== "object" || engine === null) return undefined;
  const harness = (engine as { harness?: unknown }).harness;
  if (harness === "claude-sdk") return true;
  if (harness === "pi") return false;
  return undefined;
}
