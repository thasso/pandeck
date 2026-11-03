/**
 * A process's identity beyond its pid, which the kernel reuses: its start
 * time, field 22 of `/proc/<pid>/stat` in clock ticks since boot. The server
 * names itself with it in `control.hello`, and a login hold names its owner
 * and writer with it, so `processState` can tell an exited process from a
 * reused pid.
 */
import { readFileSync } from "node:fs";

/** The kernel's start time for `pid` as a decimal string, or null where `/proc` cannot be read. */
export function processStartTime(pid: number): string | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  return parseStartTime(stat);
}

/** Field 22 of a `/proc/<pid>/stat` line, or null when it is malformed. */
export function parseStartTime(stat: string): string | null {
  // `comm` (field 2) is parenthesized and may contain spaces or parentheses,
  // so the fields are counted from the LAST `)`: field 3 comes right after.
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat.slice(close + 2).split(" ");
  const field = fields[22 - 3]?.trim();
  return field !== undefined && /^\d+$/.test(field) ? field : null;
}

/** Whether `value` is a process id: a positive safe integer. */
export function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Whether `value` is a start time as {@link processStartTime} reads it, or null. */
export function isStartTime(value: unknown): value is string | null {
  return (
    value === null || (typeof value === "string" && /^\d{1,20}$/.test(value))
  );
}

/** How {@link processState} observes a process; tests inject one. */
export interface ProcessProbe {
  /** `process.kill(pid, 0)`: delivers nothing, throws `ESRCH` once it is gone. */
  kill(pid: number, signal: 0): void;
  startTime(pid: number): string | null;
}

const SYSTEM_PROBE: ProcessProbe = {
  kill: (pid, signal) => process.kill(pid, signal),
  startTime: processStartTime,
};

/**
 * Whether the process `pid` that started at `startTime` has exited. Only
 * evidence counts: `ESRCH`, or a readable current start time that differs
 * from a recorded one. Anything uncertain is `running`: `EPERM` or another
 * error, an unreadable current start time, a null recorded one, a zombie.
 */
export function processState(
  pid: number,
  startTime: string | null,
  probe: ProcessProbe = SYSTEM_PROBE,
): "running" | "exited" {
  try {
    probe.kill(pid, 0);
  } catch (err) {
    return (err as { code?: unknown } | null)?.code === "ESRCH"
      ? "exited"
      : "running";
  }
  if (startTime === null) return "running";
  const current = probe.startTime(pid);
  return current !== null && current !== startTime ? "exited" : "running";
}
