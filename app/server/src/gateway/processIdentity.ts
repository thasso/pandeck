/**
 * A process's identity beyond its pid, which the kernel reuses: its start
 * time, field 22 of `/proc/<pid>/stat` in clock ticks since boot. The server
 * names itself with it in `control.hello`; later slices compare it to tell an
 * exited process from a reused pid.
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
